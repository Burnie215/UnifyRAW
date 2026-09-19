import { afterEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../platform/storageKeys';
import type { Repositories } from '../storage/repos';
import { EDIT_THUMBNAIL_PREFIX } from './editThumbnailKey';
import { migrateThumbnailsToSrgb } from './thumbnailSrgbMigration';

function installStorage(entries: Record<string, string>): Map<string, string> {
  const values = new Map(Object.entries(entries));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
    clear: () => values.clear(),
    key: (i: number) => [...values.keys()][i] ?? null,
    get length() { return values.size; },
  } satisfies Storage);
  return values;
}

function fakeRepos() {
  const deleteByPrefix = vi.fn<(prefix: string) => Promise<number>>().mockResolvedValue(7);
  return {
    repos: { thumbnails: { deleteByPrefix } } as unknown as Repositories,
    deleteByPrefix,
  };
}

describe('migrateThumbnailsToSrgb', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('drops the developed thumbnails of a Display-P3 profile exactly once', async () => {
    const values = installStorage({ [STORAGE_KEYS.outputColorSpace]: 'display-p3' });
    const { repos, deleteByPrefix } = fakeRepos();

    expect(await migrateThumbnailsToSrgb(repos)).toBe(7);
    expect(deleteByPrefix).toHaveBeenCalledExactlyOnceWith(EDIT_THUMBNAIL_PREFIX);
    expect(values.get(STORAGE_KEYS.thumbsSrgbMigrated)).toBe('1');

    // The next start finds the marker: the tiles rendered since then are the
    // ones a second run would delete.
    expect(await migrateThumbnailsToSrgb(repos)).toBe(0);
    expect(deleteByPrefix).toHaveBeenCalledTimes(1);
  });

  it('leaves a profile alone that never left sRGB', async () => {
    const profiles: Record<string, string>[] = [{ [STORAGE_KEYS.outputColorSpace]: 'srgb' }, {}];
    for (const stored of profiles) {
      const values = installStorage(stored);
      const { repos, deleteByPrefix } = fakeRepos();

      expect(await migrateThumbnailsToSrgb(repos)).toBe(0);
      expect(deleteByPrefix).not.toHaveBeenCalled();
      // No marker either: a profile that has nothing to migrate keeps nothing.
      expect(values.has(STORAGE_KEYS.thumbsSrgbMigrated)).toBe(false);
    }
  });

  it('does nothing where there is no browser storage to read the setting from', async () => {
    vi.stubGlobal('localStorage', undefined);
    const { repos, deleteByPrefix } = fakeRepos();

    expect(await migrateThumbnailsToSrgb(repos)).toBe(0);
    expect(deleteByPrefix).not.toHaveBeenCalled();
  });
});
