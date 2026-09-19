import { describe, expect, it } from 'vitest';
import { buildLinearLut, packInterleaved16, supportsHeif16 } from './heif16';

describe('buildLinearLut', () => {
  it('spans the full 16-bit range regardless of source depth', () => {
    for (const bits of [8, 10, 12]) {
      const lut = buildLinearLut(bits);
      expect(lut.length).toBe((1 << bits));
      expect(lut[0]).toBe(0);
      expect(lut[lut.length - 1]).toBe(65535);
    }
  });

  it('rises monotonically', () => {
    const lut = buildLinearLut(10);
    for (let i = 1; i < lut.length; i++) expect(lut[i]).toBeGreaterThanOrEqual(lut[i - 1]);
  });

  it('inverts the sRGB transfer rather than scaling linearly', () => {
    // Mid gray sits near 0.5 encoded but near 0.21 in linear light. A plain
    // range scale would land at ~32767 — that is the bug this guards against.
    const lut = buildLinearLut(10);
    const midEncoded = lut[Math.round(1023 * 0.5)];
    expect(midEncoded / 65535).toBeCloseTo(0.214, 2);
  });

  it('keeps the linear segment near black', () => {
    const lut = buildLinearLut(8);
    // 10/255 is below the 0.04045 threshold, so it divides by 12.92.
    expect(lut[10] / 65535).toBeCloseTo((10 / 255) / 12.92, 4);
  });

  it('agrees across depths for the same encoded fraction', () => {
    const eight = buildLinearLut(8);
    const ten = buildLinearLut(10);
    // 128/255 and 512/1023 are both ~0.5 encoded.
    expect(Math.abs(eight[128] - ten[512])).toBeLessThan(200);
  });
});

describe('packInterleaved16', () => {
  /** Two 2x2 rows with four samples of row padding after each. */
  function paddedPlane(): { heap: Uint16Array; stride: number } {
    const width = 2, height = 2, channels = 3, padding = 4;
    const rowSamples = width * channels + padding;
    const heap = new Uint16Array(rowSamples * height);
    let v = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width * channels; x++) heap[y * rowSamples + x] = v++;
      for (let p = 0; p < padding; p++) heap[y * rowSamples + width * channels + p] = 9999;
    }
    return { heap, stride: rowSamples * 2 };
  }

  it('skips row padding', () => {
    const { heap, stride } = paddedPlane();
    const identity = Uint16Array.from({ length: 65536 }, (_, i) => i);
    const out = packInterleaved16(heap, 0, stride, 2, 2, identity);
    expect(Array.from(out)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('honours a non-zero plane offset', () => {
    const heap = new Uint16Array([777, 777, 1, 2, 3, 4, 5, 6]);
    const identity = Uint16Array.from({ length: 65536 }, (_, i) => i);
    // Offset is in bytes: two samples in.
    const out = packInterleaved16(heap, 4, 12, 2, 1, identity);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('maps every sample through the table', () => {
    const heap = new Uint16Array([0, 511, 1023, 0, 511, 1023]);
    const lut = buildLinearLut(10);
    const out = packInterleaved16(heap, 0, 12, 2, 1, lut);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(65535);
    expect(out[1]).toBe(lut[511]);
  });

  it('clamps samples that exceed the table', () => {
    // A decoder that hands back values above the declared range must not read
    // past the end of the lookup table.
    const heap = new Uint16Array([65535, 0, 0]);
    const lut = buildLinearLut(10);
    const out = packInterleaved16(heap, 0, 6, 1, 1, lut);
    expect(out[0]).toBe(lut[lut.length - 1]);
  });

  it('produces a tightly packed buffer of the right size', () => {
    const { heap, stride } = paddedPlane();
    const out = packInterleaved16(heap, 0, stride, 2, 2, buildLinearLut(10));
    expect(out.length).toBe(2 * 2 * 3);
  });
});

describe('supportsHeif16', () => {
  function fullModule() {
    const fns = [
      '_malloc', '_free', '_heif_context_alloc', '_heif_context_free',
      '_heif_context_read_from_memory', '_heif_context_get_primary_image_handle',
      '_heif_decode_image', '_heif_image_handle_release', '_heif_image_release',
      '_heif_image_get_width', '_heif_image_get_height',
      '_heif_image_get_bits_per_pixel_range', '_heif_image_get_plane_readonly',
    ];
    const mod: Record<string, unknown> = {
      HEAPU8: new Uint8Array(1), HEAPU16: new Uint16Array(1), HEAP32: new Int32Array(1),
    };
    for (const fn of fns) mod[fn] = () => 0;
    return mod;
  }

  it('accepts a module exposing the whole C API', () => {
    expect(supportsHeif16(fullModule())).toBe(true);
  });

  it('rejects a module missing one entry point', () => {
    const mod = fullModule();
    delete mod._heif_decode_image;
    expect(supportsHeif16(mod)).toBe(false);
  });

  it('rejects a module without the 16-bit heap view', () => {
    const mod = fullModule();
    delete mod.HEAPU16;
    expect(supportsHeif16(mod)).toBe(false);
  });

  it('rejects null', () => {
    expect(supportsHeif16(null)).toBe(false);
  });
});
