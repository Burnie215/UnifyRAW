import type { ExportOptions } from '../engine/Exporter';
import type { TiffCompression } from '../engine/TiffEncoder';
import type { SourceExportCapabilities } from '../sources/types';

export type ExportFormat = ExportOptions['format'];
export type ExportBitDepth = NonNullable<ExportOptions['bitDepth']>;
/** One entry of `SourceExportCapabilities.allowedFormats`. */
export type SourceFormat = SourceExportCapabilities['allowedFormats'][number];
export type ExportDestination = 'download' | 'source';

/** Every format the dialog can offer, in the order it shows them. */
export const EXPORT_FORMATS: readonly ExportFormat[] = ['jpeg', 'png', 'webp', 'tiff', 'dng'];

/**
 * The formats that carry more than 8 bits per channel. This is the encoder
 * reality, not a preference: `Exporter` routes 16 bit to PNG16, TIFF16 or the
 * linear DNG and nowhere else.
 */
export const DEPTH16_FORMATS: readonly ExportFormat[] = ['png', 'tiff', 'dng'];

/**
 * Formats that exist ONLY at 16 bit, so the 8-bit list has to subtract them.
 * DNG is half-float by construction - the spec allows Deflate for floating
 * point data and forbids it for 16-bit integers, and `encodeDng` has no
 * 8-bit encoding at all. Offering the button at 8 bit would promise a file
 * `exportPhoto` refuses to write.
 */
export const DEPTH16_ONLY_FORMATS: readonly ExportFormat[] = ['dng'];

/** How a UI format lands in a write-back target. WebP has no counterpart. */
const SOURCE_FORMAT_OF: Record<ExportFormat, SourceFormat | null> = {
  jpeg: 'jpg',
  png: 'png',
  webp: null,
  tiff: 'tif',
  dng: 'dng',
};

/**
 * What a target accepts when nobody said. Reproduces the old hard-coded
 * "anything but WebP" so a source without declared capabilities keeps working.
 */
const DEFAULT_SOURCE_FORMATS: readonly SourceFormat[] = ['jpg', 'tif', 'png'];

/**
 * Which format a silent correction falls back to. JPEG first keeps today's
 * WebP-to-source behaviour; at 16 bit only the two real 16-bit containers are
 * candidates, TIFF ahead of PNG because it also offers uncompressed.
 *
 * DNG is in neither list on purpose. A correction happens without a word, and
 * landing silently on a linear negative that most viewers cannot open is not
 * the kind of surprise a silent correction may hand out - it has to be asked
 * for. `correctFormat` still falls back to whatever is offered if DNG is the
 * only thing left, which can only happen when a target accepts nothing else.
 */
const FALLBACK_ORDER: readonly ExportFormat[] = ['jpeg', 'tiff', 'png', 'webp'];
const FALLBACK_ORDER_16: readonly ExportFormat[] = ['tiff', 'png'];

/**
 * Where one particular format goes when it falls out of the list, ahead of the
 * general order. Only DNG needs an entry, and only because it is the first
 * format that the DEPTH switch can remove: everything else disappears because
 * a write-back target refused it. Dropping a lossless linear negative onto a
 * lossy JPEG - which is where `FALLBACK_ORDER` starts - is a cliff nobody
 * asked for; TIFF is the same container one depth down.
 */
const PREFERRED_REPLACEMENT: Partial<Record<ExportFormat, ExportFormat>> = { dng: 'tiff' };

/**
 * Why 16 bit cannot be chosen. The dialog turns this into a sentence via i18n;
 * a locked switch that says nothing sends people looking for a missing
 * control.
 */
export type DepthLockReason =
  /** Every original an export would render is an 8-bit file. */
  | 'source8bit'
  /** The write-back target accepts no format that can hold 16 bit. */
  | 'destination';

export interface DepthChoice {
  depth: ExportBitDepth;
  /** A locked depth stays visible and carries `reason`. */
  enabled: boolean;
  reason?: DepthLockReason;
}

