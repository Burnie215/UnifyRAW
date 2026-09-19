import { buildExifBlock, type ExportMetadata } from './exportMetadata';

const PNG_SIGNATURE_BYTES = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export const PNG_SIGNATURE = new Uint8Array(PNG_SIGNATURE_BYTES);

/** PNG signature (8) plus the IHDR chunk, which is always 4+4+13+4 bytes. */
const IHDR_END = 8 + 25;

/** The keyword PNG reserves for an XMP packet (XMP spec, part 3). */
const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp';

export function isPng(data: Uint8Array): boolean {
  return data.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((value, index) => data[index] === value);
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  if (!/^[A-Za-z]{4}$/.test(type)) {
    throw new Error('PNG chunk type must contain exactly four ASCII letters');
  }
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)), false);
  return chunk;
}

export function pngIccChunk(
  iccProfile: Uint8Array,
  profileName: string,
): Promise<Uint8Array> {
  const name = pngKeyword(profileName);
  return deflateParts([iccProfile]).then((compressedParts) => {
    const compressedLength = compressedParts.reduce((sum, part) => sum + part.length, 0);
    const data = new Uint8Array(name.length + 2 + compressedLength);
    data.set(name);
    data[name.length] = 0;
    data[name.length + 1] = 0;
    let offset = name.length + 2;
    for (const part of compressedParts) {
      data.set(part, offset);
      offset += part.length;
    }
    return pngChunk('iCCP', data);
  });
}

/**
 * An uncompressed `iTXt` chunk holding an XMP packet. Uncompressed because
 * that is what the XMP specification prescribes for this keyword, and what
 * every reader (exifr included) looks for.
 */
export function pngXmpChunk(xmp: string): Uint8Array {
  const keyword = new TextEncoder().encode(PNG_XMP_KEYWORD);
  const packet = new TextEncoder().encode(xmp);
  // keyword \0 compressionFlag compressionMethod languageTag \0 translatedKeyword \0 text
  const data = new Uint8Array(keyword.length + 5 + packet.length);
  data.set(keyword, 0);
  data.set(packet, keyword.length + 5);
  return pngChunk('iTXt', data);
}

/** Embed an ICC profile into a PNG file via iCCP chunk. */
export async function embedIccInPng(
  pngBlob: Blob,
  iccProfile: Uint8Array,
  profileName: string,
): Promise<Blob> {
  const data = new Uint8Array(await pngBlob.arrayBuffer());
  if (!isPng(data) || data.length < IHDR_END) return pngBlob;
  // PNG requires the iCCP payload itself to be a zlib stream.
  try {
    return insertAfterIhdr(data, await pngIccChunk(iccProfile, profileName));
  } catch {
    return pngBlob; // Compression not available
  }
}

/** Embed an XMP packet into a PNG file via an `iTXt` chunk before IDAT. */
export async function embedXmpInPng(pngBlob: Blob, xmp: string): Promise<Blob> {
  const data = new Uint8Array(await pngBlob.arrayBuffer());
  if (!isPng(data) || data.length < IHDR_END) return pngBlob;
  return insertAfterIhdr(data, pngXmpChunk(xmp));
}

/**
 * Embed capture time and writer via an `eXIf` chunk (PNG 1.5), which carries
 * the same TIFF block JPEG puts in APP1. No-op without either field.
 */
export async function embedExifInPng(pngBlob: Blob, metadata: ExportMetadata): Promise<Blob> {
  const block = buildExifBlock(metadata);
  if (!block) return pngBlob;
  const data = new Uint8Array(await pngBlob.arrayBuffer());
  if (!isPng(data) || data.length < IHDR_END) return pngBlob;
  return insertAfterIhdr(data, pngChunk('eXIf', block));
}

/** IHDR is always the first chunk, so this is also "before IDAT". */
function insertAfterIhdr(data: Uint8Array, chunk: Uint8Array): Blob {
  const result = new Uint8Array(data.length + chunk.length);
  result.set(data.subarray(0, IHDR_END), 0);
  result.set(chunk, IHDR_END);
  result.set(data.subarray(IHDR_END), IHDR_END + chunk.length);
  return new Blob([result], { type: 'image/png' });
}

export async function deflateParts(parts: Iterable<Uint8Array>): Promise<Uint8Array[]> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('Deflate compression is unavailable in this browser');
  }
  const stream = new CompressionStream('deflate');
  const reader = stream.readable.getReader();
  const reading = (async () => {
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) return chunks;
      chunks.push(value);
    }
  })();
  const writer = stream.writable.getWriter();
  try {
    for (const part of parts) {
      await writer.write(part as unknown as BufferSource);
    }
    await writer.close();
    return await reading;
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await reading.catch(() => undefined);
    throw error;
  }
}

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const value of data) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngKeyword(value: string): Uint8Array {
  if (value.length < 1 || value.length > 79 || value.startsWith(' ') || value.endsWith(' ') ||
      value.includes('  ')) {
    throw new Error('PNG ICC profile name is not a valid PNG keyword');
  }
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 32 && code <= 126) || (code >= 161 && code <= 255))) {
      throw new Error('PNG ICC profile name is not a valid PNG keyword');
    }
    bytes[index] = code;
  }
  return bytes;
}
