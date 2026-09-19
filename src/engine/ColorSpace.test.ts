import { describe, expect, it } from 'vitest';
import { convertImageData16 } from './ColorSpace';

describe('convertImageData16', () => {
  it('keeps more than 256 distinct intermediate levels and preserves alpha', () => {
    const pixels = new Uint16Array(1024 * 4);
    for (let i = 0; i < 1024; i++) {
      const value = i * 64;
      pixels[i * 4] = value;
      pixels[i * 4 + 1] = value;
      pixels[i * 4 + 2] = value;
      pixels[i * 4 + 3] = 40000 + (i % 100);
    }
    const alpha = pixels.filter((_, index) => index % 4 === 3);

    convertImageData16(pixels, 'srgb', 'adobe-rgb');

    const red = pixels.filter((_, index) => index % 4 === 0);
    expect(new Set(red).size).toBeGreaterThan(256);
    expect(red.some((value) => value % 257 !== 0)).toBe(true);
    expect(pixels.filter((_, index) => index % 4 === 3)).toEqual(alpha);
  });
});
