import { deflateParts, PNG_SIGNATURE, pngChunk, pngIccChunk } from './PngChunks';

export interface Png16EncodeOptions {
  width: number;
  height: number;
  channels: 3 | 4;
}

export interface PngIccProfile {
  data: Uint8Array;
  name: string;
}

export async function encodePng16(
  pixels: Uint16Array,
  options: Png16EncodeOptions,
  iccProfile?: PngIccProfile,
): Promise<Blob> {
  const { width, height, channels } = options;
  assertGeometry(width, height);
  if (pixels.length !== width * height * channels) {
    throw new Error('encodePng16: pixel count does not match geometry and channels');
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 16;
  ihdr[9] = channels === 3 ? 2 : 6;

  const scanlines = function* (): Generator<Uint8Array> {
    const samplesPerRow = width * channels;
    for (let y = 0; y < height; y++) {
      const row = new Uint8Array(1 + samplesPerRow * 2);
      let destination = 1;
      const source = y * samplesPerRow;
      for (let index = 0; index < samplesPerRow; index++) {
        const sample = pixels[source + index];
        row[destination++] = sample >>> 8;
        row[destination++] = sample & 0xff;
      }
      yield row;
    }
  };

  const compressed = await deflateParts(scanlines());
  if (compressed.length === 0) {
    throw new Error('encodePng16: deflate produced no image data');
  }
  const parts: Uint8Array[] = [PNG_SIGNATURE, pngChunk('IHDR', ihdr)];
  if (iccProfile) parts.push(await pngIccChunk(iccProfile.data, iccProfile.name));
  for (const part of compressed) parts.push(pngChunk('IDAT', part));
  parts.push(pngChunk('IEND', new Uint8Array()));
  return new Blob(parts.map((part) => part.buffer as ArrayBuffer), { type: 'image/png' });
}

function assertGeometry(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > 0x7fffffff || height > 0x7fffffff) {
    throw new Error('encodePng16: width and height must be positive PNG dimensions');
  }
}
