import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COLOR_SPACES } from './ColorSpace';
import {
  applyFloatingPointPredictor,
  colorMatrix1For,
  encodeDng,
  floatToHalf,
  halfToFloat,
  type DngEncodeWarning,
} from './DngEncoder';
import { OUTPUT_COLOR_SPACES, type OutputColorSpaceId } from './outputColorSpaces';
import { planTiffStrips } from './TiffEncoder';

interface DngEntry {
  tag: number;
  type: number;
  count: number;
  /** File offset of the twelve-byte entry itself. */
  at: number;
  /** The uint32 in the entry's value slot — an offset when the payload is external. */
  value: number;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };

const SAMPLES_PER_PIXEL = 3;
const BYTES_PER_SAMPLE = 2;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function entriesOf(bytes: Uint8Array): Map<number, DngEntry> {
  const view = viewOf(bytes);
  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);
  const entries = new Map<number, DngEntry>();
  for (let index = 0; index < count; index++) {
    const at = ifd + 2 + index * 12;
    const tag = view.getUint16(at, true);
    entries.set(tag, {
      tag,
      at,
      type: view.getUint16(at + 2, true),
      count: view.getUint32(at + 4, true),
      value: view.getUint32(at + 8, true),
    });
  }
  return entries;
}

/** The entry's payload, wherever TIFF put it: inline for <= 4 bytes, else at the offset. */
function payload(bytes: Uint8Array, entry: DngEntry): Uint8Array {
  const length = entry.count * TYPE_SIZE[entry.type];
  const start = length <= 4 ? entry.at + 8 : entry.value;
  return bytes.subarray(start, start + length);
}

function field(bytes: Uint8Array, entries: Map<number, DngEntry>, tag: number): DngEntry {
  const entry = entries.get(tag);
  if (!entry) throw new Error(`tag ${tag} is missing from the DNG`);
  expect(payload(bytes, entry).length).toBe(entry.count * TYPE_SIZE[entry.type]);
  return entry;
}

function shorts(bytes: Uint8Array, entry: DngEntry): number[] {
  const data = payload(bytes, entry);
  const view = viewOf(data);
  return Array.from({ length: entry.count }, (_, index) => view.getUint16(index * 2, true));
}

function longs(bytes: Uint8Array, entry: DngEntry): number[] {
  const data = payload(bytes, entry);
  const view = viewOf(data);
  return Array.from({ length: entry.count }, (_, index) => view.getUint32(index * 4, true));
}

function fractions(bytes: Uint8Array, entry: DngEntry): [number, number][] {
  const data = payload(bytes, entry);
  const view = viewOf(data);
  const signed = entry.type === 10;
  return Array.from({ length: entry.count }, (_, index) => [
    signed ? view.getInt32(index * 8, true) : view.getUint32(index * 8, true),
    view.getUint32(index * 8 + 4, true),
  ]);
}

function ascii(bytes: Uint8Array, entry: DngEntry): string {
  const data = payload(bytes, entry);
  expect(data[data.length - 1]).toBe(0);
  return new TextDecoder().decode(data.subarray(0, data.length - 1));
}

/**
 * The inverse of TIFF Technical Note 3, written from the note rather than by
 * calling the encoder's own function — otherwise the round trip would only
 * prove that a bug is symmetric.
 */
function undoFloatingPointPredictor(bytes: Uint8Array, bytesPerRow: number, stride: number): void {
  const samplesPerRow = bytesPerRow / BYTES_PER_SAMPLE;
  const scratch = new Uint8Array(bytesPerRow);
  for (let rowStart = 0; rowStart < bytes.length; rowStart += bytesPerRow) {
    const row = bytes.subarray(rowStart, rowStart + bytesPerRow);
    for (let index = stride; index < bytesPerRow; index++) {
      row[index] = (row[index] + row[index - stride]) & 0xff;
    }
    scratch.set(row);
    for (let sample = 0; sample < samplesPerRow; sample++) {
      for (let byte = 0; byte < BYTES_PER_SAMPLE; byte++) {
        row[sample * BYTES_PER_SAMPLE + byte] =
          scratch[(BYTES_PER_SAMPLE - 1 - byte) * samplesPerRow + sample];
      }
    }
  }
}

