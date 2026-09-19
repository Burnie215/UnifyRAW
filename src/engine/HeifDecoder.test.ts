import { describe, expect, it } from 'vitest';
import { HeifDecoder } from './HeifDecoder';

describe('HeifDecoder detection', () => {
  it('recognizes Sony .HIF names case-insensitively', () => {
    expect(HeifDecoder.isHeifFile('DSC01234.HIF')).toBe(true);
    expect(HeifDecoder.isHeifFile('photo.heic')).toBe(true);
    expect(HeifDecoder.isHeifFile('photo.jpg')).toBe(false);
  });

  it('recognizes HEIF from a compatible ftyp brand', async () => {
    const bytes = new Uint8Array(24);
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    writeAscii(bytes, 4, 'ftyp');
    writeAscii(bytes, 8, 'sony');
    writeAscii(bytes, 16, 'mif1');
    writeAscii(bytes, 20, 'heic');
    const file = new File([bytes], 'unknown.bin');
    expect(await HeifDecoder.sniffHeif(file)).toBe(true);
  });

  it('does not misclassify an unrelated ISO BMFF file', async () => {
    const bytes = new Uint8Array(20);
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    writeAscii(bytes, 4, 'ftyp');
    writeAscii(bytes, 8, 'mp42');
    writeAscii(bytes, 16, 'isom');
    const file = new File([bytes], 'video.mp4');
    expect(await HeifDecoder.sniffHeif(file)).toBe(false);
  });
});

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++) {
    target[offset + index] = value.charCodeAt(index);
  }
}