export interface ExportChoiceRequest {
  destination: ExportDestination;
  /** What the user last clicked, not necessarily what is possible. */
  format: ExportFormat;
  bitDepth: ExportBitDepth;
  /** True when every original an export would render carries more than 8 bit. */
  sourceCanExport16Bit: boolean;
  /**
   * Formats the write-back target accepts. Read only for destination
   * `source`; there it is authoritative over everything below.
   */
  allowedSourceFormats?: readonly SourceFormat[];
}

export interface ExportChoicePlan {
  /** The format buttons to show, in `EXPORT_FORMATS` order. */
  formats: ExportFormat[];
  /** The format an export would really use - `format` corrected in silence. */
  format: ExportFormat;
  /** Both depths, always both, one of them possibly locked with a reason. */
  depths: DepthChoice[];
  /** The depth an export would really write. */
  bitDepth: ExportBitDepth;
  /** TIFF and DNG carry a compression choice; PNG is always deflate. */
  showCompression: boolean;
  /** Lossy formats only. */
  showQuality: boolean;
}

function formatsForDestination(request: ExportChoiceRequest): ExportFormat[] {
  if (request.destination !== 'source') return [...EXPORT_FORMATS];
  const allowed = request.allowedSourceFormats ?? DEFAULT_SOURCE_FORMATS;
  return EXPORT_FORMATS.filter((format) => {
    const asSource = SOURCE_FORMAT_OF[format];
    return asSource !== null && allowed.includes(asSource);
  });
}

function correctFormat(
  wanted: ExportFormat, offered: readonly ExportFormat[], depth: ExportBitDepth,
): ExportFormat {
  if (offered.includes(wanted)) return wanted;
  const preferred = PREFERRED_REPLACEMENT[wanted];
  if (preferred && offered.includes(preferred)) return preferred;
  const order = depth === 16 ? FALLBACK_ORDER_16 : FALLBACK_ORDER;
  return order.find((format) => offered.includes(format)) ?? offered[0] ?? wanted;
}

/**
 * The one decision about what an export dialog may offer: which formats, which
 * depths, and - when 16 bit is locked - why.
 *
 * Three constraints meet here and the narrowest wins. The write-back target's
 * `allowedFormats` decides which formats exist at all, the source's measured
 * depth decides whether 16 bit is honest, and the chosen depth decides which
 * of the remaining formats can carry it. A format that falls out of the list
 * is corrected without a word, the way WebP has always been corrected when the
 * destination is a source; a depth that falls out is not, because the switch
 * stays on screen and has to explain itself.
 */
export function planExportChoices(request: ExportChoiceRequest): ExportChoicePlan {
  const available = formatsForDestination(request);
  const deep = available.filter((format) => DEPTH16_FORMATS.includes(format));

  const lock: DepthLockReason | undefined = !request.sourceCanExport16Bit
    ? 'source8bit'
    : deep.length === 0 ? 'destination' : undefined;

  const bitDepth: ExportBitDepth = lock === undefined && request.bitDepth === 16 ? 16 : 8;
  const formats = bitDepth === 16
    ? deep
    : available.filter((format) => !DEPTH16_ONLY_FORMATS.includes(format));
  const format = correctFormat(request.format, formats, bitDepth);

  return {
    formats,
    format,
    depths: [
      { depth: 8, enabled: true },
      { depth: 16, enabled: lock === undefined, ...(lock ? { reason: lock } : {}) },
    ],
    bitDepth,
    // DNG is a TIFF, and `DngCompression` is the same pair of choices. An
    // uncompressed DNG is not a curiosity either: readers whose libraw is
    // built without zlib open only that one.
    showCompression: format === 'tiff' || format === 'dng',
    showQuality: format === 'jpeg' || format === 'webp',
  };
}

export interface ExportPixelSize {
  width: number | null;
  height: number | null;
}

