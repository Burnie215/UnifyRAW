import { EmbeddedJpegStrategy } from './EmbeddedJpegStrategy';
import { LibrawWasmStrategy } from './LibrawWasmStrategy';
import { SmartPreviewStrategy } from './SmartPreviewStrategy';
import {
  getRawDecodeMode, selectableRawDecodeModes,
  type RawDecoderStrategy, type RawDecodeMode,
} from './RawDecoderStrategy';
import { rawDecodeModeForSource } from './sourcePolicy';

const STRATEGIES: Record<RawDecodeMode, RawDecoderStrategy> = {
  'smart-preview': new SmartPreviewStrategy(),
  'embedded-jpeg': new EmbeddedJpegStrategy(),
  'libraw-wasm': new LibrawWasmStrategy(),
};

export function strategyFor(mode: RawDecodeMode): RawDecoderStrategy {
  return STRATEGIES[mode] ?? STRATEGIES['smart-preview'];
}

/**
 * Browser-owned sources must never upload their RAW bytes to the backend for
 * decoding. Besides keeping local files local, this also avoids a needless
 * browser -> server round-trip for files that are already on the device.
 */
export function strategyForSource(
  sourceType: string | null | undefined,
  preferredMode: RawDecodeMode = getRawDecodeMode(),
): RawDecoderStrategy {
  return strategyFor(rawDecodeModeForSource(sourceType, preferredMode));
}

/**
 * User-selectable strategies.
 * - SmartPreview: server-decoded, cached client-side for instant re-opens
 * - libraw-wasm: offline / no-backend fallback
 * EmbeddedJpegStrategy is not selectable; SmartPreview and libraw-wasm fall
 * back to it when their decode fails.
 *
 * A build without a backend drops SmartPreview here rather than showing a
 * setting that decodes into a 404 (§P3).
 */
export function allStrategies(): RawDecoderStrategy[] {
  return selectableRawDecodeModes().map((mode) => STRATEGIES[mode]);
}

export type { RawDecoderStrategy, RawDecodeMode, RawDecodeResult, RawDecodeOptions, RawPixelData } from './RawDecoderStrategy';
export {
  getRawDecodeMode, setRawDecodeMode, defaultRawDecodeMode,
  availableRawDecodeModes, selectableRawDecodeModes, rawDecodeModeNeedsBackend,
  getSmartPreviewSize, setSmartPreviewSize, DEFAULT_SMART_PREVIEW_SIZE, SMART_PREVIEW_SIZES,
} from './RawDecoderStrategy';
export type { SmartPreviewSize } from './RawDecoderStrategy';
export { loadRawPixels } from './loadRawPixels';
export type { RawLoadRequest } from './loadRawPixels';
export { prefetchManager, PrefetchManager } from './prefetchManager';
export { loadFullResRawPixels, loadFullResHeifPixels } from './exportRaw';
export { getCacheStats, clearAllSmartPreviews } from './cacheCleanup';
export { hoverPrefetchAllowed, isLocalRawSourceType, rawDecodeModeForSource, rawDecodeModesForSource } from './sourcePolicy';
