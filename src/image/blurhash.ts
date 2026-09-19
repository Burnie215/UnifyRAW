/**
 * BlurHash wrapper — uses the official blurhash library.
 * https://github.com/woltapp/blurhash (MIT)
 */

import { encode, decode } from 'blurhash';

/**
 * Encode an image to a BlurHash string.
 */
export function encodeBlurHash(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  componentX = 4,
  componentY = 3,
): string {
  return encode(pixels, width, height, componentX, componentY);
}

/**
 * Decode a BlurHash to pixel data (Uint8ClampedArray RGBA).
 */
export function decodeBlurHash(hash: string, width: number, height: number): Uint8ClampedArray {
  return decode(hash, width, height) as Uint8ClampedArray;
}

/**
 * Decode a BlurHash to a data URL for use as img src.
 */
export function blurHashToDataURL(hash: string, width = 32, height = 32): string {
  const pixels = decodeBlurHash(hash, width, height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer as ArrayBuffer), width, height), 0, 0);
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = width;
  tmpCanvas.height = height;
  tmpCanvas.getContext('2d')!.drawImage(canvas, 0, 0);
  return tmpCanvas.toDataURL('image/png');
}
