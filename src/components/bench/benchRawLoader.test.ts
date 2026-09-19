import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import type { PhotoView } from '../../storage/repos';
import type { RawLoadRequest } from '../../engine/raw';

const raw = vi.hoisted(() => ({
  getSmartPreviewSize: vi.fn(() => 2540),
  loadRawPixels: vi.fn<(request: RawLoadRequest) => Promise<null>>(async () => null),
}));

vi.mock('../../engine/raw', () => raw);

import { loadBenchRaw } from './benchRawLoader';

const PHOTO: PhotoView = {
  id: 7,
  sourceId: 'source',
  sourcePhotoId: 'photo',
  contentHash: null,
  name: 'photo.cr3',
  mimeType: 'image/x-canon-cr3',
  sizeBytes: 123,
  dateTaken: null,
  dateModified: 456,
  sourcePath: null,
  availability: 'online',
  sourceRevision: 2,
  indexedAt: 1,
  updatedAt: 1,
  deletedAt: null,
  width: 6000,
  height: 4000,
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
};

describe('bench RAW loader', () => {
  it('hands cache hints and a lazy original to the shared ladder', async () => {
    const file = new File(['raw'], PHOTO.name);
    const getFile = vi.fn(async () => file);
    const provider = {
      type: 'immich',
      getFile,
      getRemoteFetchHint: vi.fn(() => ({ url: '/original', headers: { Authorization: 'token' } })),
      getRawPreviewHint: vi.fn(() => ({ url: '/prepared' })),
    };
    const signal = new AbortController().signal;

    await loadBenchRaw(PHOTO, provider, signal);

    expect(raw.loadRawPixels).toHaveBeenCalledOnce();
    const request = raw.loadRawPixels.mock.calls[0]![0];
    expect(request).toMatchObject({
      identity: PHOTO,
      size: 2540,
      sourceType: 'immich',
      fetchHint: { url: '/original', headers: { Authorization: 'token' } },
      preparedUrl: '/prepared',
      signal,
    });
    expect(getFile).not.toHaveBeenCalled();
    if (typeof request.file !== 'function') throw new Error('the original is not lazy');
    expect(await request.file(signal)).toBe(file);
    expect(getFile).toHaveBeenCalledWith({
      sourcePhotoId: PHOTO.sourcePhotoId,
      sourceId: PHOTO.sourceId,
      name: PHOTO.name,
    }, signal);
  });

  it.each(['useBenchLoupe.ts', 'useBenchSources.ts'])('%s calls the shared loader', (name) => {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    expect(source).toContain('loadBenchRaw(');
    expect(source).not.toMatch(/strategyForSource\([^)]*\)\.decode|strategy\.decode/);
  });
});
