import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderEditThumbnailNow } from './ThumbnailRenderer';
import { defaultAdjustments } from '../types';
import { setActiveRepos } from '../storage/activeRepos';
import type { PhotoView, Repositories } from '../storage/repos';
import { sourceManager } from '../sources';
import type { SourceProvider } from '../sources';
import { setDefaultPipelineService } from './graph';
import { editorRawMemoryCache } from './raw/EditorRawMemoryCache';
import { getDefaultRawPixelsCache } from './raw/RawPixelsOpfsCache';
import { makeRawCacheKey } from './raw/cacheKey';
import { getSmartPreviewSize, loadRawPixels, setRawDecodeMode } from './raw';
import { setBackendUrl } from '../platform/config';
import { STORAGE_KEYS } from '../platform/storageKeys';

const PHOTO = {
  id: 11,
  sourceId: 'browser-folder',
  sourcePhotoId: 'open.dng',
  contentHash: 'browser-raw-content-hash',
  name: 'open.dng',
  mimeType: 'image/x-adobe-dng',
  sizeBytes: 123,
  dateTaken: null,
  dateModified: 456,
  sourcePath: null,
  availability: 'online',
  sourceRevision: 1,
  indexedAt: 1,
  updatedAt: 1,
  deletedAt: null,
  width: 8,
  height: 8,
  sourceBits: null,
  camera: null,
  lens: null,
  iso: null,
  focalLength: null,
  aperture: null,
  shutterSpeed: null,
  latitude: null,
  longitude: null,
  blurHash: null,
  stackId: null,
  stackPosition: null,
  rating: null,
  flag: null,
  colorLabel: null,
  keywords: [],
} satisfies PhotoView;

let rawUrl: string | null = null;

function localSource(getDisplayUrl: SourceProvider['getDisplayUrl']): SourceProvider {
  return {
    id: PHOTO.sourceId,
    label: 'Browser folder',
    type: 'local',
    connect: async () => true,
    disconnect: async () => {},
    async *listPhotos() {},
    getDisplayUrl,
    getThumbnailUrl: async () => null,
    getFile: async () => null,
  };
}

afterEach(async () => {
  setActiveRepos(null);
  setDefaultPipelineService(null);
  editorRawMemoryCache.clear();
  setBackendUrl('');
  localStorage.removeItem(STORAGE_KEYS.rawDecodeMode);
  vi.restoreAllMocks();
  if (rawUrl) URL.revokeObjectURL(rawUrl);
  rawUrl = null;
  await getDefaultRawPixelsCache().evict(makeRawCacheKey(PHOTO), String(getSmartPreviewSize()));
});

describe('RAW edit thumbnail (Chromium ownership path)', () => {
  it('uses the local LibRaw cache instead of asking Chromium to decode the DNG original', async () => {
    const size = getSmartPreviewSize();
    const key = makeRawCacheKey(PHOTO);
    const values = new Uint16Array(8 * 8 * 3);
    for (let i = 0; i < values.length; i += 3) {
      values[i] = 12000;
      values[i + 1] = 24000;
      values[i + 2] = 36000;
    }
    await getDefaultRawPixelsCache().put(key, String(size), {
      data: values,
      width: 8,
      height: 8,
      channels: 3,
      bits: 16,
      colorMatrix: null,
      asShotNeutral: null,
    });
    editorRawMemoryCache.clear();

    // Make the historical mutation deterministic: without the source type,
    // the preferred Smart Preview strategy looks in its versioned slot and
    // misses the bare-size LibRaw slot written above.
    setBackendUrl('https://raw-backend.invalid');
    setRawDecodeMode('smart-preview');
    rawUrl = URL.createObjectURL(new Blob([
      // TIFF/DNG signature plus deliberately incomplete camera data. Chromium
      // cannot decode DNG; createImageBitmap rejects with InvalidStateError.
      new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
    ], { type: 'image/x-adobe-dng' }));
    const getDisplayUrl = vi.fn(async () => rawUrl!);
    vi.spyOn(sourceManager, 'get').mockReturnValue(localSource(getDisplayUrl));

    const stored = vi.fn(async () => {});
    setActiveRepos({
      photos: { getByContentHash: () => [PHOTO] },
      thumbnails: { set: stored },
    } as unknown as Repositories);

    await renderEditThumbnailNow(PHOTO.contentHash, defaultAdjustments);

    expect(getDisplayUrl).not.toHaveBeenCalled();
    expect(stored).toHaveBeenCalledOnce();

    // A second consumer can still read the cached pixels: the thumbnail
    // worker received a clone, not the cache-owned ArrayBuffer.
    const stillCached = await loadRawPixels({
      identity: PHOTO,
      size,
      sourceType: 'local',
      wantPreview: false,
    });
    expect(stillCached?.rawPixels?.data).toHaveLength(8 * 8 * 3);
    expect(Array.from(stillCached?.rawPixels?.data.slice(0, 3) ?? [])).toEqual([12000, 24000, 36000]);
  });
});
