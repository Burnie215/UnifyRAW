/**
 * Linear-DNG writer: the finished render as a scene-linear half-float DNG.
 *
 * DNG is a TIFF, so the container comes from `tiffIfd` and only the tags are
 * new. What makes it worth writing next to a 16-bit TIFF is not the geometry
 * but the declaration: `PhotometricInterpretation = LinearRaw` plus
 * `ColorMatrix1` / `AsShotNeutral` tell a RAW converter how to read the
 * numbers, so it opens the file with its develop controls instead of showing
 * a flat picture.
 *
 * The sample format is prescribed, not preferred. DNG 1.6 allows Deflate for
 * floating point data but NOT for 16-bit integer data, and it allows
 * `SampleFormat = 3` with `BitsPerSample = 16` from DNG 1.4 on. Half float is
 * therefore the only 16-bit-wide encoding that may be compressed at all —
 * which suits a pipeline that reads back an RGBA16F framebuffer anyway.
 *
 * The edit is baked in: this is the rendered frame, not a negative. See
 * `colorMatrix1For` for why that decides which matrix goes into the file.
 */

import { COLOR_SPACES } from './ColorSpace';
import { OUTPUT_COLOR_SPACES, type OutputColorSpaceId } from './outputColorSpaces';
import { deflateParts } from './PngChunks';
import { planTiffStrips } from './TiffEncoder';
import {
  asciiField,
  buildTiffLayout,
  byteField,
  longField,
  rationalField,
  shortField,
  srationalField,
  toBlobPart,
  TIFF_PAD_BYTE,
  type TiffField,
} from './tiffIfd';

export type DngCompression = 'deflate' | 'none';

export interface DngEncodeWarning {
  code: 'deflate-unavailable';
  requestedCompression: 'deflate';
  actualCompression: 'none';
  message: string;
}

/**
 * RGBA samples to encode. The alpha channel is dropped; a DNG has no place
 * for it.
 *
 * A `Uint16Array` here is IEEE half-float **bit patterns**, the native result
 * of `gl.readPixels(..., gl.RGBA, gl.HALF_FLOAT, …)`. It is NOT the
 * unsigned-normalised buffer that `readPixels16` returns — that one is
 * display-referred integers and would be read back as 6e4-ish garbage.
 * Callers holding real numbers pass a `Float32Array` instead.
 */
export type DngSamples = Uint16Array | Float32Array;

export interface DngEncodeOptions {
  width: number;
  height: number;
  /**
   * `ColorMatrix1`: XYZ (D65) to the working space's own linear RGB, row-major
   * 3x3. Use `colorMatrix1For` — the camera's own matrix is the wrong answer
   * here and the failure is a plausible-looking colour cast, not an error.
   */
  colorMatrix: readonly number[];
  /** `UniqueCameraModel` — required, and this file's camera is our pipeline. */
  uniqueCameraModel: string;
  /**
   * `AsShotNeutral`. Defaults to neutral because white balance is already
   * applied; a reader that finds anything else here would apply it twice.
   */
  asShotNeutral?: readonly [number, number, number];
  compression: DngCompression;
  /** The P3 XMP packet (`dc:source`, `unifyraw:editStackHash`, …), if any. */
  xmp?: Uint8Array | string;
  software?: string;
  /** Called when a requested, optional feature has to degrade honestly. */
  onWarning?: (warning: DngEncodeWarning) => void;
}

const SAMPLES_PER_PIXEL = 3;
const BYTES_PER_SAMPLE = 2;

const TAG_NEW_SUBFILE_TYPE = 254;
const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_BITS_PER_SAMPLE = 258;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC_INTERPRETATION = 262;
const TAG_ORIENTATION = 274;
const TAG_SAMPLES_PER_PIXEL = 277;
const TAG_ROWS_PER_STRIP = 278;
const TAG_PLANAR_CONFIGURATION = 284;
const TAG_SOFTWARE = 305;
const TAG_PREDICTOR = 317;
const TAG_SAMPLE_FORMAT = 339;
const TAG_XMP = 700;
const TAG_DNG_VERSION = 50706;
const TAG_DNG_BACKWARD_VERSION = 50707;
const TAG_UNIQUE_CAMERA_MODEL = 50708;
const TAG_COLOR_MATRIX_1 = 50721;
const TAG_AS_SHOT_NEUTRAL = 50728;
const TAG_CALIBRATION_ILLUMINANT_1 = 50778;

