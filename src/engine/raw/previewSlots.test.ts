import { afterEach, describe, expect, it, vi } from 'vitest';
import { smartPreviewFileName, smartPreviewVersion } from '@photolib/shared';
import { createFakeDirectory, listFakeEntries } from '../../test/fakeFileSystem';
import { currentSlotKey, isCurrentPreviewVariant, isStalePreviewVariant, previewVariant } from './previewSlots';
import { SMART_PREVIEW_SIZES } from './RawDecoderStrategy';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../platform/api', () => ({ apiFetch }));
vi.mock('../webglCaps', () => ({
  detectWebGLCaps: () => ({ webgl2: true, rgba16fRender: true, reason: null }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('preview version in the browser (F038)', () => {
  it('puts the decode version of its size into the pixel-cache variant', () => {
    for (const size of SMART_PREVIEW_SIZES) {
      expect(previewVariant(size)).toBe(`${size}${smartPreviewVersion(size)}`);
      expect(isCurrentPreviewVariant(previewVariant(size))).toBe(true);
    }
  });

  it.each([
    ['1200v5', true],
    ['1200v6', false],
    ['1200', false],
    ['full', false],
    ['8000v6', true],
    ['8000v7', false],
  ])('treats pixel variant %s as stale: %s', (variant, stale) => {
    expect(isStalePreviewVariant(variant)).toBe(stale);
  });

  it('reads the key only from slot files of the current version', () => {
    expect(currentSlotKey(smartPreviewFileName('src_1_IMG_7', 1800, 'tiff'))).toBe('src_1_IMG_7');
    expect(currentSlotKey('src_1_IMG_7_1800_v5.tiff')).toBeNull();
    expect(currentSlotKey('_index.v2.json')).toBeNull();
  });

  it('writes its OPFS slot under the name the backend gives its disk slot', async () => {
    const root = createFakeDirectory();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiFetch.mockResolvedValue(new Response(new Uint8Array(64 * 1024), { status: 200 }));
    const { SmartPreviewStrategy } = await import('./SmartPreviewStrategy');

    const cached = await new SmartPreviewStrategy()
      .prefetch(new File(['raw'], 'a.raf'), { cacheKey: 'k_abc', size: 1200 });

    expect(cached).toBe(true);
    const previews = await root.getDirectoryHandle('smart-previews');
    expect(await listFakeEntries(previews)).toEqual([smartPreviewFileName('k_abc', 1200, 'tiff')]);
  });
});
