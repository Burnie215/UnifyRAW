import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawLoadStage } from './RawDecoderStrategy';

const rawDecoder = vi.hoisted(() => ({
  decode: vi.fn(),
  extractLargestEmbeddedJpeg: vi.fn(),
  toImageBitmap: vi.fn(),
}));
vi.mock('../RawDecoder', () => ({ rawDecoder }));
vi.mock('./RawPixelsOpfsCache', () => ({
  getDefaultRawPixelsCache: () => ({ get: vi.fn(), put: vi.fn(async () => {}) }),
}));

const FILE = new File([new Uint8Array([1, 2, 3])], 'DSCF1107.RAF');

beforeEach(() => {
  vi.resetModules();
  rawDecoder.decode.mockReset();
  rawDecoder.extractLargestEmbeddedJpeg.mockReset();
  rawDecoder.extractLargestEmbeddedJpeg.mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:embedded');
  vi.stubGlobal('createImageBitmap', async () => ({ width: 1600, height: 1067, close: () => {} }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('libraw-wasm falling back to the embedded camera JPEG (F039)', () => {
  it('reports the camera JPEG as the source, at 8 bit and without RAW pixels', async () => {
    const { LibrawWasmStrategy } = await import('./LibrawWasmStrategy');
    rawDecoder.decode.mockRejectedValue(new Error('X-Trans misread as Bayer'));

    const result = await new LibrawWasmStrategy().decode(FILE);

    expect(result?.source).toBe('embedded-jpeg');
    expect(result?.bits).toBe(8);
    expect(result?.rawPixels).toBeUndefined();
    expect(result?.width).toBe(1600);
  });

  it('closes the loading overlay instead of leaving it on the last libraw stage', async () => {
    const { LibrawWasmStrategy } = await import('./LibrawWasmStrategy');
    rawDecoder.decode.mockRejectedValue(new Error('out of memory'));
    const stages: RawLoadStage[] = [];

    await new LibrawWasmStrategy().decode(FILE, { onStage: (s) => stages.push(s) });

    expect(stages.map((s) => s.kind)).toContain('done');
  });

  it('names the file in the warning, so the fallback is findable in the console', async () => {
    const { LibrawWasmStrategy } = await import('./LibrawWasmStrategy');
    rawDecoder.decode.mockRejectedValue(new Error('nope'));
    const warn = vi.mocked(console.warn);

    await new LibrawWasmStrategy().decode(FILE);

    expect(warn.mock.calls.some((call) => String(call[0]).includes('DSCF1107.RAF'))).toBe(true);
  });
});
