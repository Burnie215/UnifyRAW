import { availableRawDecodeModes, type RawDecodeMode } from './RawDecoderStrategy';
import { sourceCapability } from '../../sources/capabilities';

/** Browser-owned sources whose original bytes must stay in the browser. */
export function isLocalRawSourceType(sourceType: string | null | undefined): boolean {
  return sourceCapability(sourceType)?.transport === 'browser-native';
}

/**
 * Decoders this source may use in this build, most preferred first. The table
 * says what the source allows; the build says which of those exist here — in
 * the online build the backend-backed ones do not (§P3).
 */
export function rawDecodeModesForSource(
  sourceType: string | null | undefined,
): readonly RawDecodeMode[] {
  const allowed = sourceCapability(sourceType)?.decodeModes ?? ['smart-preview', 'libraw-wasm'];
  return availableRawDecodeModes(allowed);
}

/** Resolve the effective mode while preserving the preference for remote sources. */
export function rawDecodeModeForSource(
  sourceType: string | null | undefined,
  preferredMode: RawDecodeMode,
): RawDecodeMode {
  const allowed = rawDecodeModesForSource(sourceType);
  return allowed.includes(preferredMode) ? preferredMode : allowed[0];
}

/**
 * May dwelling on a tile of this source pre-generate its Smart Preview?
 *
 * Only a source whose preview a server renders gets anything out of the dwell.
 * For every other one - a browser-owned folder, or any source in a build
 * without a backend - the hover buys a full download of the original, 20-60 MB
 * per RAW, that nothing reads afterwards (F022). A device without hover never
 * means the dwell either: there, "mouseenter" is the tap that opens the photo.
 */
export function hoverPrefetchAllowed(
  sourceType: string | null | undefined,
  hoverAvailable: boolean,
): boolean {
  if (!hoverAvailable) return false;
  // A type with no row in the capability table gets no speculative download:
  // rawDecodeModesForSource falls back to the proxy modes for callers that
  // already hold a file, and that fallback must not turn into a fetch here.
  if (!sourceCapability(sourceType)) return false;
  return rawDecodeModesForSource(sourceType).includes('smart-preview');
}

/**
 * May a pass that walks the WHOLE library read this source's originals?
 *
 * Neither the hover dwell nor a selection: the background thumbnailer touches
 * every photo in the library exactly once after a scan, so a source that
 * answers over the network pays a full original per photo - 20-60 MB for a RAW
 * - to produce a 300 px JPEG from it. Only a source whose bytes already lie on
 * this device may be read whole here; every other one has to be asked for its
 * own thumbnail instead (F022). The set happens to match
 * `isLocalRawSourceType` today, and the question is a different one: that one
 * picks a decoder, this one spends bandwidth.
 */
export function bulkOriginalReadAllowed(sourceType: string | null | undefined): boolean {
  return sourceCapability(sourceType)?.transport === 'browser-native';
}

/** Whether the background walker has any policy-approved route to a thumbnail. */
export function backgroundThumbnailAvailable(sourceType: string | null | undefined): boolean {
  const route = sourceCapability(sourceType)?.backgroundThumbnail;
  return route !== undefined && route !== 'none';
}
