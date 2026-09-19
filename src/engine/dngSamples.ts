/**
 * The bridge from the render pipeline's 16-bit readback to `encodeDng`.
 *
 * It exists because the two sides disagree about what a 16-bit sample is, and
 * the disagreement is invisible in the finished file. `readPixels16`
 * ([graph/PipelineService.ts](graph/PipelineService.ts)) returns
 * **unsigned-normalised** integers of the **display-referred** terminal:
 * 0..65535 over a value the `outputColorSpace` node has already put through
 * the space's transfer curve and clamped to [0,1]. `encodeDng` wants half-float
 * **bit patterns** of **linear** light in the same primaries, because that is
 * what the `ColorMatrix1` it writes (`colorMatrix1For`) describes.
 *
 * Hand the readback over unchanged and every number is wrong twice - read as a
 * half-float bit pattern, 65535 is 1.8e6, and even after dividing by 65535 the
 * values are still gamma-encoded under a header that promises linear. Both
 * produce a file that opens without complaint, which is why this conversion is
 * a named step with its own test rather than a line inside the exporter.
 *
 * What this does NOT recover is headroom. The shader clamped at 1.0 before the
 * readback, so the result is linear but display-range; a true scene-linear DNG
 * would need a terminal that skips the encode, which is a change to the shared
 * render path. `Exporter.encodeDngFrame` carries the same note.
 */

import { floatToHalf } from './DngEncoder';
import {
  decodeOutputTransfer,
  OUTPUT_COLOR_SPACES,
  type OutputColorSpaceId,
} from './outputColorSpaces';

const UNORM16_MAX = 65535;
/** 65536 entries cover every possible unorm16 input, so no sample is approximated. */
const LOOKUP_SIZE = UNORM16_MAX + 1;

const lookupCache = new Map<number, Uint16Array>();

/**
 * Every unorm16 code point's half-float bit pattern, for one transfer curve.
 * A 45-MP frame is 135 million colour samples; 65536 `Math.pow` calls up front
 * beat two per sample, and the table is exact rather than interpolated.
 */
function halfLookupFor(gammaType: number): Uint16Array {
  const cached = lookupCache.get(gammaType);
  if (cached) return cached;
  const table = new Uint16Array(LOOKUP_SIZE);
  for (let code = 0; code < LOOKUP_SIZE; code++) {
    table[code] = floatToHalf(decodeOutputTransfer(code / UNORM16_MAX, gammaType));
  }
  lookupCache.set(gammaType, table);
  return table;
}

/**
 * RGBA unorm16 display-referred samples to RGBA half-float bit patterns of
 * linear light in the same primaries - the input `encodeDng` documents.
 *
 * Alpha carries no transfer curve (the shader passes `src.a` through), so it
 * is only normalised. `encodeDng` drops it; it is converted anyway so that the
 * result is a faithful RGBA buffer rather than one with a trap in channel 3.
 *
 * Allocates a second buffer of the same size instead of writing through the
 * input: the caller's `RenderedFrame16` may be the un-resampled original, and
 * an encoder that eats its argument is the wrong kind of surprise.
 */
export function linearHalfSamples(
  pixels: Uint16Array,
  colorSpace: OutputColorSpaceId,
): Uint16Array {
  if (pixels.length % 4 !== 0) {
    throw new Error('linearHalfSamples: expected RGBA samples');
  }
  const colour = halfLookupFor(OUTPUT_COLOR_SPACES[colorSpace].gammaType);
  const alpha = alphaHalfLookup();
  const half = new Uint16Array(pixels.length);
  for (let index = 0; index < pixels.length; index += 4) {
    half[index] = colour[pixels[index]];
    half[index + 1] = colour[pixels[index + 1]];
    half[index + 2] = colour[pixels[index + 2]];
    half[index + 3] = alpha[pixels[index + 3]];
  }
  return half;
}

/** Alpha is a ratio, not light: normalised only, never linearised. */
let alphaLookup: Uint16Array | null = null;

function alphaHalfLookup(): Uint16Array {
  if (!alphaLookup) {
    alphaLookup = new Uint16Array(LOOKUP_SIZE);
    for (let code = 0; code < LOOKUP_SIZE; code++) alphaLookup[code] = floatToHalf(code / UNORM16_MAX);
  }
  return alphaLookup;
}
