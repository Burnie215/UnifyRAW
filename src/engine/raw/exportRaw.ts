import { SMART_PREVIEW_MAX_PX } from '@photolib/shared';
import { decodeTiff } from './tiff';
import { detectWebGLCaps } from '../webglCaps';
import type { RawPixelData } from './RawDecoderStrategy';
import { apiFetch } from '../../platform/api';
import { rawDecoder } from '../RawDecoder';
import { heifDecoder } from '../HeifDecoder';
import { isLocalRawSourceType } from './sourcePolicy';
import { probeSmartPreviewCache } from './smartPreviewProbe';

/**
 * What the backend path asks for when the caller wants native pixels.
 *
 * It is the server's own ceiling, not a number that is bigger than any
 * camera: `parsePreviewSize` clamps every request to it, so a 9504x6336 file
 * comes back at 8000 px. Only the local libraw-wasm branch below returns the
 * sensor's own pixels. Whoever offers "native" to a user has to name which of
 * the two it is - `deliveredNativeLongEdge` in engine/printResolution.
 */
const NATIVE_SIZE = SMART_PREVIEW_MAX_PX;

/**
 * Decode a HEIF original to scene-linear 16-bit pixels for the export.
 *
 * Same contract as {@link loadFullResRawPixels}: `null` means "no 16-bit
 * source pixels", never a quietly relabelled 8-bit render. Two honest limits
 * produce it - a browser without 16-bit float render targets, and a file
 * whose depth libheif's C API does not hand over (the HLG/PQ boundary
 * documented in engine/heif16).
 *
 * The long edge is capped at the same `NATIVE_SIZE` as the RAW path. Here it
 * is not a server ceiling but a memory one: the decode goes through a full
 * interleaved 16-bit plane, and both paths should hand the exporter frames of
 * the same order of magnitude.
 */
export async function loadFullResHeifPixels(file: File): Promise<RawPixelData | null> {
  const caps = detectWebGLCaps();
  if (!caps.rgba16fRender) return null;

  try {
    const pixels = await heifDecoder.decode16(file, NATIVE_SIZE);
    if (!pixels || pixels.bits !== 16 || !(pixels.data instanceof Uint16Array)) return null;
    return pixels;
  } catch (error) {
    console.warn('[exportRaw] HEIF 16-bit decode failed:', error);
    return null;
  }
}

/**
 * Fetch a native-resolution Smart Preview TIFF (no downscale) and decode it
 * locally. Used by the export pipeline so RAW exports are full-resolution
 * with all editor adjustments re-applied at native pixels.
 *
 * Returns null if the browser lacks 16-bit WebGL support (caller should fall
 * back to the standard export path).
 */
export async function loadFullResRawPixels(
  file: File,
  cacheKey: string,
  sourceType?: string,
): Promise<RawPixelData | null> {
  const caps = detectWebGLCaps();
  if (!caps.rgba16fRender) return null;

  // Local browser-owned sources stay local for export as well. Do not fall
  // through to the backend when libraw-wasm cannot decode a camera format.
  if (isLocalRawSourceType(sourceType)) {
    try {
      const decoded = await rawDecoder.decode(file, {
        outputBps: 16,
        useAutoWb: false,
        useCameraWb: true,
        linear: true,
      });
      if (decoded.bits !== 16 || !decoded.data16) return null;
      const channels = decoded.colors === 4 ? 4 : 3;
      // The decoder's worker is terminated before decode() returns, so this
      // view is the only thing holding the buffer. Copying it out was a
      // second 361 MB next to the first for a 61-MP file, and the export
      // hands the buffer straight on to the render worker (F132).
      return {
        data: decoded.data16,
        width: decoded.width,
        height: decoded.height,
        channels,
        bits: 16,
        colorMatrix: null,
        asShotNeutral: null,
      };
    } catch (error) {
      console.warn('[exportRaw] local libraw-wasm decode failed:', error);
      return null;
    }
  }

  // Distinct cache slot from the editing preview so we don't trash the
  // 1200px cache when somebody exports.
  const nativeKey = `${cacheKey}_native`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);

  // A native-resolution RAW is the most expensive thing this app uploads, so
  // ask whether the backend still has the preview before sending it (F054).
  let buf: ArrayBuffer;
  const hit = await probeSmartPreviewCache(nativeKey, NATIVE_SIZE);
  if (hit) {
    buf = await hit.arrayBuffer();
  } else {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    const response = await apiFetch(`/api/raw/smart-preview?size=${NATIVE_SIZE}&key=${encodeURIComponent(nativeKey)}`, {
      method: 'POST',
      headers,
      body: file,
    });
    if (!response.ok) {
      console.warn(`[exportRaw] backend HTTP ${response.status}`);
      return null;
    }
    buf = await response.arrayBuffer();
  }
  const decoded = decodeTiff(buf);
  return {
    data: decoded.data,
    width: decoded.width,
    height: decoded.height,
    channels: decoded.channels,
    bits: decoded.bits,
    // The backend decoder already applied camera WB and camera→sRGB. Keep
    // native export on the same calibration boundary as the editor preview.
    colorMatrix: null,
    asShotNeutral: null,
  };
}
