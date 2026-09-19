import { describe, expect, it } from 'vitest';
import { makeRawCacheKey } from '../engine/raw/cacheKey';
import {
  SOURCE_THUMBNAIL_PREFIX, sourceThumbnailKey, sourceThumbnailKeys,
} from './sourceThumbnailKey';

const scanned = {
  sourceId: 'local-1',
  sourcePhotoId: 'folder/image.RAF',
  sizeBytes: 787054,
  dateModified: 1789221739222,
  sourceRevision: 0,
  contentHash: null as string | null,
};

describe('sourceThumbnailKey', () => {
  it('names a freshly scanned photo by its stable scan identity', () => {
    expect(sourceThumbnailKey(scanned)).toBe('src:local-1_folder_image_RAF_1teyjsf');
  });

  /**
   * The absolute assertion the drift needs: the first editor open writes a
   * contentHash into the row, and the slot a thumbnail is stored in must not
   * move because of it - that cost one extra decode per photo the user opened.
   */
  it('does not move when the first open writes a contentHash into the row', () => {
    expect(sourceThumbnailKey({ ...scanned, contentHash: 'abc123' }))
      .toBe('src:local-1_folder_image_RAF_1teyjsf');
  });

  it('still looks in the content-hash slot, where older thumbnails were stored', () => {
    expect(sourceThumbnailKeys({ ...scanned, contentHash: 'abc123' }))
      .toEqual(['src:local-1_folder_image_RAF_1teyjsf', 'abc123']);
    expect(sourceThumbnailKeys(scanned)).toEqual(['src:local-1_folder_image_RAF_1teyjsf']);
  });

  it('is the RAW ladder identity behind the prefix, so it moves with the file', () => {
    expect(sourceThumbnailKey(scanned)).toBe(SOURCE_THUMBNAIL_PREFIX + makeRawCacheKey(scanned));
    expect(sourceThumbnailKey({ ...scanned, sizeBytes: 787055 }))
      .not.toBe(sourceThumbnailKey(scanned));
  });

  it('never collides with the developed rendering of the same photo', () => {
    expect(sourceThumbnailKey({ ...scanned, contentHash: 'abc123' }).startsWith('edit:')).toBe(false);
  });
});
