/**
 * DNG as a real export format: `encodeFrame` end to end, on bytes.
 *
 * `encodeDng` had no production caller at all until this wiring - it was a
 * complete, tested encoder that nothing could reach. The tests that matter
 * here are therefore about the three hand-offs between the render path and
 * that encoder, each of which produces a valid file when it is wrong:
 *
 *  1. the samples must be linearised half-floats, not the display-referred
 *     unorm16 the 16-bit readback hands over;
 *  2. `ColorMatrix1` must come from the OUTPUT space, so it follows the
 *     frame's colour space rather than sitting at a constant;
 *  3. DNG must not be reachable at 8 bit, where there is nothing to encode.
 *
 * One pixel assertion compares the whole frame against `linearHalfSamples` -
 * that one asks whether the exporter calls the bridge at all. The next one
 * asserts a literal half-float pattern worked out from the transfer function
 * off-machine, so the file is checked against arithmetic rather than against
 * the production code that produced it.
 */
import { describe, expect, it } from 'vitest';

import { colorMatrix1For } from './DngEncoder';
import { linearHalfSamples } from './dngSamples';
import { encodeFrame, type RenderedFrame16 } from './Exporter';
import type { OutputColorSpaceId } from './outputColorSpaces';

const WIDTH = 3;
const HEIGHT = 2;

const TAG_IMAGE_WIDTH = 256;
const TAG_IMAGE_LENGTH = 257;
const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_STRIP_OFFSETS = 273;
const TAG_SOFTWARE = 305;
const TAG_STRIP_BYTE_COUNTS = 279;
const TAG_SAMPLE_FORMAT = 339;
const TAG_XMP = 700;
const TAG_UNIQUE_CAMERA_MODEL = 50708;
const TAG_COLOR_MATRIX_1 = 50721;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 };

interface Entry { at: number; type: number; count: number; value: number }

function frameOf(colorSpace: OutputColorSpaceId): RenderedFrame16 {
  const pixels = new Uint16Array(WIDTH * HEIGHT * 4);
  for (let index = 0; index < pixels.length; index++) {
    // Spread over the range, including both anchors, with a non-trivial alpha.
    pixels[index] = (index * 8191 + 137) % 65536;
  }
  pixels[0] = 0;
  pixels[4] = 65535;
  // Pixel 2 is half-scale in all three channels: the one code point whose
  // linearised value is far from its normalised one, and therefore the one
  // that can be asserted as a literal without reusing the conversion.
  pixels.fill(32768, 8, 11);
  pixels[11] = 65535;
  return { width: WIDTH, height: HEIGHT, pixels, bitDepth: 16, colorSpace };
}

function entriesOf(bytes: Uint8Array): Map<number, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);
  const entries = new Map<number, Entry>();
  for (let index = 0; index < count; index++) {
    const at = ifd + 2 + index * 12;
    entries.set(view.getUint16(at, true), {
      at,
      type: view.getUint16(at + 2, true),
      count: view.getUint32(at + 4, true),
      value: view.getUint32(at + 8, true),
    });
  }
  return entries;
}

function payload(bytes: Uint8Array, entry: Entry): DataView {
  const length = entry.count * TYPE_SIZE[entry.type];
  const start = length <= 4 ? entry.at + 8 : entry.value;
  return new DataView(bytes.buffer, bytes.byteOffset + start, length);
}

function get(bytes: Uint8Array, tag: number): Entry {
  const entry = entriesOf(bytes).get(tag);
  if (!entry) throw new Error(`tag ${tag} is missing from the DNG`);
  return entry;
}

function shorts(bytes: Uint8Array, tag: number): number[] {
  const entry = get(bytes, tag);
  const view = payload(bytes, entry);
  return Array.from({ length: entry.count }, (_, index) => view.getUint16(index * 2, true));
}

function longs(bytes: Uint8Array, tag: number): number[] {
  const entry = get(bytes, tag);
  const view = payload(bytes, entry);
  return Array.from({ length: entry.count }, (_, index) => view.getUint32(index * 4, true));
}

function ascii(bytes: Uint8Array, tag: number): string {
  const entry = get(bytes, tag);
  const view = payload(bytes, entry);
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength - 1);
  return new TextDecoder().decode(raw);
}

/** Signed rationals as their two written integers, never as a rounded quotient. */
function srationals(bytes: Uint8Array, tag: number): [number, number][] {
  const entry = get(bytes, tag);
  const view = payload(bytes, entry);
  return Array.from({ length: entry.count }, (_, index) => [
    view.getInt32(index * 8, true), view.getUint32(index * 8 + 4, true),
  ]);
}

/** Uncompressed strips, concatenated, read as little-endian half patterns. */
function halfSamplesOf(bytes: Uint8Array): Uint16Array {
  expect(shorts(bytes, TAG_COMPRESSION)).toEqual([1]);
  const offsets = longs(bytes, TAG_STRIP_OFFSETS);
  const counts = longs(bytes, TAG_STRIP_BYTE_COUNTS);
  const total = counts.reduce((sum, count) => sum + count, 0);
  const image = new Uint8Array(total);
  let at = 0;
  offsets.forEach((offset, index) => {
    image.set(bytes.subarray(offset, offset + counts[index]), at);
    at += counts[index];
  });
  const view = new DataView(image.buffer);
  const samples = new Uint16Array(total / 2);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = view.getUint16(index * 2, true);
  }
  return samples;
}

async function encodeToBytes(
  frame: RenderedFrame16,
  options: Partial<Parameters<typeof encodeFrame>[1]> = {},
): Promise<Uint8Array> {
  const blob = await encodeFrame(frame, {
    format: 'dng', quality: 92, tiffCompression: 'none', ...options,
  });
  return new Uint8Array(await blob.arrayBuffer());
}

