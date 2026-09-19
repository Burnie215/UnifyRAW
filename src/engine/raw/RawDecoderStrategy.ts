import { hasBackend } from '../../platform/config';
import { STORAGE_KEYS } from '../../platform/storageKeys';

export type RawDecodeMode = 'smart-preview' | 'libraw-wasm' | 'embedded-jpeg';

export interface RawPixelData {
  /** Pixel data, RGB(A) interleaved row-major. */
  data: Uint16Array | Uint8Array;
  width: number;
  height: number;
  channels: 3 | 4;
  bits: 8 | 16;
  /** Precision carried by the original file before decoding widened samples
   *  into this buffer. HEIF uses this to distinguish 8-, 10- and 12-bit
   *  sources while `bits` remains the 16-bit editor-buffer precision. */
  sourceBits?: number;
  /** Optional 3×3 Camera-RGB → linear-sRGB matrix. Productive decoders return
   *  null because they already emit sRGB; retained for synthetic/future
   *  camera-space sources. */
  colorMatrix?: number[] | null;
  /** Optional WB-applying gains [R, G, B], never DNG AsShotNeutral values.
   *  Productive decoders return null because camera WB is already baked;
   *  retained for synthetic/future unbalanced camera-space sources. */
  asShotNeutral?: [number, number, number] | null;
}

export interface RawDecodeResult {
  /** 8-bit JPEG/PNG URL for `<img>` preview + non-WebGL fallback. */
  displayUrl: string;
  width: number;
  height: number;
  bits: 8 | 16;
  source: RawDecodeMode;
  /** Optional 16-bit raw pixel data. When present and WebGL supports 16-bit
   *  rendering (`webglCaps.rgba16fRender`), the pipeline uses these directly
   *  for full RAW editing precision. */
  rawPixels?: RawPixelData;
}

/** A load that reached the editor with less depth than the source could give.
 *  `raw-embedded-jpeg` means the RAW development failed and the camera's own
 *  JPEG is being edited; the two 8-bit cases mean real data arrived, but only
 *  8 bits of it. Distinct values because they are distinct facts to a
 *  photographer. */
export type DepthFallback = 'raw-embedded-jpeg' | 'raw-8bit' | 'heif-8bit';

/** What the editor ACTUALLY got, as opposed to what the source could deliver.
 *  Basis for the fallback notice and (card bitdepth-export-dialog) for the bit
 *  depth offered on export; card bitdepth-source-detection adds the other half,
 *  what the source could deliver. */
export interface EditorSourceDepth {
  bits: 8 | 16;
  decodeSource: RawDecodeMode | 'heif-linear16' | 'heif-8bit' | 'image';
  fallback: DepthFallback | null;
}

/** Discrete stages a RAW decode can be in, surfaced to the UI for progress
 *  feedback. Each stage carries a short user-visible label and an optional
 *  "next" hint so the overlay can show what's coming. Strategy implementations
 *  emit these via `RawDecodeOptions.onStage`. */
export type RawLoadStage =
  | { kind: 'cache-check'; label: string; next: string }
  | { kind: 'fetch'; label: string; next: string }
  | { kind: 'decode'; label: string; next: string }
  | { kind: 'preview'; label: string; next: string }
  | { kind: 'done'; label: string };

/** Where a backend can pull the original RAW itself, instead of the browser
 *  routing 20-50 MB through the user's network. From `getRemoteFetchHint`. */
export interface RawFetchHint {
  url: string;
  headers: Record<string, string>;
  method?: string;
}

export interface RawDecodeOptions {
  onPartial?: (result: RawDecodeResult) => void;
  /** Progress feedback for the UI. Strategies emit a fixed sequence of
   *  stages; consumers can use them to drive a loading overlay. */
  onStage?: (stage: RawLoadStage) => void;
  signal?: AbortSignal;
  /** Build the 8-bit `displayUrl` preview (default true). Callers that only
   *  want the pixels - thumbnails, batch analysis - set it to false and get
   *  an empty `displayUrl` instead of a JPEG encode they throw away. */
  wantPreview?: boolean;
  /** Stable photo-identity key for OPFS / backend persistence, produced by
   *  `makeRawCacheKey`. It deliberately does not change when a lazy content
   *  hash arrives. Strategies that cache use this to key the cache slot. */
  cacheKey?: string;
  /** Long-edge in pixels (1200=free default, up to 2540 for Pro, native for Pro+) */
  size?: number;
}

