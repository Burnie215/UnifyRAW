import type { HeifMode } from '../HeifDecoder';
import type { DepthFallback, EditorSourceDepth, RawDecodeMode } from './RawDecoderStrategy';

export interface EditorSourceDepthInput {
  isRaw: boolean;
  /** `RawDecodeResult.bits` of the load that is on screen, null while unknown. */
  rawBits: 8 | 16 | null;
  /** `RawDecodeResult.source` of that load, null while unknown. */
  rawSource: RawDecodeMode | null;
  isHeif: boolean;
  heifMode: HeifMode;
  /** True when `HeifDecoder.decode16` delivered 16-bit pixels. */
  heifPixels16: boolean;
  /** The editor has the image; before that there is nothing to report. */
  loaded: boolean;
}

/**
 * What the editor is actually editing, and whether that is a fall-back.
 *
 * The decoders already carry `bits` and `source`, but nothing looked at them,
 * so a failed RAW development (libraw or the backend) silently handed the
 * camera's embedded JPEG to the additive JPEG graph, and a HEIF whose 16-bit
 * C-API is missing silently stayed at 8 bit (F039).
 *
 * Only the state is reported, never a diagnosis: the fallback also happens on
 * transient errors (backend gone for a moment, abort on a tab switch).
 */
export function deriveEditorSourceDepth(input: EditorSourceDepthInput): EditorSourceDepth | null {
  if (!input.loaded) return null;

  if (input.isRaw) {
    if (input.rawSource === null || input.rawBits === null) return null;
    if (input.rawSource === 'embedded-jpeg') {
      return { bits: input.rawBits, decodeSource: input.rawSource, fallback: 'raw-embedded-jpeg' };
    }
    return {
      bits: input.rawBits,
      decodeSource: input.rawSource,
      fallback: input.rawBits === 8 ? 'raw-8bit' : null,
    };
  }

  if (input.isHeif) {
    if (input.heifPixels16) {
      return { bits: 16, decodeSource: 'heif-linear16', fallback: null };
    }
    // Only a user who asked for "16 bit linear" lost something here.
    return {
      bits: 8,
      decodeSource: 'heif-8bit',
      fallback: input.heifMode === 'linear16' ? 'heif-8bit' : null,
    };
  }

  return { bits: 8, decodeSource: 'image', fallback: null };
}

/**
 * The notice the editor shows for this photo, or null for none.
 *
 * Dismissal is keyed on the photo, not remembered anywhere else: closing it
 * removes it for that photo only, and the same photo re-opened shows it again
 * because the condition is still real (decision 2 of AP25).
 */
export function depthNoticeFor(
  depth: EditorSourceDepth | null,
  photoId: number,
  dismissedFor: number | null,
): DepthFallback | null {
  if (!depth?.fallback) return null;
  return dismissedFor === photoId ? null : depth.fallback;
}
