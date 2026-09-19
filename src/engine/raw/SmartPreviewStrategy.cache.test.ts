import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smartPreviewFileName } from '@photolib/shared';
import { createFakeDirectory, listFakeEntries } from '../../test/fakeFileSystem';
import type { RawPixelData } from './RawDecoderStrategy';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../platform/api', () => ({ apiFetch }));
vi.mock('../webglCaps', () => ({
  detectWebGLCaps: () => ({ webgl2: true, rgba16fRender: true, reason: null }),
}));
vi.mock('./tiff', () => ({
  decodeTiff: () => ({
    width: 4, height: 2, channels: 3, bits: 16,
    data: new Uint16Array(24).fill(900), asShotNeutral: null,
  }),
}));

const KEY = 'immich_asset_abc';
const SIZE = 1200;
const TIFF_SLOT = smartPreviewFileName(KEY, SIZE, 'tiff');
let root: FileSystemDirectoryHandle;

class FakeOffscreenCanvas {
  getContext() { return { putImageData: () => {}, drawImage: () => {} }; }
  convertToBlob() { return Promise.resolve(new Blob(['jpeg'], { type: 'image/jpeg' })); }
}

class FakeImageData {}

function samplePixels(fill = 900): RawPixelData {
  return {
    data: new Uint16Array(24).fill(fill), width: 4, height: 2, channels: 3, bits: 16,
    colorMatrix: null, asShotNeutral: null,
  };
}

async function writeBytes(dir: FileSystemDirectoryHandle, name: string, size: number): Promise<void> {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(new Uint8Array(size));
  await writable.close();
}

async function load() {
  const [{ SmartPreviewStrategy }, { getDefaultRawPixelsCache }, { previewVariant }] = await Promise.all([
    import('./SmartPreviewStrategy'),
    import('./RawPixelsOpfsCache'),
    import('./previewSlots'),
  ]);
  return { strategy: new SmartPreviewStrategy(), pixels: getDefaultRawPixelsCache(), variant: previewVariant(SIZE) };
}

beforeEach(() => {
  root = createFakeDirectory();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal('ImageData', FakeImageData);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.resetModules();
  apiFetch.mockReset();
  apiFetch.mockResolvedValue(new Response('backend down', { status: 503 }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('one RAW cache store (F087)', () => {
  it('moves a TIFF into the pixel cache on its second open and deletes the TIFF', async () => {
    const { strategy, pixels, variant } = await load();
    const previews = await root.getDirectoryHandle('smart-previews', { create: true });
    await writeBytes(previews, TIFF_SLOT, 60 * 1024);

    const first = await strategy.decodeFromCache(KEY, SIZE);
    expect(first?.rawPixels?.width).toBe(4);
    await vi.waitFor(async () => expect(await listFakeEntries(previews)).not.toContain(TIFF_SLOT));
    expect(await pixels.has(KEY, variant)).toBe(true);

    const second = await strategy.decodeFromCache(KEY, SIZE);
    expect(second?.rawPixels?.data).toEqual(samplePixels().data);
  });

  it('decodes from the pixel cache without asking the backend', async () => {
    const { strategy, pixels, variant } = await load();
    await pixels.put(KEY, variant, samplePixels(321));

    const result = await strategy.decode(new File(['raw'], 'a.raf'), { cacheKey: KEY, size: SIZE });

    expect(apiFetch).not.toHaveBeenCalled();
    expect(result?.source).toBe('smart-preview');
    expect(result?.rawPixels?.data).toEqual(samplePixels(321).data);
  });

  it('counts a pixel-cache entry as prefetched', async () => {
    const { strategy, pixels, variant } = await load();
    await pixels.put(KEY, variant, samplePixels());

    expect(await strategy.prefetch(new File(['raw'], 'a.raf'), { cacheKey: KEY, size: SIZE })).toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does not serve pixels of an older version or of a browser decode (F038)', async () => {
    const { strategy, pixels } = await load();
    await pixels.put(KEY, `${SIZE}v5`, samplePixels());
    await pixels.put(KEY, String(SIZE), samplePixels());

    expect(await strategy.decodeFromCache(KEY, SIZE)).toBeNull();
  });
});

/**
 * The POST answers from the same server cache, but only after the browser has
 * pushed the whole RAW up the wire. Asking first is what makes the hit free
 * on a second device or after "Clear site data" (F054).
 */
describe('server cache probe before the upload (F054)', () => {
  function cacheHitOnGet(): void {
    apiFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'POST'
        ? new Response('the RAW must not be uploaded', { status: 500 })
        : new Response(new Uint8Array(60 * 1024), { status: 200, headers: { 'X-Cache-Hit': '1' } })));
  }

  function requestedMethods(): string[] {
    return apiFetch.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? 'GET');
  }

  it('decodes from the server cache without uploading the RAW', async () => {
    const { strategy } = await load();
    cacheHitOnGet();

    const result = await strategy.decode(new File(['raw'], 'a.raf'), { cacheKey: KEY, size: SIZE });

    expect(result?.source).toBe('smart-preview');
    expect(requestedMethods()).toEqual(['GET']);
    expect(apiFetch.mock.calls[0]?.[0]).toBe(`/api/raw/smart-preview/${KEY}?size=${SIZE}`);
  });

  it('warms the prefetch slot from the server cache without uploading the RAW', async () => {
    const { strategy } = await load();
    cacheHitOnGet();

    expect(await strategy.prefetch(new File(['raw'], 'a.raf'), { cacheKey: KEY, size: SIZE })).toBe(true);
    expect(requestedMethods()).toEqual(['GET']);
  });

  it('uploads the RAW only after the probe came back empty', async () => {
    const { strategy } = await load();
    apiFetch.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(init?.method === 'POST'
        ? new Response(new Uint8Array(60 * 1024), { status: 200 })
        : new Response(JSON.stringify({ error: 'not cached' }), { status: 404 })));

    expect(await strategy.prefetch(new File(['raw'], 'a.raf'), { cacheKey: KEY, size: SIZE })).toBe(true);
    expect(requestedMethods()).toEqual(['GET', 'POST']);
  });
});

describe('prefetch badges after a restart (F038, F087)', () => {
  it('count current slot files and preview pixels, not older versions or libraw-wasm pixels', async () => {
    const { pixels, variant } = await load();
    const previews = await root.getDirectoryHandle('smart-previews', { create: true });
    await writeBytes(previews, smartPreviewFileName('a', SIZE, 'tiff'), 1);
    await writeBytes(previews, 'b_1200_v5.tiff', 1);
    await pixels.put('c', variant, samplePixels());
    await pixels.put('d', String(SIZE), samplePixels());

    const { PrefetchManager } = await import('./prefetchManager');
    const manager = new PrefetchManager();
    await manager.scanOpfsCache();

    expect(['a', 'b', 'c', 'd'].map((key) => manager.isCompleted(key))).toEqual([true, false, true, false]);
  });
});