/** Read the image back the way a DNG reader would: strips, Deflate, predictor, halfs. */
function decodeHalfSamples(bytes: Uint8Array): Uint16Array {
  const entries = entriesOf(bytes);
  const width = longs(bytes, field(bytes, entries, 256))[0];
  const height = longs(bytes, field(bytes, entries, 257))[0];
  const compression = shorts(bytes, field(bytes, entries, 259))[0];
  const predictor = shorts(bytes, field(bytes, entries, 317))[0];
  const offsets = longs(bytes, field(bytes, entries, 273));
  const byteCounts = longs(bytes, field(bytes, entries, 279));
  const bytesPerRow = width * SAMPLES_PER_PIXEL * BYTES_PER_SAMPLE;

  const image = new Uint8Array(bytesPerRow * height);
  let destination = 0;
  offsets.forEach((offset, index) => {
    const strip = bytes.subarray(offset, offset + byteCounts[index]);
    const raw = compression === 8
      ? Uint8Array.from(inflateSync(strip))
      : Uint8Array.from(strip);
    if (predictor === 3) undoFloatingPointPredictor(raw, bytesPerRow, SAMPLES_PER_PIXEL);
    image.set(raw, destination);
    destination += raw.length;
  });
  expect(destination).toBe(image.length);

  const view = viewOf(image);
  const samples = new Uint16Array(image.length / BYTES_PER_SAMPLE);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = view.getUint16(index * BYTES_PER_SAMPLE, true);
  }
  return samples;
}

/**
 * Compare sample streams by their first mismatch. A `toEqual` over the
 * two-million-entry multi-strip image spends minutes building a diff nobody
 * can read; an index and the two values say more, immediately.
 */
function expectSamples(actual: Uint16Array, expected: ArrayLike<number>): void {
  expect(actual.length).toBe(expected.length);
  let mismatch = -1;
  for (let index = 0; index < actual.length; index++) {
    if (actual[index] !== expected[index]) {
      mismatch = index;
      break;
    }
  }
  expect(mismatch === -1
    ? 'all samples equal'
    : `sample ${mismatch}: wrote ${actual[mismatch]}, expected ${expected[mismatch]}`,
  ).toBe('all samples equal');
}

/**
 * Row-major 3x3 arithmetic, written out here rather than imported, so that no
 * production code can be used to vouch for itself in the matrix assertions.
 */
function multiply3(a: readonly number[], b: readonly number[]): number[] {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    return a[row * 3] * b[column] + a[row * 3 + 1] * b[3 + column] + a[row * 3 + 2] * b[6 + column];
  });
}

function apply3(matrix: readonly number[], vector: readonly number[]): number[] {
  return [0, 1, 2].map((row) =>
    matrix[row * 3] * vector[0] + matrix[row * 3 + 1] * vector[1] + matrix[row * 3 + 2] * vector[2]);
}

function transpose3(matrix: readonly number[]): number[] {
  return Array.from({ length: 9 }, (_, index) => matrix[(index % 3) * 3 + Math.floor(index / 3)]);
}

/** Adjugate over determinant; every matrix used here is far from singular. */
function invert3(m: readonly number[]): number[] {
  const adjugate = [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
  const determinant = m[0] * adjugate[0] + m[1] * adjugate[3] + m[2] * adjugate[6];
  if (Math.abs(determinant) < 1e-12) throw new Error('invert3: the matrix is singular');
  return adjugate.map((value) => value / determinant);
}

function sceneLinearRgba(width: number, height: number): Float32Array {
  const pixels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      // Scene-linear, so values above 1.0 are normal and must survive.
      pixels[offset] = (x * 0.017 + y * 0.003) % 3.5;
      pixels[offset + 1] = 0.0001 + ((x * 0.11 + y * 0.07) % 1.2);
      pixels[offset + 2] = ((x * 13 + y * 7) % 97) / 96;
      pixels[offset + 3] = 1;
    }
  }
  return pixels;
}

function halfPatternRgba(width: number, height: number): Uint16Array {
  const pixels = new Uint16Array(width * height * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = floatToHalf(((index * 7) % 1000) / 400);
    pixels[index + 1] = floatToHalf(((index * 3) % 613) / 613);
    pixels[index + 2] = floatToHalf(((index * 11) % 257) / 128);
    pixels[index + 3] = floatToHalf(1);
  }
  return pixels;
}

