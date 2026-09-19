import { describe, expect, it } from 'vitest';
import { sourceThumbnailKey } from '../cache/sourceThumbnailKey';
import {
  photosNeedingThumbnail, thumbnailForBlurHash,
  type BlurHashThumbPorts, type ThumbnailCandidate, type ThumbnailSupply,
} from './backgroundThumbnailPlan';

function photo(id: number, over: Partial<ThumbnailCandidate> = {}): ThumbnailCandidate {
  return {
    id,
    sourceId: 'files-1',
    sourcePhotoId: `p${id}.dng`,
    sizeBytes: 787054,
    dateModified: 1789221739222,
    sourceRevision: 0,
    contentHash: null,
    ...over,
  };
}

const nothing: ThumbnailSupply = {
  hasSidecarThumb: () => false,
  storedKeys: new Set<string>(),
  hasMemoryThumb: () => false,
  canProvideThumbnail: () => true,
};

describe('photosNeedingThumbnail', () => {
  it('takes every photo when nothing has been generated yet', () => {
    expect(photosNeedingThumbnail([photo(1), photo(2)], nothing).map((p) => p.id))
      .toEqual([1, 2]);
  });

  it('skips a photo the sidecar already holds', () => {
    const supply = { ...nothing, hasSidecarThumb: (p: ThumbnailCandidate) => p.id === 1 };
    expect(photosNeedingThumbnail([photo(1), photo(2)], supply).map((p) => p.id)).toEqual([2]);
  });

  /**
   * The case the walker was blind to: a source without a sidecar. Without this
   * check every pass decoded the whole library again.
   */
  it('skips a photo the catalog already stores, sidecar or not', () => {
    const stored = photo(1);
    const supply = { ...nothing, storedKeys: new Set([sourceThumbnailKey(stored)]) };
    expect(photosNeedingThumbnail([stored, photo(2)], supply).map((p) => p.id)).toEqual([2]);
  });

  it('matches a stored photo by the key it was stored under, not by its id', () => {
    const stored = photo(1);
    const supply = { ...nothing, storedKeys: new Set(['src:files-1_p1_dng_wrong']) };
    expect(photosNeedingThumbnail([stored], supply).map((p) => p.id)).toEqual([1]);
  });

  it('finds a thumbnail stored under the older content-hash slot too', () => {
    const opened = photo(1, { contentHash: 'abc123' });
    const supply = { ...nothing, storedKeys: new Set(['abc123']) };
    expect(photosNeedingThumbnail([opened, photo(2)], supply).map((p) => p.id)).toEqual([2]);
  });

  it('skips a photo whose thumbnail is already on screen', () => {
    const supply = { ...nothing, hasMemoryThumb: (id: number) => id === 2 };
    expect(photosNeedingThumbnail([photo(1), photo(2)], supply).map((p) => p.id)).toEqual([1]);
  });

  it('leaves out rows the catalog has not written yet', () => {
    expect(photosNeedingThumbnail([{ ...photo(1), id: 0 }], nothing)).toEqual([]);
  });

  it('leaves out photos whose source has no background thumbnail route', () => {
    const supply = {
      ...nothing,
      canProvideThumbnail: (candidate: ThumbnailCandidate) => candidate.sourceId !== 's3-1',
    };
    const unavailable = photo(1, { sourceId: 's3-1' });
    expect(photosNeedingThumbnail([unavailable, photo(2)], supply).map((p) => p.id)).toEqual([2]);
  });
});

describe('thumbnailForBlurHash', () => {
  const blob = (size: number) => new Blob([new Uint8Array(new ArrayBuffer(size))]);

  const empty: BlurHashThumbPorts = {
    readSidecar: null,
    readMemory: () => null,
    readStored: async () => null,
  };

  it('reads the sidecar first', async () => {
    const sidecar = blob(10);
    const found = await thumbnailForBlurHash(photo(1), {
      ...empty,
      readSidecar: async () => sidecar,
      readMemory: () => blob(20),
      readStored: async () => blob(30),
    });
    expect(found).toBe(sidecar);
  });

  it('falls back to the memory slot', async () => {
    const remembered = blob(20);
    const found = await thumbnailForBlurHash(photo(1), {
      ...empty,
      readMemory: () => remembered,
      readStored: async () => blob(30),
    });
    expect(found).toBe(remembered);
  });

  it('finds the thumbnail the catalog already stores', async () => {
    // The case that kept the walker running: a remote source (no sidecar) and
    // a photo past the 200-entry memory LRU. Phase 2 skipped it because the
    // catalog has its thumbnail; phase 3 has to look there too.
    const p = photo(1);
    const stored = blob(30);
    const asked: string[] = [];
    const found = await thumbnailForBlurHash(p, {
      ...empty,
      readStored: async (key) => {
        asked.push(key);
        return key === sourceThumbnailKey(p) ? stored : null;
      },
    });
    expect(found).toBe(stored);
    expect(asked).toEqual([sourceThumbnailKey(p)]);
  });

  it('also looks under the content hash, where older thumbnails were written', async () => {
    const p = photo(1, { contentHash: 'deadbeef' });
    const stored = blob(30);
    const found = await thumbnailForBlurHash(p, {
      ...empty,
      readStored: async (key) => (key === 'deadbeef' ? stored : null),
    });
    expect(found).toBe(stored);
  });

  it('ignores empty blobs and a failing read', async () => {
    expect(await thumbnailForBlurHash(photo(1), {
      ...empty,
      readSidecar: async () => blob(0),
      readMemory: () => blob(0),
      readStored: async () => { throw new Error('gone'); },
    })).toBeNull();
  });

  it('returns nothing for a photo the catalog has no id for', async () => {
    expect(await thumbnailForBlurHash(photo(1, { id: null }), {
      ...empty,
      readStored: async () => blob(30),
    })).toBeNull();
  });
});
