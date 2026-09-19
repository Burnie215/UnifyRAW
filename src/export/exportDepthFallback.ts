import type { SourceDepthWarning } from '../engine/Exporter';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';

export interface ExportDepthInput {
  /** The bit depth the export dialog asked for. */
  requested: 8 | 16 | undefined;
  /** The 16-bit source pixels the render input carries, if any. */
  pixels: Pick<RawPixelData, 'bits' | 'data'> | null | undefined;
  /**
   * Whether a missing 16-bit decode may quietly become an 8-bit file.
   *
   * True for HEIF: its 16-bit path runs through libheif's optional C API and
   * refuses HLG/PQ transfer curves, so "no 16-bit pixels" is a normal,
   * file-specific outcome and an 8-bit export is the useful answer - as long
   * as it is said out loud. A RAW keeps the hard error instead: there the
   * 16-bit decode is the ordinary path, and a silent 8-bit TIFF would hide a
   * broken decoder behind a file that looks right.
   */
  mayFallBack: boolean;
}

export interface ExportDepthDecision {
  /** The depth to actually hand to `exportPhoto`. */
  bitDepth: 8 | 16;
  /** The notice the user has to see, or null when nothing degraded. */
  warning: SourceDepthWarning | null;
}

function has16BitPixels(pixels: ExportDepthInput['pixels']): boolean {
  return !!pixels && pixels.bits === 16 && pixels.data instanceof Uint16Array;
}

/**
 * Which depth one export really writes, and what to tell the user about it.
 *
 * The dialog offers 16 bit from the source's *maximum* depth
 * (engine/sourceBitDepth), which is a promise about the file, not about this
 * browser's decoder. This is where the promise meets the pixels that actually
 * arrived.
 */
export function planExportDepth(input: ExportDepthInput): ExportDepthDecision {
  if ((input.requested ?? 8) !== 16) return { bitDepth: 8, warning: null };
  if (has16BitPixels(input.pixels)) return { bitDepth: 16, warning: null };
  // Not our call to soften: let the exporter raise its own error.
  if (!input.mayFallBack) return { bitDepth: 16, warning: null };

  return {
    bitDepth: 8,
    warning: {
      code: 'source-16bit-unavailable',
      requestedBitDepth: 16,
      actualBitDepth: 8,
      message: 'No 16-bit source pixels were available; the file was written at 8 bit.',
    },
  };
}
