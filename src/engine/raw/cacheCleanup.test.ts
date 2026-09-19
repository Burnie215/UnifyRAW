import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDirectory } from '../../test/fakeFileSystem';
import type { RawPixelData } from './RawDecoderStrategy';

let root: FileSystemDirectoryHandle;

function samplePixels(): RawPixelData {
  return {
    data: new Uint16Array(4 * 2 * 3).fill(7),
    width: 4, height: 2, channels: 3, bits: 16,
    colorMatrix: null, asShotNeutral: null,
  };
}

beforeEach(() => {
  root = createFakeDirectory();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  // The pixel cache keeps a module-level instance; each test gets its own.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('clearAllSmartPreviews', () => {
  it('leaves the pixel cache reporting nothing of what it deleted', async () => {
    const { getDefaultRawPixelsCache } = await import('./RawPixelsOpfsCache');
    const { clearAllSmartPreviews } = await import('./cacheCleanup');
    const cache = getDefaultRawPixelsCache();
    await cache.put('photo-a', '1200v6', samplePixels());
    expect(await cache.has('photo-a', '1200v6')).toBe(true);

    const cleared = await clearAllSmartPreviews();

    expect(cleared.removed).toBeGreaterThan(0);
    expect(await cache.has('photo-a', '1200v6')).toBe(false);
    expect(await cache.totalBytes()).toBe(0);
  });
});