const COMPRESSION_NONE = 1;
const COMPRESSION_DEFLATE = 8;
const PHOTOMETRIC_LINEAR_RAW = 34892;
const PREDICTOR_NONE = 1;
/** TIFF Technical Note 3: floating point horizontal differencing. */
const PREDICTOR_FLOATING_POINT = 3;
const SAMPLE_FORMAT_IEEE_FLOAT = 3;
const PLANAR_CHUNKY = 1;
const ORIENTATION_TOP_LEFT = 1;
const CALIBRATION_ILLUMINANT_D65 = 21;
/** SampleFormat 3 at 16 bits and Deflate both need 1.4.0.0 as the floor. */
const DNG_VERSION_1_4 = [1, 4, 0, 0];
/** Adobe writes ColorMatrix over 10000; AsShotNeutral gets the finer grid. */
const COLOR_MATRIX_DENOMINATOR = 10_000;
const NEUTRAL_DENOMINATOR = 1_000_000;

const NEUTRAL: readonly [number, number, number] = [1, 1, 1];

/**
 * `ColorMatrix1` describes XYZ to *camera native*. After our render the pixels
 * are not camera native any more: white balance and the camera matrix were
 * applied long ago and the data sits in the working space. Writing the
 * camera's own matrix here makes the reader apply that transform a second
 * time — the result is a firmly shifted picture that still looks plausible
 * enough that nobody calls it a bug.
 *
 * The right answer is the inverse of the output space's primaries: the file is
 * then the negative of a virtual camera whose native space is our working
 * space, which is exactly how Adobe's own linear DNGs behave. That also makes
 * `AsShotNeutral` neutral honest, because the D65 white point maps to (1,1,1)
 * under this matrix.
 */
export function colorMatrix1For(id: OutputColorSpaceId): number[] {
  const xyzToLinearSrgb = COLOR_SPACES.srgb.fromXYZ;
  const linearSrgbToOutput = OUTPUT_COLOR_SPACES[id].matrix;
  const matrix: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        sum += linearSrgbToOutput[row * 3 + k] * xyzToLinearSrgb[k * 3 + column];
      }
      matrix.push(sum);
    }
  }
  return matrix;
}

/**
 * Encode RGBA samples as a single-IFD linear DNG. Strips are packed,
 * predicted and compressed one at a time, like `encodeTiff`, so a 45-MP frame
 * never needs a second full-size buffer.
 */
export async function encodeDng(pixels: DngSamples, options: DngEncodeOptions): Promise<Blob> {
  const { width, height } = options;
  assertInput(pixels, options);
  const plan = planTiffStrips(width, height, 16);
  const compression = effectiveCompression(options);
  // A predictor without compression only costs time: it exists to make the
  // bytes compress, and an uncompressed DNG stores them as they are.
  const predictor = compression === 'deflate' ? PREDICTOR_FLOATING_POINT : PREDICTOR_NONE;
  const strips: { blob: Blob; byteLength: number }[] = [];

  for (let firstRow = 0; firstRow < height; firstRow += plan.rowsPerStrip) {
    const rowCount = Math.min(plan.rowsPerStrip, height - firstRow);
    const raw = packHalfStrip(pixels, width, firstRow, rowCount);
    if (predictor === PREDICTOR_FLOATING_POINT) {
      applyFloatingPointPredictor(raw, plan.bytesPerRow, SAMPLES_PER_PIXEL);
    }
    const parts = compression === 'deflate' ? await deflateParts([raw]) : [raw];
    const byteLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
    if (byteLength === 0) throw new Error('encodeDng: compression produced an empty strip');
    strips.push({ blob: new Blob(parts.map(toBlobPart)), byteLength });
  }

  const layout = buildTiffLayout(
    directoryFields(options, plan.rowsPerStrip, compression, predictor),
    strips.map((strip) => strip.byteLength),
  );
  const blobParts: BlobPart[] = [toBlobPart(layout.directory)];
  for (const strip of strips) {
    blobParts.push(strip.blob);
    if (strip.byteLength % 2 !== 0) blobParts.push(toBlobPart(TIFF_PAD_BYTE));
  }
  return new Blob(blobParts, { type: 'image/x-adobe-dng' });
}