const MATRIX = colorMatrix1For('srgb');

const BASE = {
  colorMatrix: MATRIX,
  uniqueCameraModel: 'UnifyRAW Linear',
  compression: 'deflate',
} as const;

async function encodeToBytes(
  pixels: Float32Array | Uint16Array,
  options: Parameters<typeof encodeDng>[1],
): Promise<Uint8Array> {
  const blob = await encodeDng(pixels, options);
  return new Uint8Array(await blob.arrayBuffer());
}

describe('encodeDng tags', () => {
  it('writes exactly the DNG 1.4 tag set the spec demands, value for value', async () => {
    const width = 4;
    const height = 3;
    const bytes = await encodeToBytes(sceneLinearRgba(width, height), {
      ...BASE, width, height,
    });
    const entries = entriesOf(bytes);

    expect([...bytes.subarray(0, 4)]).toEqual([0x49, 0x49, 0x2a, 0]);
    expect([...entries.keys()].sort((a, b) => a - b)).toEqual([
      254, 256, 257, 258, 259, 262, 273, 274, 277, 278, 279, 284, 317, 339,
      50706, 50707, 50708, 50721, 50728, 50778,
    ]);

    // Geometry and layout.
    expect(longs(bytes, field(bytes, entries, 254))).toEqual([0]);
    expect(longs(bytes, field(bytes, entries, 256))).toEqual([width]);
    expect(longs(bytes, field(bytes, entries, 257))).toEqual([height]);
    expect(shorts(bytes, field(bytes, entries, 274))).toEqual([1]);
    expect(shorts(bytes, field(bytes, entries, 277))).toEqual([3]);
    expect(shorts(bytes, field(bytes, entries, 284))).toEqual([1]);
    expect(longs(bytes, field(bytes, entries, 278))).toEqual([height]);

    // The sample format is the whole reason this is half float and not uint16.
    expect(shorts(bytes, field(bytes, entries, 258))).toEqual([16, 16, 16]);
    expect(shorts(bytes, field(bytes, entries, 339))).toEqual([3, 3, 3]);
    expect(shorts(bytes, field(bytes, entries, 259))).toEqual([8]);
    expect(shorts(bytes, field(bytes, entries, 317))).toEqual([3]);
    expect(shorts(bytes, field(bytes, entries, 262))).toEqual([34892]);

    // The mandatory DNG identity.
    const version = field(bytes, entries, 50706);
    expect(version).toMatchObject({ type: 1, count: 4 });
    expect([...payload(bytes, version)]).toEqual([1, 4, 0, 0]);
    const backward = field(bytes, entries, 50707);
    expect(backward).toMatchObject({ type: 1, count: 4 });
    expect([...payload(bytes, backward)]).toEqual([1, 4, 0, 0]);

    const model = field(bytes, entries, 50708);
    expect(model).toMatchObject({ type: 2, count: 'UnifyRAW Linear'.length + 1 });
    expect(ascii(bytes, model)).toBe('UnifyRAW Linear');

    const colorMatrix = field(bytes, entries, 50721);
    expect(colorMatrix).toMatchObject({ type: 10, count: 9 });
    expect(fractions(bytes, colorMatrix)).toEqual(
      MATRIX.map((value) => [Math.round(value * 10_000), 10_000]),
    );
    expect(fractions(bytes, colorMatrix).some(([numerator]) => numerator < 0)).toBe(true);

    // White balance is baked in, so the reader must not apply one.
    const neutral = field(bytes, entries, 50728);
    expect(neutral).toMatchObject({ type: 5, count: 3 });
    expect(fractions(bytes, neutral)).toEqual([
      [1_000_000, 1_000_000], [1_000_000, 1_000_000], [1_000_000, 1_000_000],
    ]);
    expect(shorts(bytes, field(bytes, entries, 50778))).toEqual([21]);

    // Entries are ascending, which is what makes a TIFF reader's binary search work.
    const tags = [...entries.values()].sort((a, b) => a.at - b.at).map((entry) => entry.tag);
    expect(tags).toEqual([...tags].sort((a, b) => a - b));
    expect(viewOf(bytes).getUint32(
      [...entries.values()].reduce((last, entry) => Math.max(last, entry.at), 0) + 12, true,
    )).toBe(0);
  });

  it('carries the P3 XMP packet and a Software line when they are supplied', async () => {
    const xmp = '<?xpacket begin="﻿"?><x:xmpmeta><dc:source>IMG_0042.CR3</dc:source>'
      + '<unifyraw:editStackHash>abc123</unifyraw:editStackHash></x:xmpmeta><?xpacket end="w"?>';
    const bytes = await encodeToBytes(sceneLinearRgba(2, 2), {
      ...BASE, width: 2, height: 2, xmp, software: 'UnifyRAW',
    });
    const entries = entriesOf(bytes);

    const packet = field(bytes, entries, 700);
    const expected = new TextEncoder().encode(xmp);
    expect(packet).toMatchObject({ type: 1, count: expected.length });
    expect([...payload(bytes, packet)]).toEqual([...expected]);
    expect(ascii(bytes, field(bytes, entries, 305))).toBe('UnifyRAW');

    const withoutXmp = entriesOf(await encodeToBytes(sceneLinearRgba(2, 2), {
      ...BASE, width: 2, height: 2,
    }));
    expect(withoutXmp.has(700)).toBe(false);
    expect(withoutXmp.has(305)).toBe(false);
  });

  it('rejects input it cannot describe honestly', async () => {
    await expect(encodeDng(new Float32Array(4 * 2), { ...BASE, width: 2, height: 2 }))
      .rejects.toThrow(/sample count does not match/);
    await expect(encodeDng(sceneLinearRgba(2, 2), {
      ...BASE, width: 2, height: 2, colorMatrix: [1, 0, 0, 0, 1, 0],
    })).rejects.toThrow(/nine values/);
    await expect(encodeDng(sceneLinearRgba(2, 2), {
      ...BASE, width: 2, height: 2, uniqueCameraModel: '  ',
    })).rejects.toThrow(/UniqueCameraModel is required/);
    await expect(encodeDng(new Uint8Array(16) as unknown as Float32Array, {
      ...BASE, width: 2, height: 2,
    })).rejects.toThrow(/half-float bit patterns or floats/);
  });
});

