import { describe, expect, it } from 'vitest';
import { makeRawCacheKey } from './cacheKey';

describe('makeRawCacheKey', () => {
  const base = { sourceId: 'local-1', sourcePhotoId: 'folder/image.RAF' };

  it('is stable for the same photo identity', () => {
    expect(makeRawCacheKey({ ...base, sizeBytes: 10, dateModified: 20 }))
      .toBe(makeRawCacheKey({ ...base, sizeBytes: 10, dateModified: 20 }));
  });

  it('invalidates when a local file at the same path changes', () => {
    expect(makeRawCacheKey({ ...base, sizeBytes: 10, dateModified: 20 }))
      .not.toBe(makeRawCacheKey({ ...base, sizeBytes: 11, dateModified: 21 }));
  });

  /**
   * The absolute assertion, not a round trip: both sides of a comparison that
   * reads the same fields would move together and stay green. This names the
   * string a scanned row produces, so any input that creeps back into the
   * recipe changes it.
   */
  it('names a scanned row with exactly this string', () => {
    expect(makeRawCacheKey({ ...base, sizeBytes: 787054, dateModified: 1789221739222 }))
      .toBe('local-1_folder_image_RAF_1teyjsf');
  });

  /**
   * The row a fresh scan writes has no contentHash; the first editor open
   * computes one and writes it back. The key must not notice: it used to, and
   * every second open of a freshly scanned photo decoded the RAW again with
   * both caches warm (measured in the running app, 1 decode per warm open).
   */
  it('does not move when the first open writes a contentHash into the row', () => {
    const scanned = { ...base, sizeBytes: 787054, dateModified: 1789221739222, sourceRevision: 0 };
    const afterFirstOpen = { ...scanned, contentHash: 'cf4455df8baf69113db6ee5eaa6c380d' };

    expect(makeRawCacheKey(afterFirstOpen)).toBe(makeRawCacheKey(scanned));
    expect(makeRawCacheKey(afterFirstOpen)).toBe('local-1_folder_image_RAF_1teyjsf');
  });
});
