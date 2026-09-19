/** WebP RIFF container surgery. Today: tagging an encoded frame with ICC. */

interface WebpChunk {
  type: string;
  offset: number;
  dataOffset: number;
  size: number;
  nextOffset: number;
}

/** Embed an ICC profile into a WebP RIFF container. */
export async function embedIccInWebp(webpBlob: Blob, iccProfile: Uint8Array): Promise<Blob> {
  const data = new Uint8Array(await webpBlob.arrayBuffer());
  if (data.length < 12 || ascii(data, 0, 4) !== 'RIFF' || ascii(data, 8, 4) !== 'WEBP') {
    return webpBlob;
  }

  const previousProfile = webpChunks(data).find((chunk) => chunk.type === 'ICCP');
  const source = previousProfile
    ? joinBytes(data.subarray(0, previousProfile.offset), data.subarray(previousProfile.nextOffset))
    : data;
  const chunks = webpChunks(source);
  const extended = chunks.find((chunk) => chunk.type === 'VP8X');
  let prepared: Uint8Array;
  let insertAt: number;

  if (extended && extended.size >= 10) {
    prepared = new Uint8Array(source);
    prepared[extended.dataOffset] |= 0x20;
    insertAt = extended.nextOffset;
  } else {
    const dimensions = webpDimensions(source, chunks);
    if (!dimensions) return webpBlob;
    const vp8x = webpChunk('VP8X', webpExtendedHeader(dimensions.width, dimensions.height));
    prepared = joinBytes(source.subarray(0, 12), vp8x, source.subarray(12));
    insertAt = 12 + vp8x.length;
  }

  const result = joinBytes(
    prepared.subarray(0, insertAt),
    webpChunk('ICCP', iccProfile),
    prepared.subarray(insertAt),
  );
  new DataView(result.buffer).setUint32(4, result.length - 8, true);
  return new Blob([result.buffer as ArrayBuffer], { type: 'image/webp' });
}

function webpChunks(data: Uint8Array): WebpChunk[] {
  const chunks: WebpChunk[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let offset = 12; offset + 8 <= data.length;) {
    const size = view.getUint32(offset + 4, true);
    const nextOffset = offset + 8 + size + (size & 1);
    if (nextOffset > data.length) break;
    chunks.push({ type: ascii(data, offset, 4), offset, dataOffset: offset + 8, size, nextOffset });
    offset = nextOffset;
  }
  return chunks;
}

function webpDimensions(
  data: Uint8Array,
  chunks: WebpChunk[],
): { width: number; height: number } | null {
  const lossy = chunks.find((chunk) => chunk.type === 'VP8 ');
  if (lossy && lossy.size >= 10) {
    const at = lossy.dataOffset;
    if (data[at + 3] === 0x9d && data[at + 4] === 0x01 && data[at + 5] === 0x2a) {
      return {
        width: (data[at + 6] | (data[at + 7] << 8)) & 0x3fff,
        height: (data[at + 8] | (data[at + 9] << 8)) & 0x3fff,
      };
    }
  }

  const lossless = chunks.find((chunk) => chunk.type === 'VP8L');
  if (lossless && lossless.size >= 5 && data[lossless.dataOffset] === 0x2f) {
    const at = lossless.dataOffset;
    return {
      width: 1 + data[at + 1] + ((data[at + 2] & 0x3f) << 8),
      height: 1 + (data[at + 2] >> 6) + (data[at + 3] << 2) + ((data[at + 4] & 0x0f) << 10),
    };
  }
  return null;
}

function webpExtendedHeader(width: number, height: number): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = 0x20;
  writeUint24(data, 4, width - 1);
  writeUint24(data, 7, height - 1);
  return data;
}

function webpChunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(8 + data.length + (data.length & 1));
  result.set(new TextEncoder().encode(type), 0);
  new DataView(result.buffer).setUint32(4, data.length, true);
  result.set(data, 8);
  return result;
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function writeUint24(data: Uint8Array, offset: number, value: number): void {
  data[offset] = value & 0xff;
  data[offset + 1] = (value >> 8) & 0xff;
  data[offset + 2] = (value >> 16) & 0xff;
}