describe('encodeDng pixels', () => {
  it('round-trips every sample through Deflate and the floating point predictor', async () => {
    const width = 37;
    const height = 11;
    const pixels = sceneLinearRgba(width, height);
    const bytes = await encodeToBytes(pixels, { ...BASE, width, height });

    const samples = decodeHalfSamples(bytes);
    expect(samples).toHaveLength(width * height * SAMPLES_PER_PIXEL);
    expectSamples(samples, Array.from(pixels)
      .filter((_value, index) => index % 4 !== 3)
      .map(floatToHalf));
    // Scene-linear means highlights above 1.0 stay above 1.0.
    expect(Math.max(...[...samples].map(halfToFloat))).toBeGreaterThan(1);
  });

  it('passes half-float bit patterns from an RGBA16F readback through untouched', async () => {
    const width = 9;
    const height = 5;
    const pixels = halfPatternRgba(width, height);
    const bytes = await encodeToBytes(pixels, { ...BASE, width, height });

    expectSamples(decodeHalfSamples(bytes),
      [...pixels].filter((_value, index) => index % 4 !== 3));
  });

  it('writes plain little-endian halfs and Predictor 1 when compression is off', async () => {
    const width = 3;
    const height = 2;
    const pixels = sceneLinearRgba(width, height);
    const bytes = await encodeToBytes(pixels, { ...BASE, width, height, compression: 'none' });
    const entries = entriesOf(bytes);

    expect(shorts(bytes, field(bytes, entries, 259))).toEqual([1]);
    expect(shorts(bytes, field(bytes, entries, 317))).toEqual([1]);

    // Read the strip with no un-predicting at all: the bytes are the samples.
    const offset = longs(bytes, field(bytes, entries, 273))[0];
    const byteCount = longs(bytes, field(bytes, entries, 279))[0];
    expect(byteCount).toBe(width * height * SAMPLES_PER_PIXEL * BYTES_PER_SAMPLE);
    const strip = bytes.subarray(offset, offset + byteCount);
    const view = viewOf(strip);
    const expected = Array.from(pixels).filter((_value, index) => index % 4 !== 3).map(floatToHalf);
    expect(Array.from({ length: expected.length }, (_, index) =>
      view.getUint16(index * 2, true))).toEqual(expected);
  });

  it('splits a wide image into planned strips whose offsets stay word-aligned', async () => {
    const width = 1024;
    const height = 700;
    const plan = planTiffStrips(width, height, 16);
    expect(plan.stripCount).toBeGreaterThan(1);

    const pixels = halfPatternRgba(width, height);
    const bytes = await encodeToBytes(pixels, { ...BASE, width, height });
    const entries = entriesOf(bytes);

    expect(longs(bytes, field(bytes, entries, 278))).toEqual([plan.rowsPerStrip]);
    expect(field(bytes, entries, 273)).toMatchObject({ type: 4, count: plan.stripCount });
    expect(field(bytes, entries, 279)).toMatchObject({ type: 4, count: plan.stripCount });
    const offsets = longs(bytes, field(bytes, entries, 273));
    const byteCounts = longs(bytes, field(bytes, entries, 279));
    for (let index = 0; index < offsets.length; index++) {
      expect(offsets[index] % 2).toBe(0);
      expect(offsets[index] + byteCounts[index]).toBeLessThanOrEqual(bytes.length);
      if (index > 0) {
        expect(offsets[index]).toBeGreaterThanOrEqual(offsets[index - 1] + byteCounts[index - 1]);
      }
    }
    expectSamples(decodeHalfSamples(bytes),
      [...pixels].filter((_value, index) => index % 4 !== 3));
  }, 20_000);

  it('falls back to uncompressed with a queryable warning when Deflate is unavailable', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const warnings: DngEncodeWarning[] = [];
    const width = 5;
    const height = 4;
    const pixels = sceneLinearRgba(width, height);
    const bytes = await encodeToBytes(pixels, {
      ...BASE, width, height, onWarning: (warning) => warnings.push(warning),
    });
    const entries = entriesOf(bytes);

    expect(shorts(bytes, field(bytes, entries, 259))).toEqual([1]);
    // A stale Predictor 3 on uncompressed data would scramble every reader.
    expect(shorts(bytes, field(bytes, entries, 317))).toEqual([1]);
    expect(warnings).toEqual([expect.objectContaining({
      code: 'deflate-unavailable',
      requestedCompression: 'deflate',
      actualCompression: 'none',
    })]);
    expectSamples(decodeHalfSamples(bytes),
      [...pixels].filter((_value, index) => index % 4 !== 3).map(floatToHalf));
  });

  it('is smaller than the same image uncompressed', async () => {
    const width = 256;
    const height = 128;
    const pixels = sceneLinearRgba(width, height);
    const plain = await encodeDng(pixels, { ...BASE, width, height, compression: 'none' });
    const deflated = await encodeDng(pixels, { ...BASE, width, height });
    expect(deflated.size).toBeLessThan(plain.size);
  });
});

