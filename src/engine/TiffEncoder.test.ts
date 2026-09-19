import { inflateSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  encodeTiff,
  planTiffStrips,
  TIFF_TARGET_STRIP_BYTES,
  type TiffEncodeWarning,
} from './TiffEncoder';

interface TiffEntry {
  type: number;
  count: number;
  value: number;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function entriesOf(bytes: Uint8Array): Map<number, TiffEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);
  const entries = new Map<number, TiffEntry>();
  for (let index = 0; index < count; index++) {
    const offset = ifd + 2 + index * 12;
    entries.set(view.getUint16(offset, true), {
      type: view.getUint16(offset + 2, true),
      count: view.getUint32(offset + 4, true),
      value: view.getUint32(offset + 8, true),
    });
  }
  return entries;
}

function shorts(bytes: Uint8Array, entry: TiffEntry): number[] {
  if (entry.count <= 2) {
    return Array.from({ length: entry.count }, (_, index) => (entry.value >>> (index * 16)) & 0xffff);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: entry.count }, (_, index) =>
    view.getUint16(entry.value + index * 2, true));
}

function longs(bytes: Uint8Array, entry: TiffEntry): number[] {
  if (entry.count === 1) return [entry.value];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: entry.count }, (_, index) =>
    view.getUint32(entry.value + index * 4, true));
}

function decodeRgb(bytes: Uint8Array): Uint8Array | Uint16Array {
  const entries = entriesOf(bytes);
  const compression = shorts(bytes, entries.get(259)!)[0];
  const bits = shorts(bytes, entries.get(258)!)[0];
  const offsets = longs(bytes, entries.get(273)!);
  const byteCounts = longs(bytes, entries.get(279)!);
  const decoded: Uint8Array[] = offsets.map((offset, index) => {
    const encoded = bytes.subarray(offset, offset + byteCounts[index]);
    if (compression === 1) return Uint8Array.from(encoded);
    if (compression === 8) return Uint8Array.from(inflateSync(encoded));
    throw new Error(`unsupported test compression ${compression}`);
  });
  const packed = new Uint8Array(decoded.reduce((sum, strip) => sum + strip.length, 0));
  let destination = 0;
  for (const strip of decoded) {
    packed.set(strip, destination);
    destination += strip.length;
  }
  if (bits === 8) return packed;
  const samples = new Uint16Array(packed.length / 2);
  const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = view.getUint16(index * 2, true);
  }
  return samples;
}

function rgba16(width: number, height: number): Uint16Array {
  const pixels = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      pixels[offset] = (x * 61 + y * 3) & 0xffff;
      pixels[offset + 1] = (x * 17 + y * 29 + 1234) & 0xffff;
      pixels[offset + 2] = (65535 - x * 11 - y * 7) & 0xffff;
      pixels[offset + 3] = 65535;
    }
  }
  return pixels;
}

