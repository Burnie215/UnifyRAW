import type { AutoResult } from './AutoOptimizer';
import type { RawPixelData } from './raw/RawDecoderStrategy';
import type { RawCacheIdentity } from './raw/cacheKey';

export interface AutoOptimizeQueueItem {
  name: string;
  mimeType?: string | null;
}

interface DurationSample {
  totalMs: number;
  count: number;
}

const RAW_EXTENSIONS = new Set([
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf', 'raf',
  'rw2', 'rwl', 'pef', 'ptx', 'srw', 'x3f', 'erf', 'mef', 'mos', 'mrw',
  'kdc', 'dcr', 'raw', '3fr', 'fff', 'iiq', 'rwz',
]);
const HEIF_EXTENSIONS = new Set(['heic', 'heif', 'hif']);

/** Group duration samples by the actual extension (RAF, JPG, HIF, …). */
export function autoOptimizeFileType(item: AutoOptimizeQueueItem): string {
  const dot = item.name.lastIndexOf('.');
  if (dot >= 0 && dot < item.name.length - 1) return item.name.slice(dot + 1).toLowerCase();
  const mimeSubtype = item.mimeType?.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  return mimeSubtype || 'unknown';
}

function initialDurationMs(type: string): number {
  if (RAW_EXTENSIONS.has(type)) return 6_000;
  if (HEIF_EXTENSIONS.has(type)) return 2_500;
  return 900;
}

/** Running means are kept separately per extension. Remaining work therefore
 * uses RAF timings for RAFs and JPG timings for JPGs instead of one misleading
 * global average. */
export class AutoOptimizeEtaEstimator {
  private readonly samples = new Map<string, DurationSample>();

  record(type: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const sample = this.samples.get(type) ?? { totalMs: 0, count: 0 };
    sample.totalMs += durationMs;
    sample.count++;
    this.samples.set(type, sample);
  }

  meanFor(type: string): number | null {
    const sample = this.samples.get(type);
    return sample?.count ? sample.totalMs / sample.count : null;
  }

  estimateRemaining(types: readonly string[]): number {
    return Math.round(types.reduce(
      (sum, type) => sum + (this.meanFor(type) ?? initialDurationMs(type)),
      0,
    ));
  }
}

/** Process one representative of every extension first. This gives the ETA a
 * useful mean for every file type early while retaining stable order otherwise. */
export function orderForEtaCalibration<T extends AutoOptimizeQueueItem>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const representatives: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    const type = autoOptimizeFileType(item);
    if (seen.has(type)) rest.push(item);
    else {
      seen.add(type);
      representatives.push(item);
    }
  }
  return [...representatives, ...rest];
}

export function formatAutoOptimizeEta(milliseconds: number, language: 'de' | 'en' = 'de'): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
  const units = language === 'en'
    ? { second: 'sec', minute: 'min', hour: 'hr' }
    : { second: 'Sek.', minute: 'Min.', hour: 'Std.' };
  if (seconds < 60) return `${seconds} ${units.second}`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder
    ? `${minutes} ${units.minute} ${remainder} ${units.second}`
    : `${minutes} ${units.minute}`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder
    ? `${hours} ${units.hour} ${minuteRemainder} ${units.minute}`
    : `${hours} ${units.hour}`;
}

export interface AutoOptimizeAnalysisOptions {
  sourceType?: string | null;
  /** Photo identity for the RAW ladder; ignored for non-RAW files. */
  rawIdentity: RawCacheIdentity;
}

export interface AutoOptimizeAnalysis {
  result: AutoResult;
  /** Small decoded preview used for SDR edit thumbnails. */
  previewBlob: Blob;
  /** Real linear RAW pixels, reused by the RAW thumbnail renderer. */
  rawPixels?: RawPixelData;
  rawDecodeSource?: string;
}

/** Analysis resolution — matches AutoOptimizeButton so batch and single-photo
 *  runs measure the same statistics. */
const ANALYSIS_MAX_DIM = 400;

async function analyzePixels(pixels: Uint8ClampedArray, isRaw: boolean): Promise<AutoResult> {
  const [{ histogramFromPixels }, { autoOptimize }] = await Promise.all([
    import('../image/histogram'),
    import('./AutoOptimizer'),
  ]);
  return autoOptimize(histogramFromPixels(pixels), pixels, { isRaw });
}

async function analyzePreview(preview: Blob, isRaw: boolean): Promise<AutoResult> {
  const bitmap = await createImageBitmap(preview);
  try {
    const scale = Math.min(ANALYSIS_MAX_DIM / bitmap.width, ANALYSIS_MAX_DIM / bitmap.height, 1);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is not available');
    context.drawImage(bitmap, 0, 0, width, height);
    return analyzePixels(context.getImageData(0, 0, width, height).data, isRaw);
  } finally {
    bitmap.close();
  }
}

/** Same rule as the editor button: with 16-bit RAW pixels in hand, analyse
 *  their neutral render, because the preview JPEG skips the as-shot white
 *  balance the pipeline applies. Falls back to the preview otherwise. */
async function analyzeRawDecode(
  rawPixels: RawPixelData | undefined, preview: Blob,
): Promise<AutoResult> {
  if (rawPixels) {
    const { neutralRawRender } = await import('./raw/neutralRender');
    const rendered = neutralRawRender(rawPixels, ANALYSIS_MAX_DIM);
    if (rendered) return analyzePixels(rendered.pixels, true);
  }
  return analyzePreview(preview, true);
}

/** Decode through the same source-aware path as the editor. RAW files are
 * analyzed from the actual decoded preview, never from the embedded camera
 * JPEG unless the configured decoder itself has to fall back after an error. */
export async function analyzeFileForAutoOptimize(
  file: File,
  options: AutoOptimizeAnalysisOptions,
): Promise<AutoOptimizeAnalysis> {
  const [{ generateThumbnailBlob }, { RawDecoder }] = await Promise.all([
    import('./thumbnail/generateThumbnailBlob'),
    import('./RawDecoder'),
  ]);

  const isRaw = RawDecoder.isRawFile(file.name);
  if (isRaw) {
    const { loadRawPixels, getSmartPreviewSize } = await import('./raw');
    // The preview is the analysis input for RAWs without pixels (8-bit
    // fallback), so this caller keeps it.
    const decoded = await loadRawPixels({
      identity: options.rawIdentity,
      size: getSmartPreviewSize(),
      sourceType: options.sourceType,
      file,
    });
    if (!decoded) throw new Error(`RAW decode failed for ${file.name}`);

    try {
      const response = await fetch(decoded.displayUrl);
      if (!response.ok) throw new Error(`Could not read decoded RAW preview (${response.status})`);
      const previewBlob = await response.blob();
      return {
        result: await analyzeRawDecode(decoded.rawPixels, previewBlob),
        previewBlob,
        rawPixels: decoded.rawPixels,
        rawDecodeSource: decoded.source,
      };
    } finally {
      if (decoded.displayUrl.startsWith('blob:')) URL.revokeObjectURL(decoded.displayUrl);
    }
  }

  const preview = await generateThumbnailBlob(file, 400, 0.82);
  return {
    result: await analyzePreview(preview, false),
    previewBlob: preview,
  };
}