describe('applyFloatingPointPredictor', () => {
  it('de-interleaves into byte planes, most significant first, then differences', () => {
    // Two pixels, three channels, one row: samples 0x1122 0x3344 0x5566 0x1126 …
    const samples = [0x1122, 0x3344, 0x5566, 0x1126, 0x3340, 0x5560];
    const row = new Uint8Array(samples.length * 2);
    const view = new DataView(row.buffer);
    samples.forEach((sample, index) => view.setUint16(index * 2, sample, true));

    applyFloatingPointPredictor(row, row.byteLength, SAMPLES_PER_PIXEL);

    // Plane 0 is every sample's high byte, plane 1 every low byte.
    const planes = [0x11, 0x33, 0x55, 0x11, 0x33, 0x55, 0x22, 0x44, 0x66, 0x26, 0x40, 0x60];
    const expected = planes.map((value, index) =>
      index < SAMPLES_PER_PIXEL ? value : (value - planes[index - SAMPLES_PER_PIXEL]) & 0xff);
    expect([...row]).toEqual(expected);
    // The high bytes of a smooth row turn into zeroes; that is the whole point.
    expect(expected.slice(SAMPLES_PER_PIXEL, 6)).toEqual([0, 0, 0]);
  });

  it('earns its place: the shuffled, differenced bytes deflate smaller', () => {
    const width = 512;
    const pixels = new Uint8Array(width * SAMPLES_PER_PIXEL * BYTES_PER_SAMPLE);
    const view = new DataView(pixels.buffer);
    for (let index = 0; index < width * SAMPLES_PER_PIXEL; index++) {
      view.setUint16(index * 2, floatToHalf(0.2 + (index % 97) / 900), true);
    }
    const plain = deflateSync(Buffer.from(pixels)).length;
    const predicted = Uint8Array.from(pixels);
    applyFloatingPointPredictor(predicted, pixels.length, SAMPLES_PER_PIXEL);
    expect(deflateSync(Buffer.from(predicted)).length).toBeLessThan(plain);
  });

  it('treats every row on its own so a strip boundary cannot shift the picture', () => {
    const bytesPerRow = SAMPLES_PER_PIXEL * BYTES_PER_SAMPLE * 2;
    const twoRows = new Uint8Array(bytesPerRow * 2);
    twoRows.set([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9], 0);
    twoRows.set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], bytesPerRow);
    const singleRow = twoRows.slice(bytesPerRow);

    applyFloatingPointPredictor(twoRows, bytesPerRow, SAMPLES_PER_PIXEL);
    applyFloatingPointPredictor(singleRow, bytesPerRow, SAMPLES_PER_PIXEL);
    expect([...twoRows.subarray(bytesPerRow)]).toEqual([...singleRow]);
  });
});

