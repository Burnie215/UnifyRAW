import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RawLoadRequest } from './raw/loadRawPixels';
import type { RawDecodeResult, RawPixelData } from './raw/RawDecoderStrategy';
import type { PhotoView, Repositories } from '../storage/repos';
import type { SourceProvider } from '../sources';
import type { WorkerPipelineService, WorkerRenderSource } from './graph';

const loadRawPixels = vi.hoisted(() => vi.fn<(request: RawLoadRequest) => Promise<RawDecodeResult | null>>());
vi.mock('./raw/loadRawPixels', () => ({ loadRawPixels }));

import { renderEditThumbnailNow } from './ThumbnailRenderer';
import { setActiveRepos } from '../storage/activeRepos';
import { sourceManager } from '../sources';
import { setDefaultPipelineService } from './graph';
import { defaultAdjustments } from '../types';

const PHOTO = {
  id: 7,
  sourceId: 'local-folder',
  sourcePhotoId: 'open.dng',
  contentHash: 'raw-content-hash',
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
  width: 2,
  height: 1,
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

function localSource(getDisplayUrl: SourceProvider['getDisplayUrl']): SourceProvider {
  return {
    id: PHOTO.sourceId,
    label: 'Local folder',
    type: 'local',
    connect: async () => true,
    disconnect: async () => {},
    async *listPhotos() {},
    getDisplayUrl,
    getThumbnailUrl: async () => null,
    getFile: async () => null,
  };
}

/**
 * A worker-shaped service: binding transfers the renderer-owned buffer, just
 * like WorkerPipelineService.postMessage(..., [buffer]) does in production.
 */
function transferringService() {
  let workerPixels: Uint16Array | null = null;
  const svc = {
    compile: vi.fn(async () => ({ planId: 'raw-thumb-plan', graphRevision: 1, terminalGeometry: null })),
    bindSource: vi.fn(async (_id: string, source: WorkerRenderSource) => {
      if (!('pixels' in source)) throw new Error('expected raw16 source');
      const received = structuredClone(source, { transfer: [source.pixels.buffer] });
      workerPixels = received.pixels;
    }),
    unbindSource: vi.fn(async () => {}),
    renderToBlob: vi.fn(async () => new Blob(['developed'], { type: 'image/jpeg' })),
    releasePlan: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  return { svc: svc as unknown as WorkerPipelineService, workerPixels: () => workerPixels };
}

afterEach(() => {
  setActiveRepos(null);
  setDefaultPipelineService(null);
  vi.restoreAllMocks();
  loadRawPixels.mockReset();
});

describe('RAW edit-thumbnail source ownership', () => {
  it('reads a local RAW from its decoder cache and transfers only a private pixel clone', async () => {
    const original: RawPixelData = {
      data: new Uint16Array([1000, 2000, 3000, 4000, 5000, 6000]),
      width: 2,
      height: 1,
      channels: 3,
      bits: 16,
      colorMatrix: null,
      asShotNeutral: null,
    };
    loadRawPixels.mockImplementation(async (request) => request.sourceType === 'local' ? {
      displayUrl: '',
      width: 2,
      height: 1,
      bits: 16,
      source: 'libraw-wasm',
      rawPixels: original,
    } : null);

    const thumbnailSet = vi.fn(async () => {});
    setActiveRepos({
      photos: { getByContentHash: () => [PHOTO] },
      thumbnails: { set: thumbnailSet },
    } as unknown as Repositories);
    const getDisplayUrl = vi.fn(async () => { throw new Error('RAW original reached SDR fallback'); });
    vi.spyOn(sourceManager, 'get').mockReturnValue(localSource(getDisplayUrl));
    const { svc, workerPixels } = transferringService();
    setDefaultPipelineService(svc);

    await renderEditThumbnailNow(PHOTO.contentHash, defaultAdjustments);

    expect(loadRawPixels).toHaveBeenCalledWith(expect.objectContaining({
      identity: PHOTO,
      sourceType: 'local',
      wantPreview: false,
    }));
    expect(getDisplayUrl).not.toHaveBeenCalled();
    expect(thumbnailSet).toHaveBeenCalledOnce();
    expect(Array.from(workerPixels() ?? [])).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    // The cache/editor still owns this array after the worker transfer.
    expect(Array.from(original.data)).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
  });
});
