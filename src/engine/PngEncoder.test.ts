import { describe, expect, it } from 'vitest';

import { encodePng16 } from './PngEncoder';

interface ParsedChunk {
  type: string;
  data: Uint8Array;
  crc: number;
  crcInput: Uint8Array;
}

function chunksOf(bytes: Uint8Array): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset, false);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('Truncated PNG chunk');
    chunks.push({
      type: new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8)),
      data: bytes.subarray(offset + 8, offset + 8 + length),
      crc: view.getUint32(offset + 8 + length, false),
      crcInput: bytes.subarray(offset + 4, offset + 8 + length),
    });
    offset = end;
  }
  return chunks;
}

async function inflate(parts: Uint8Array[]): Promise<Uint8Array> {
  const compressed = new Blob(parts.map((part) => part.slice().buffer)).stream();
  const output = compressed.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(output).arrayBuffer());
}

function referenceCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) * 0xedb88320);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('encodePng16', () => {
  it('writes big-endian RGBA16 scanlines with valid chunks and more than 256 levels', async () => {
    const width = 512;
    const pixels = new Uint16Array(width * 4);
    for (let x = 0; x < width; x++) {
      const value = Math.round(x * 65535 / (width - 1));
      pixels[x * 4] = value;
      pixels[x * 4 + 1] = 65535 - value;
      pixels[x * 4 + 2] = value ^ 0x55aa;
      pixels[x * 4 + 3] = 65535;
    }

    const blob = await encodePng16(pixels, { width, height: 1, channels: 4 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const chunks = chunksOf(bytes);
    expect(chunks[0].type).toBe('IHDR');
    expect(chunks.at(-1)?.type).toBe('IEND');
    expect(chunks.slice(1, -1).every((chunk) => chunk.type === 'IDAT')).toBe(true);
    for (const chunk of chunks) expect(chunk.crc).toBe(referenceCrc32(chunk.crcInput));

    const ihdr = chunks[0].data;
    const ihdrView = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
    expect([ihdrView.getUint32(0, false), ihdrView.getUint32(4, false)]).toEqual([512, 1]);
    expect(ihdr[8]).toBe(16);
    expect(ihdr[9]).toBe(6);

    const scanline = await inflate(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
    expect(scanline).toHaveLength(1 + width * 4 * 2);
    expect(scanline[0]).toBe(0);
    const samples = new DataView(scanline.buffer, scanline.byteOffset + 1, scanline.byteLength - 1);
    const channels = [0, 1, 2].map((channel) =>
      Array.from({ length: width }, (_, x) => samples.getUint16(x * 8 + channel * 2, false)));
    for (const values of channels) expect(new Set(values).size).toBeGreaterThan(256);
    expect(channels[0].some((value) => value % 257 !== 0)).toBe(true);
    for (let channel = 0; channel < 3; channel++) {
      expect(channels[channel]).toEqual(
        Array.from({ length: width }, (_, x) => pixels[x * 4 + channel]),
      );
    }
  });

  it('writes RGB color type 2 and a compressed ICC profile before IDAT', async () => {
    const pixels = new Uint16Array([0x0102, 0x3456, 0xabcd, 0x789a, 0xbcde, 0xffff]);
    const profile = new Uint8Array([0, 1, 2, 3, 0xfe, 0xff]);
    const blob = await encodePng16(
      pixels,
      { width: 2, height: 1, channels: 3 },
      { data: profile, name: 'Test RGB' },
    );
    const chunks = chunksOf(new Uint8Array(await blob.arrayBuffer()));
    expect(chunks.slice(0, 2).map((chunk) => chunk.type)).toEqual(['IHDR', 'iCCP']);
    expect(chunks.at(-1)?.type).toBe('IEND');
    expect(chunks.slice(2, -1).every((chunk) => chunk.type === 'IDAT')).toBe(true);
    expect(chunks[0].data[9]).toBe(2);

    const iccp = chunks[1].data;
    const nameEnd = iccp.indexOf(0);
    expect(new TextDecoder().decode(iccp.subarray(0, nameEnd))).toBe('Test RGB');
    expect(iccp[nameEnd + 1]).toBe(0);
    expect(await inflate([iccp.subarray(nameEnd + 2)])).toEqual(profile);

    const scanline = await inflate(chunks.filter((chunk) => chunk.type === 'IDAT')
      .map((chunk) => chunk.data));
    expect([...scanline]).toEqual([0, 1, 2, 52, 86, 171, 205, 120, 154, 188, 222, 255, 255]);
  });

  it('starts every image row with its own filter byte and advances the source row', async () => {
    const width = 3;
    const height = 2;
    const channels = 4;
    const pixels = new Uint16Array([
      0x0102, 0x0304, 0x0506, 0x0708,
      0x1112, 0x1314, 0x1516, 0x1718,
      0x2122, 0x2324, 0x2526, 0x2728,
      0xa1a2, 0xa3a4, 0xa5a6, 0xa7a8,
      0xb1b2, 0xb3b4, 0xb5b6, 0xb7b8,
      0xc1c2, 0xc3c4, 0xc5c6, 0xc7c8,
    ]);
    const blob = await encodePng16(pixels, { width, height, channels });
    const chunks = chunksOf(new Uint8Array(await blob.arrayBuffer()));
    const scanlines = await inflate(chunks.filter((chunk) => chunk.type === 'IDAT')
      .map((chunk) => chunk.data));
    const rowLength = 1 + width * channels * 2;
    expect(scanlines).toHaveLength(rowLength * height);
    expect([scanlines[0], scanlines[rowLength]]).toEqual([0, 0]);

    const decoded: number[] = [];
    for (let row = 0; row < height; row++) {
      const view = new DataView(
        scanlines.buffer,
        scanlines.byteOffset + row * rowLength + 1,
        rowLength - 1,
      );
      for (let sample = 0; sample < width * channels; sample++) {
        decoded.push(view.getUint16(sample * 2, false));
      }
    }
    expect(decoded).toEqual([...pixels]);
    expect(decoded.slice(width * channels - 4, width * channels + 4)).toEqual([
      0x2122, 0x2324, 0x2526, 0x2728,
      0xa1a2, 0xa3a4, 0xa5a6, 0xa7a8,
    ]);
  });

  it('fails instead of fabricating an image when deflate is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream');
    Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, value: undefined });
    try {
      await expect(encodePng16(new Uint16Array([0, 0, 0, 65535]), {
        width: 1, height: 1, channels: 4,
      })).rejects.toThrow(/Deflate compression is unavailable/);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'CompressionStream', descriptor);
      else Reflect.deleteProperty(globalThis, 'CompressionStream');
    }
  });
});