export interface SizeEstimateRequest {
  /** The originals an export would render. Entries without a size are skipped. */
  targets: readonly ExportPixelSize[];
  format: ExportFormat;
  bitDepth: ExportBitDepth;
  tiffCompression: TiffCompression;
  /** 10..100, only read for the lossy formats. */
  quality: number;
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * Bytes per pixel of a photographic JPEG at a given quality, sampled at five
 * points and interpolated between them. Rough on purpose: the dialog says
 * "about", and the alternative is encoding the picture to find out.
 */
const JPEG_BYTES_PER_PIXEL: ReadonlyArray<readonly [quality: number, bpp: number]> = [
  [10, 0.03], [50, 0.13], [75, 0.25], [92, 0.5], [100, 1.1],
];

/** WebP buys roughly a quarter over JPEG at the same quality setting. */
const WEBP_FACTOR = 0.75;

/**
 * What Deflate leaves of raw pixels. The plan measured 30 to 65 percent saved
 * on 16-bit data depending on sensor noise in the low bits; the noisy case is
 * the realistic one for a render, so the estimate stays on the pessimistic
 * side. 8-bit photographic data has no low-bit slack left and compresses far
 * worse.
 */
const DEFLATE_FACTOR: Record<ExportBitDepth, number> = { 8: 0.85, 16: 0.7 };

/** Header, IFD and ICC profile. Constant next to any real image. */
const CONTAINER_OVERHEAD = 4096;

function lossyBytesPerPixel(quality: number): number {
  const clamped = Math.min(100, Math.max(10, quality));
  for (let i = 1; i < JPEG_BYTES_PER_PIXEL.length; i++) {
    const [upperQuality, upperBpp] = JPEG_BYTES_PER_PIXEL[i];
    if (clamped > upperQuality) continue;
    const [lowerQuality, lowerBpp] = JPEG_BYTES_PER_PIXEL[i - 1];
    const span = upperQuality - lowerQuality;
    const t = span === 0 ? 0 : (clamped - lowerQuality) / span;
    return lowerBpp + (upperBpp - lowerBpp) * t;
  }
  return JPEG_BYTES_PER_PIXEL[JPEG_BYTES_PER_PIXEL.length - 1][1];
}

/** Shrink-to-fit, never enlarge - the same rule `Exporter.fitWithin` applies. */
function fitWithin(
  width: number, height: number, maxWidth?: number, maxHeight?: number,
): { width: number; height: number } {
  if (!maxWidth && !maxHeight) return { width, height };
  const scale = Math.min((maxWidth ?? Infinity) / width, (maxHeight ?? Infinity) / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function bytesForOne(pixels: number, request: SizeEstimateRequest): number {
  if (request.format === 'jpeg' || request.format === 'webp') {
    const factor = request.format === 'webp' ? WEBP_FACTOR : 1;
    return Math.round(pixels * lossyBytesPerPixel(request.quality) * factor) + CONTAINER_OVERHEAD;
  }
  const raw = pixels * 3 * (request.bitDepth / 8);
  // PNG has no uncompressed mode - the switch the dialog hides for it is not
  // just invisible, it does not exist in the format. DNG does have the switch
  // and reads the same field, so it needs no case of its own.
  const compressed = request.format === 'png' || request.tiffCompression === 'deflate'
    ? raw * DEFLATE_FACTOR[request.bitDepth]
    : raw;
  return Math.round(compressed) + CONTAINER_OVERHEAD;
}

/**
 * A size the dialog can put next to a switch. Unlike the grid's formatter this
 * one carries GB: a 45-MP batch at 16 bit leaves the MB range immediately.
 */
export function formatEstimatedBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Roughly what this export will weigh, before anything is rendered.
 *
 * `null` when not one target has known dimensions: an honest blank beats a
 * number made up from nothing. Targets that do have a size carry the estimate
 * for the whole batch - a partially indexed selection is under-reported rather
 * than guessed at.
 */
export function estimateExportBytes(request: SizeEstimateRequest): number | null {
  let total = 0;
  let known = 0;
  for (const target of request.targets) {
    const { width, height } = target;
    if (!width || !height || width <= 0 || height <= 0) continue;
    known++;
    const fitted = fitWithin(width, height, request.maxWidth, request.maxHeight);
    total += bytesForOne(fitted.width * fitted.height, request);
  }
  return known === 0 ? null : total;
}