function directoryFields(
  options: DngEncodeOptions,
  rowsPerStrip: number,
  compression: DngCompression,
  predictor: number,
): TiffField[] {
  const neutral = options.asShotNeutral ?? NEUTRAL;
  const fields: TiffField[] = [
    longField(TAG_NEW_SUBFILE_TYPE, [0]),
    longField(TAG_IMAGE_WIDTH, [options.width]),
    longField(TAG_IMAGE_LENGTH, [options.height]),
    shortField(TAG_BITS_PER_SAMPLE, [16, 16, 16]),
    shortField(TAG_COMPRESSION, [compression === 'deflate' ? COMPRESSION_DEFLATE : COMPRESSION_NONE]),
    shortField(TAG_PHOTOMETRIC_INTERPRETATION, [PHOTOMETRIC_LINEAR_RAW]),
    shortField(TAG_ORIENTATION, [ORIENTATION_TOP_LEFT]),
    shortField(TAG_SAMPLES_PER_PIXEL, [SAMPLES_PER_PIXEL]),
    longField(TAG_ROWS_PER_STRIP, [rowsPerStrip]),
    shortField(TAG_PLANAR_CONFIGURATION, [PLANAR_CHUNKY]),
    shortField(TAG_PREDICTOR, [predictor]),
    shortField(TAG_SAMPLE_FORMAT, Array(SAMPLES_PER_PIXEL).fill(SAMPLE_FORMAT_IEEE_FLOAT)),
    byteField(TAG_DNG_VERSION, DNG_VERSION_1_4),
    byteField(TAG_DNG_BACKWARD_VERSION, DNG_VERSION_1_4),
    asciiField(TAG_UNIQUE_CAMERA_MODEL, options.uniqueCameraModel),
    srationalField(TAG_COLOR_MATRIX_1, options.colorMatrix, COLOR_MATRIX_DENOMINATOR),
    rationalField(TAG_AS_SHOT_NEUTRAL, [...neutral], NEUTRAL_DENOMINATOR),
    shortField(TAG_CALIBRATION_ILLUMINANT_1, [CALIBRATION_ILLUMINANT_D65]),
  ];
  if (options.software) fields.push(asciiField(TAG_SOFTWARE, options.software));
  if (options.xmp !== undefined) fields.push(byteField(TAG_XMP, xmpBytes(options.xmp)));
  return fields;
}

function xmpBytes(xmp: Uint8Array | string): Uint8Array {
  const bytes = typeof xmp === 'string' ? new TextEncoder().encode(xmp) : xmp;
  if (bytes.length === 0) throw new Error('encodeDng: the XMP packet is empty');
  return bytes;
}

/** Chunky RGB half-float rows, little-endian, alpha dropped. */
function packHalfStrip(
  pixels: DngSamples,
  width: number,
  firstRow: number,
  rowCount: number,
): Uint8Array {
  const bytes = new Uint8Array(width * rowCount * SAMPLES_PER_PIXEL * BYTES_PER_SAMPLE);
  const view = new DataView(bytes.buffer);
  const alreadyHalf = pixels instanceof Uint16Array;
  const firstSource = firstRow * width * 4;
  const sourceEnd = firstSource + rowCount * width * 4;
  let destination = 0;
  for (let source = firstSource; source < sourceEnd; source += 4) {
    for (let channel = 0; channel < SAMPLES_PER_PIXEL; channel++) {
      const sample = pixels[source + channel];
      view.setUint16(destination, alreadyHalf ? sample : floatToHalf(sample), true);
      destination += BYTES_PER_SAMPLE;
    }
  }
  return bytes;
}

/**
 * Predictor 3 in place, row by row (TIFF Technical Note 3, as libtiff's
 * `fpDiff` and Adobe's DNG SDK implement it).
 *
 * Two steps, and the first is the one that earns the compression: the row's
 * bytes are de-interleaved into byte planes, most significant plane first, so
 * the exponents of neighbouring samples end up next to each other instead of
 * alternating with mantissa noise. Only then are the bytes differenced
 * against the sample `stride` positions back — which, in the shuffled layout,
 * is the same colour channel of the previous pixel.
 *
 * The plane order is fixed by the note, not by the file's endianness: this
 * encoder writes little-endian samples, so the file's byte 1 is the most
 * significant one and goes into plane 0.
 */
