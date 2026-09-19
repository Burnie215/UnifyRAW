import { describe, expect, it } from 'vitest';

import { colorMatrix1For, encodeDng } from './DngEncoder';
import { rawDecoder } from './RawDecoder';

/**
 * The cheapest hard acceptance test the plan names: hand our own DNG to our
 * own RAW decoder. It runs in the browser project because libraw-wasm needs a
 * Worker, so it is not part of `npm run verify`.
 *
 * It proves less than the plan hoped, and the gap is measured, not assumed.
 * The bundled libraw-wasm 1.1.2 build:
 *   - accepts the uncompressed file and reports our geometry and three
 *     colours back, so the container and the DNG tags are read as a DNG;
 *   - returns black pixels for it, because LibRaw keeps floating point DNG
 *     samples in `float_image` unless the caller sets
 *     LIBRAW_PROCESSING_CONVERTFLOAT_TO_INT, and the wrapper exposes exactly
 *     three Embind functions (open, metadata, imageData) — no place to ask;
 *   - cannot open the Deflate file at all: `deflate_dng_load_raw()` is in the
 *     name table but the wasm carries no zlib, so `load_raw` stays null.
 *
 * Both limits are the decoder's, not the file's. The second expectation below
 * therefore pins a known limitation on purpose: when a libraw build with zlib
 * lands, this test goes red and the real pixel comparison becomes possible.
 */
describe('encodeDng through rawDecoder', () => {
  const width = 64;
  const height = 48;

  function sceneLinear(): Float32Array {
    const pixels = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        pixels[offset] = x / width;
        pixels[offset + 1] = y / height;
        pixels[offset + 2] = 0.5;
        pixels[offset + 3] = 1;
      }
    }
    return pixels;
  }

  async function dngFile(compression: 'deflate' | 'none'): Promise<File> {
    const blob = await encodeDng(sceneLinear(), {
      width,
      height,
      colorMatrix: colorMatrix1For('srgb'),
      uniqueCameraModel: 'UnifyRAW Linear',
      compression,
    });
    return new File([blob], 'roundtrip.dng', { type: 'image/x-adobe-dng' });
  }

  it('is read back as a three-colour 16-bit RAW of the written geometry', async () => {
    const decoded = await rawDecoder.decode(await dngFile('none'), {
      outputBps: 16, linear: true, useCameraWb: true, useAutoWb: false,
    });

    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(decoded.colors).toBe(3);
    expect(decoded.bits).toBe(16);
    expect(decoded.data16?.length).toBe(width * height * 3);
  }, 60_000);

  it('cannot be read back while compressed, because this libraw build has no zlib', async () => {
    await expect(rawDecoder.decode(await dngFile('deflate'), {
      outputBps: 16, linear: true, useCameraWb: true, useAutoWb: false,
    })).rejects.toThrow(/no pixel data/);
  }, 60_000);
});