export interface RawDecoderStrategy {
  readonly id: RawDecodeMode;
  readonly displayName: string;
  readonly description: string;
  decode(file: File, opts?: RawDecodeOptions): Promise<RawDecodeResult | null>;
  /** Optional: decode purely from a locally-cached Smart Preview without
   *  needing the original RAW file. Returns null on cache miss. Strategies
   *  that don't cache locally (embedded-jpeg, libraw-wasm) can omit this.
   *  Major perf win for re-opening RAWs: avoids re-downloading the 20-50 MB
   *  source from the remote source provider. */
  decodeFromCache?(cacheKey: string, size: number, opts?: RawDecodeOptions): Promise<RawDecodeResult | null>;
  /** Optional: let the backend fetch the original from the source itself and
   *  return a prepared preview. Rung 3 of `loadRawPixels`. */
  decodeFromUrl?(
    hint: RawFetchHint, cacheKey: string, size: number, opts?: RawDecodeOptions,
  ): Promise<RawDecodeResult | null>;
  /** Optional: a backend path that already resolves to a prepared preview for
   *  a source the backend owns. Rung 2 of `loadRawPixels`. */
  decodeFromPreparedUrl?(
    url: string, cacheKey: string, size: number, opts?: RawDecodeOptions,
  ): Promise<RawDecodeResult | null>;
  isAvailable(): Promise<boolean>;
}

const LS_KEY = STORAGE_KEYS.rawDecodeMode;

/** Modes the user can pick, most preferred first. */
const USER_SELECTABLE_MODES: readonly RawDecodeMode[] = ['smart-preview', 'libraw-wasm'];

/**
 * Decoders that reach for `/api/raw`. A build without a backend must not offer
 * them: they would fetch index.html from the static host and fail obscurely.
 */
const BACKEND_DECODE_MODES: ReadonlySet<RawDecodeMode> = new Set(['smart-preview']);

export function rawDecodeModeNeedsBackend(mode: RawDecodeMode): boolean {
  return BACKEND_DECODE_MODES.has(mode);
}

/** Narrow a list of decoders to the ones this build can actually run. */
export function availableRawDecodeModes(
  modes: readonly RawDecodeMode[],
): readonly RawDecodeMode[] {
  if (hasBackend()) return modes;
  const usable = modes.filter((m) => !rawDecodeModeNeedsBackend(m));
  // Every source allows libraw-wasm, so this only guards a future table edit.
  return usable.length > 0 ? usable : ['libraw-wasm'];
}

/** The default decoder for this build — no longer a constant, see §P3. */
export function defaultRawDecodeMode(): RawDecodeMode {
  return availableRawDecodeModes(USER_SELECTABLE_MODES)[0];
}

export function getRawDecodeMode(): RawDecodeMode {
  const available = availableRawDecodeModes(USER_SELECTABLE_MODES);
  try {
    const v = localStorage.getItem(LS_KEY);
    // User-visible modes. Values stored by earlier builds (embedded-jpeg, and
    // the removed hybrid-auto and backend decoders) are migrated to the
    // default, and so is a smart-preview preference carried into a build
    // without a backend.
    if ((v === 'smart-preview' || v === 'libraw-wasm') && available.includes(v)) return v;
  } catch { /* */ }
  return available[0];
}

/** Decoders to offer in the settings — never a dead option (§P3). */
export function selectableRawDecodeModes(): readonly RawDecodeMode[] {
  return availableRawDecodeModes(USER_SELECTABLE_MODES);
}

export function setRawDecodeMode(mode: RawDecodeMode): void {
  try { localStorage.setItem(LS_KEY, mode); } catch { /* */ }
}

const SIZE_KEY = STORAGE_KEYS.rawDecodeSize;
export const DEFAULT_SMART_PREVIEW_SIZE = 1200;
export const SMART_PREVIEW_SIZES = [1200, 1800, 2540] as const;
export type SmartPreviewSize = typeof SMART_PREVIEW_SIZES[number];

export function getSmartPreviewSize(): SmartPreviewSize {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    if (SMART_PREVIEW_SIZES.includes(v as SmartPreviewSize)) return v as SmartPreviewSize;
  } catch { /* */ }
  return DEFAULT_SMART_PREVIEW_SIZE as SmartPreviewSize;
}

export function setSmartPreviewSize(size: SmartPreviewSize): void {
  try { localStorage.setItem(SIZE_KEY, String(size)); } catch { /* */ }
}