export function applyFloatingPointPredictor(
  bytes: Uint8Array,
  bytesPerRow: number,
  stride: number,
): void {
  const samplesPerRow = bytesPerRow / BYTES_PER_SAMPLE;
  const scratch = new Uint8Array(bytesPerRow);
  for (let rowStart = 0; rowStart < bytes.length; rowStart += bytesPerRow) {
    const row = bytes.subarray(rowStart, rowStart + bytesPerRow);
    scratch.set(row);
    for (let sample = 0; sample < samplesPerRow; sample++) {
      for (let byte = 0; byte < BYTES_PER_SAMPLE; byte++) {
        row[(BYTES_PER_SAMPLE - 1 - byte) * samplesPerRow + sample] =
          scratch[sample * BYTES_PER_SAMPLE + byte];
      }
    }
    // Backwards, so every subtraction still sees its untouched predecessor.
    for (let index = bytesPerRow - 1; index >= stride; index--) {
      row[index] = (row[index] - row[index - stride]) & 0xff;
    }
  }
}

const FLOAT_BITS = new Float32Array(1);
const FLOAT_AS_UINT = new Uint32Array(FLOAT_BITS.buffer);

/** IEEE 754 binary16 bit pattern, rounded half-to-even like the hardware. */
export function floatToHalf(value: number): number {
  FLOAT_BITS[0] = value;
  const bits = FLOAT_AS_UINT[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;
  if (exponent === 0xff) {
    // Infinity stays infinity; any NaN keeps a non-zero mantissa.
    return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x200);
  }
  const halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    // Subnormal, or too small to be one.
    if (halfExponent < -10) return sign;
    const shift = 14 - halfExponent;
    const full = mantissa | 0x800000;
    let half = full >>> shift;
    const remainder = full & ((1 << shift) - 1);
    const halfway = 1 << (shift - 1);
    if (remainder > halfway || (remainder === halfway && (half & 1) === 1)) half += 1;
    return sign | half;
  }
  let half = (halfExponent << 10) | (mantissa >>> 13);
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && (half & 1) === 1)) half += 1;
  return sign | half;
}

/** The inverse of `floatToHalf`, for readers and tests. */
export function halfToFloat(half: number): number {
  const sign = half & 0x8000 ? -1 : 1;
  const exponent = (half >>> 10) & 0x1f;
  const mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

function effectiveCompression(options: DngEncodeOptions): DngCompression {
  if (options.compression !== 'deflate' || typeof CompressionStream !== 'undefined') {
    return options.compression;
  }
  const warning: DngEncodeWarning = {
    code: 'deflate-unavailable',
    requestedCompression: 'deflate',
    actualCompression: 'none',
    message: 'Deflate compression is unavailable; the DNG was written uncompressed.',
  };
  console.warn(`[DngEncoder] ${warning.message}`);
  options.onWarning?.(warning);
  return 'none';
}

function assertInput(pixels: DngSamples, options: DngEncodeOptions): void {
  const { width, height, compression, colorMatrix, uniqueCameraModel } = options;
  if (compression !== 'none' && compression !== 'deflate') {
    throw new Error('encodeDng: unsupported compression');
  }
  if (!(pixels instanceof Uint16Array) && !(pixels instanceof Float32Array)) {
    throw new Error('encodeDng: samples must be half-float bit patterns or floats');
  }
  if (pixels.length !== width * height * 4) {
    throw new Error('encodeDng: RGBA sample count does not match geometry');
  }
  if (colorMatrix.length !== 9) {
    throw new Error('encodeDng: ColorMatrix1 needs nine values');
  }
  if (uniqueCameraModel.trim().length === 0) {
    throw new Error('encodeDng: UniqueCameraModel is required');
  }
  const neutral = options.asShotNeutral;
  if (neutral && neutral.some((value) => !(value > 0))) {
    throw new Error('encodeDng: AsShotNeutral values must be positive');
  }
}