describe('encodeFrame - DNG', () => {
  it('writes the linearised samples, not the display-referred readback', async () => {
    const frame = frameOf('srgb');
    const bytes = await encodeToBytes(frame);
    const expected = linearHalfSamples(frame.pixels, 'srgb');

    const written = halfSamplesOf(bytes);
    expect(written.length).toBe(WIDTH * HEIGHT * 3);
    let mismatch = -1;
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        if (written[pixel * 3 + channel] !== expected[pixel * 4 + channel]) {
          mismatch = pixel * 3 + channel;
          break;
        }
      }
      if (mismatch >= 0) break;
    }
    expect(mismatch === -1
      ? 'every sample linearised'
      : `sample ${mismatch}: wrote ${written[mismatch]}`).toBe('every sample linearised');

    // The anchors survive any transfer curve, so on their own they prove
    // geometry and nothing more.
    expect(written[0]).toBe(0x0000);
    expect(written[3]).toBe(0x3c00);
  });

  it('puts the linearised literal in the file, not the readback value', async () => {
    // Pixel 2 is unorm16 32768 in every channel. As light that is 0.21399 in
    // sRGB (0x32D9) and 0.21765 under Adobe RGB's power 2.2 (0x32F7). The
    // readback value itself, 32768/65535, would be half 0x3800 - the one
    // number that says the conversion never happened. Worked out from the
    // transfer functions, so this holds even when `linearHalfSamples` is the
    // thing that is wrong.
    expect([...halfSamplesOf(await encodeToBytes(frameOf('srgb'))).subarray(6, 9)])
      .toEqual([0x32d9, 0x32d9, 0x32d9]);
    expect([...halfSamplesOf(await encodeToBytes(frameOf('adobe-rgb'))).subarray(6, 9)])
      .toEqual([0x32f7, 0x32f7, 0x32f7]);
  });

  it('declares LinearRaw and half floats, which is what makes it a negative', async () => {
    const bytes = await encodeToBytes(frameOf('srgb'));
    expect(shorts(bytes, TAG_PHOTOMETRIC)).toEqual([34892]);
    expect(shorts(bytes, TAG_SAMPLE_FORMAT)).toEqual([3, 3, 3]);
    expect(longs(bytes, TAG_IMAGE_WIDTH)).toEqual([WIDTH]);
    expect(longs(bytes, TAG_IMAGE_LENGTH)).toEqual([HEIGHT]);
  });

  it('takes ColorMatrix1 from the frame colour space, never from a camera', async () => {
    // The trap this closes: RawPixelData carries fields of the same name that
    // hold the CAMERA matrix. Feeding those in makes a reader apply the
    // transform a second time - plausible picture, wrong colours, no error.
    for (const id of ['srgb', 'adobe-rgb'] as const) {
      const bytes = await encodeToBytes(frameOf(id));
      const written = srationals(bytes, TAG_COLOR_MATRIX_1);
      expect(written).toHaveLength(9);
      const expected = colorMatrix1For(id);
      written.forEach(([numerator, denominator], index) => {
        expect(denominator).toBe(10_000);
        expect(numerator).toBe(Math.round(expected[index] * 10_000));
      });
    }

    const srgb = srationals(await encodeToBytes(frameOf('srgb')), TAG_COLOR_MATRIX_1);
    const adobe = srationals(await encodeToBytes(frameOf('adobe-rgb')), TAG_COLOR_MATRIX_1);
    expect(adobe).not.toEqual(srgb);
  });

  it('names the virtual camera after the space its matrix describes', async () => {
    expect(ascii(await encodeToBytes(frameOf('srgb')), TAG_UNIQUE_CAMERA_MODEL))
      .toBe('UnifyRAW Linear sRGB');
    expect(ascii(await encodeToBytes(frameOf('adobe-rgb')), TAG_UNIQUE_CAMERA_MODEL))
      .toBe('UnifyRAW Linear Adobe RGB');
  });

  it('carries the export metadata a DNG has room for', async () => {
    const bytes = await encodeToBytes(frameOf('srgb'), {
      metadata: { software: 'UnifyRAW', xmp: '<x:xmpmeta/>', dateTaken: 1_700_000_000_000 },
    });
    expect(ascii(bytes, TAG_SOFTWARE)).toBe('UnifyRAW');
    const xmp = get(bytes, TAG_XMP);
    const view = payload(bytes, xmp);
    expect(new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)))
      .toBe('<x:xmpmeta/>');
  });

  it('leaves out an empty XMP packet instead of writing a zero-length tag', async () => {
    const bytes = await encodeToBytes(frameOf('srgb'), { metadata: { xmp: '', software: '' } });
    expect(entriesOf(bytes).has(TAG_XMP)).toBe(false);
    expect(entriesOf(bytes).has(TAG_SOFTWARE)).toBe(false);
  });

  it('defaults to Deflate and honours the compression switch', async () => {
    const deflated = await encodeToBytes(frameOf('srgb'), { tiffCompression: undefined });
    expect(shorts(deflated, TAG_COMPRESSION)).toEqual([8]);
    const plain = await encodeToBytes(frameOf('srgb'));
    expect(shorts(plain, TAG_COMPRESSION)).toEqual([1]);
  });

  it('refuses DNG for an 8-bit frame, where there is nothing to encode', async () => {
    const frame = { width: 1, height: 1, pixels: new Uint8Array(4), colorSpace: 'srgb' } as const;
    await expect(encodeFrame(frame, { format: 'dng', quality: 92 }))
      .rejects.toThrow(/16-bit format/);
  });

  it('keeps the 16-bit watermark refusal', async () => {
    await expect(encodeToBytes(frameOf('srgb'), { watermark: 'x' }))
      .rejects.toThrow(/watermark/);
  });
});