describe('encodeTiff', () => {
  it('uses one strict API for 8-bit and 16-bit RGBA pixels', async () => {
    const eight = await encodeTiff(new Uint8ClampedArray([1, 2, 3, 4]), {
      width: 1, height: 1, bits: 8, compression: 'none',
    });
    const eightBytes = new Uint8Array(await eight.arrayBuffer());
    const eightEntries = entriesOf(eightBytes);
    expect([...eightBytes.subarray(0, 4)]).toEqual([0x49, 0x49, 0x2a, 0]);
    expect(shorts(eightBytes, eightEntries.get(258)!)).toEqual([8, 8, 8]);
    expect(eightEntries.has(339)).toBe(false);

    await expect(encodeTiff(new Uint8Array(4), {
      width: 1, height: 1, bits: 16, compression: 'none',
    })).rejects.toThrow(/requires Uint16Array/);
    await expect(encodeTiff(new Uint16Array(4), {
      width: 1, height: 1, bits: 8, compression: 'none',
    })).rejects.toThrow(/requires byte pixels/);
  });

  it('writes unsigned little-endian RGB16 samples, ICC, and more than 256 levels', async () => {
    const width = 512;
    const pixels = rgba16(width, 1);
    const profile = new Uint8Array([11, 22, 33, 44, 55]);
    const blob = await encodeTiff(pixels, {
      width, height: 1, bits: 16, compression: 'none',
    }, profile);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const entries = entriesOf(bytes);
    expect(shorts(bytes, entries.get(258)!)).toEqual([16, 16, 16]);
    expect(shorts(bytes, entries.get(339)!)).toEqual([1, 1, 1]);
    expect(shorts(bytes, entries.get(259)!)).toEqual([1]);
    const icc = entries.get(34675)!;
    expect([...bytes.subarray(icc.value, icc.value + icc.count)]).toEqual([...profile]);

    const channels = [0, 1, 2].map((channel) =>
      Array.from(decodeRgb(bytes)).filter((_value, index) => index % 3 === channel));
    for (let channel = 0; channel < 3; channel++) {
      expect(channels[channel]).toEqual(
        Array.from({ length: width }, (_, x) => pixels[x * 4 + channel]),
      );
      expect(new Set(channels[channel]).size).toBeGreaterThan(256);
    }
    expect(channels[0].some((value) => value % 257 !== 0)).toBe(true);
  });

  it('round-trips exact RGB8 samples through Adobe Deflate', async () => {
    const pixels = new Uint8ClampedArray([
      0, 1, 2, 3,
      127, 128, 129, 130,
      253, 254, 255, 17,
      44, 55, 66, 77,
      88, 99, 111, 122,
      133, 144, 155, 166,
    ]);
    const blob = await encodeTiff(pixels, {
      width: 3, height: 2, bits: 8, compression: 'deflate',
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    expect(shorts(bytes, entriesOf(bytes).get(259)!)).toEqual([8]);
    expect(Array.from(decodeRgb(bytes))).toEqual(
      Array.from(pixels).filter((_value, index) => index % 4 !== 3),
    );
  });

  it('writes real zlib Deflate strips whose decoded pixels equal uncompressed TIFF', async () => {
    const width = 1024;
    const height = 700;
    const pixels = rgba16(width, height);
    const nativeCompressionStream = CompressionStream;
    const requestedFormats: string[] = [];
    class RecordingCompressionStream {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<BufferSource>;

      constructor(format: CompressionFormat) {
        requestedFormats.push(format);
        const stream = new nativeCompressionStream(format);
        this.readable = stream.readable;
        this.writable = stream.writable;
      }
    }
    vi.stubGlobal('CompressionStream', RecordingCompressionStream);

    const plainBlob = await encodeTiff(pixels, { width, height, bits: 16, compression: 'none' });
    const deflateBlob = await encodeTiff(pixels, { width, height, bits: 16, compression: 'deflate' });
    const plain = new Uint8Array(await plainBlob.arrayBuffer());
    const deflated = new Uint8Array(await deflateBlob.arrayBuffer());
    const plan = planTiffStrips(width, height, 16);

    for (const [bytes, expectedCompression] of [[plain, 1], [deflated, 8]] as const) {
      const entries = entriesOf(bytes);
      expect(shorts(bytes, entries.get(259)!)).toEqual([expectedCompression]);
      expect(entries.get(278)).toMatchObject({ type: 4, count: 1, value: plan.rowsPerStrip });
      expect(entries.get(273)).toMatchObject({ type: 4, count: plan.stripCount });
      expect(entries.get(279)).toMatchObject({ type: 4, count: plan.stripCount });
      const offsets = longs(bytes, entries.get(273)!);
      const byteCounts = longs(bytes, entries.get(279)!);
      expect(offsets).toHaveLength(plan.stripCount);
      expect(byteCounts).toHaveLength(plan.stripCount);
      for (let index = 0; index < offsets.length; index++) {
        expect(offsets[index] % 2).toBe(0);
        expect(offsets[index] + byteCounts[index]).toBeLessThanOrEqual(bytes.length);
        if (index > 0) {
          expect(offsets[index]).toBeGreaterThanOrEqual(offsets[index - 1] + byteCounts[index - 1]);
        }
      }
    }

    expect(requestedFormats).toEqual(Array(plan.stripCount).fill('deflate'));
    expect(deflateBlob.size).toBeLessThan(plainBlob.size);
    const plainPixels = decodeRgb(plain);
    const deflatePixels = decodeRgb(deflated);
    expect(deflatePixels.length).toBe(plainPixels.length);
    let mismatch = -1;
    for (let index = 0; index < plainPixels.length; index++) {
      const source = Math.floor(index / 3) * 4 + index % 3;
      if (plainPixels[index] !== deflatePixels[index] || plainPixels[index] !== pixels[source]) {
        mismatch = index;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  }, 20_000);

  it('falls back to uncompressed with a queryable warning when Deflate is unavailable', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const warnings: TiffEncodeWarning[] = [];
    const pixels = rgba16(3, 2);
    const blob = await encodeTiff(pixels, {
      width: 3,
      height: 2,
      bits: 16,
      compression: 'deflate',
      onWarning: (warning) => warnings.push(warning),
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());

    expect(shorts(bytes, entriesOf(bytes).get(259)!)).toEqual([1]);
    expect(warnings).toEqual([expect.objectContaining({
      code: 'deflate-unavailable',
      requestedCompression: 'deflate',
      actualCompression: 'none',
    })]);
    expect(Array.from(decodeRgb(bytes))).toEqual(
      Array.from(pixels).filter((_value, index) => index % 4 !== 3),
    );
  });

  it('plans a 45-MP TIFF without allocating a full image fixture', () => {
    const width = 8256;
    const height = 5504;
    const plan = planTiffStrips(width, height, 16);

    expect(width * height).toBeGreaterThan(45_000_000);
    expect(plan).toEqual({
      bytesPerRow: 49_536,
      rowsPerStrip: 84,
      stripCount: 66,
      maxStripBytes: 4_161_024,
    });
    expect(plan.maxStripBytes).toBeLessThanOrEqual(TIFF_TARGET_STRIP_BYTES);
  });

  it('composes the result from per-strip Blobs without reading all strips back', async () => {
    const NativeBlob = Blob;
    const arrayBuffer = vi.spyOn(NativeBlob.prototype, 'arrayBuffer');
    const constructions: BlobPart[][] = [];
    class RecordingBlob extends NativeBlob {
      constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
        super(parts, options);
        constructions.push([...parts]);
      }
    }
    vi.stubGlobal('Blob', RecordingBlob);
    const width = 1024;
    const height = 700;
    const plan = planTiffStrips(width, height, 16);

    await encodeTiff(rgba16(width, height), {
      width, height, bits: 16, compression: 'none',
    });

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(constructions).toHaveLength(plan.stripCount + 1);
    for (const stripParts of constructions.slice(0, plan.stripCount)) {
      expect(stripParts).toHaveLength(1);
      expect(stripParts[0]).toBeInstanceOf(ArrayBuffer);
      expect((stripParts[0] as ArrayBuffer).byteLength).toBeLessThanOrEqual(TIFF_TARGET_STRIP_BYTES);
    }
    const finalParts = constructions.at(-1)!;
    expect(finalParts.filter((part) => part instanceof RecordingBlob)).toHaveLength(plan.stripCount);
    expect(finalParts.filter((part) => part instanceof ArrayBuffer && part.byteLength > 1)).toHaveLength(1);
  });
});