describe('colorMatrix1For', () => {
  it('is the output space primaries inverted, not the camera matrix', () => {
    // sRGB is the working space itself, so the matrix is plain XYZ to sRGB.
    expect(colorMatrix1For('srgb')).toEqual(COLOR_SPACES.srgb.fromXYZ);
    expect(colorMatrix1For('adobe-rgb')).not.toEqual(COLOR_SPACES.srgb.fromXYZ);
  });

  /**
   * The check above is a tautology for sRGB, whose output matrix is the
   * identity, and the white point check below holds for the inverse matrix
   * just as well. So this one measures against numbers from outside the
   * function: the Adobe RGB (1998) and ROMM RGB primaries.
   */
  it('equals the published XYZ-to-space matrices, value for value', () => {
    // COLOR_SPACES['adobe-rgb'].fromXYZ is the spec's own XYZ(D65) to linear
    // Adobe RGB matrix and no ingredient of colorMatrix1For. The residual 2e-4
    // is the four-decimal rounding in OUTPUT_COLOR_SPACES['adobe-rgb'].matrix.
    colorMatrix1For('adobe-rgb').forEach((value, index) => {
      expect(value).toBeCloseTo(COLOR_SPACES['adobe-rgb'].fromXYZ[index], 3);
    });

    // ProPhoto is D50-native, so its reference comes the long way round: the
    // spec's XYZ(D50) to ProPhoto matrix behind a Bradford adaptation of the
    // D65 white point. Agreement proves the output matrix carries that
    // adaptation and that composing it here did not undo it.
    const bradfordD65ToD50 = [
      1.0478112, 0.0228866, -0.0501270,
      0.0295424, 0.9904844, -0.0170491,
      -0.0092345, 0.0150436, 0.7521316,
    ];
    const prophoto = multiply3(COLOR_SPACES.prophoto.fromXYZ, bradfordD65ToD50);
    colorMatrix1For('prophoto').forEach((value, index) => {
      expect(value).toBeCloseTo(prophoto[index], 2);
    });

    // What those two assertions reject. Every one of these wrong forms passes
    // the other checks in this block, which is why it is measured here.
    const output = OUTPUT_COLOR_SPACES['adobe-rgb'].matrix;
    const wrong: Record<string, number[]> = {
      inverted: multiply3(invert3(output), COLOR_SPACES.srgb.fromXYZ),
      swapped: multiply3(COLOR_SPACES.srgb.fromXYZ, output),
      transposed: transpose3(colorMatrix1For('adobe-rgb')),
    };
    expect(Object.fromEntries(Object.entries(wrong).map(([name, matrix]) => [
      name,
      Math.max(...matrix.map((value, index) =>
        Math.abs(value - COLOR_SPACES['adobe-rgb'].fromXYZ[index]))) > 0.25,
    ]))).toEqual({ inverted: true, swapped: true, transposed: true });
  });

  it('maps the D65 white point to neutral, which is what makes AsShotNeutral (1,1,1) true', () => {
    const d65 = [0.95047, 1, 1.08883];
    for (const id of Object.keys(OUTPUT_COLOR_SPACES) as OutputColorSpaceId[]) {
      const matrix = colorMatrix1For(id);
      for (let row = 0; row < 3; row++) {
        const channel = matrix[row * 3] * d65[0] + matrix[row * 3 + 1] * d65[1] +
          matrix[row * 3 + 2] * d65[2];
        expect(channel).toBeCloseTo(1, 2);
      }
    }
  });

  /**
   * The card's acceptance test — "a foreign converter shows the file without a
   * colour cast" — as far as it can be computed without one. A DNG reader
   * inverts ColorMatrix1 to get camera native to XYZ, scales by AsShotNeutral
   * (ours is neutral, so not at all) and carries on into its display space.
   * Hand it our file and the pixels have to come back as they went in.
   */
  it('gives a reader its pixels back, where the inverted matrix would tint them', () => {
    const output = OUTPUT_COLOR_SPACES['adobe-rgb'].matrix;
    const read = (matrix: number[], sample: number[]): number[] =>
      apply3(multiply3(COLOR_SPACES.srgb.fromXYZ, invert3(matrix)), sample);

    for (const srgbLinear of [[1, 1, 1], [0.9, 0.2, 0.05], [0.04, 0.51, 0.33]]) {
      // What the encoder is handed: the render, already in the working space.
      const written = apply3(output, srgbLinear);
      read(colorMatrix1For('adobe-rgb'), written).forEach((value, channel) => {
        expect(value).toBeCloseTo(srgbLinear[channel], 6);
      });
    }

    // The same reader, handed the inverse. Neutral survives — that is why no
    // white point check finds this — but a saturated red loses a third of
    // itself, which is the plausible-looking shift the card warns about.
    const inverted = multiply3(invert3(output), COLOR_SPACES.srgb.fromXYZ);
    read(inverted, apply3(output, [1, 1, 1])).forEach((value) => {
      expect(value).toBeCloseTo(1, 3);
    });
    expect(read(inverted, apply3(output, [0.9, 0.2, 0.05]))[0]).toBeLessThan(0.9 - 0.3);
  });

  it('reaches the file as the hand-computed rationals over 10000', async () => {
    const bytes = await encodeToBytes(sceneLinearRgba(2, 2), {
      ...BASE, width: 2, height: 2, colorMatrix: colorMatrix1For('adobe-rgb'),
    });
    // XYZ(D65) to linear Adobe RGB, worked out from the two factors by hand and
    // rounded to the denominator Adobe uses. Nothing here is read back out of
    // the encoder.
    expect(fractions(bytes, field(bytes, entriesOf(bytes), 50721))).toEqual([
      [20415, 10_000], [-5651, 10_000], [-3447, 10_000],
      [-9693, 10_000], [18760, 10_000], [416, 10_000],
      [134, 10_000], [-1183, 10_000], [10154, 10_000],
    ]);
  });
});

describe('floatToHalf', () => {
  it('matches IEEE 754 binary16 at the values that decide a highlight', () => {
    expect(floatToHalf(0)).toBe(0x0000);
    expect(floatToHalf(-0)).toBe(0x8000);
    expect(floatToHalf(1)).toBe(0x3c00);
    expect(floatToHalf(0.5)).toBe(0x3800);
    expect(floatToHalf(-2)).toBe(0xc000);
    expect(floatToHalf(65504)).toBe(0x7bff);
    expect(floatToHalf(65536)).toBe(0x7c00);
    expect(floatToHalf(Infinity)).toBe(0x7c00);
    expect(floatToHalf(2 ** -24)).toBe(0x0001);
    expect(floatToHalf(2 ** -25)).toBe(0x0000);
    expect(floatToHalf(6.0975552e-5)).toBe(0x03ff);
    expect(floatToHalf(NaN) & 0x7c00).toBe(0x7c00);
    expect(floatToHalf(NaN) & 0x03ff).not.toBe(0);
  });

  it('round-trips through halfToFloat inside half precision', () => {
    for (const value of [0.1, 0.25, 1, 3.5, 100, 1024, 0.0001]) {
      expect(halfToFloat(floatToHalf(value))).toBeCloseTo(value, 3);
    }
  });
});
