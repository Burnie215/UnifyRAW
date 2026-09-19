import { useCallback, useEffect, useMemo } from 'react';
import { useRepos, useStorageRevisions } from '../contexts/StorageContext';
import type { Adjustments } from '../types';
import type { DevelopProfileScope } from '../engine/developProfile';
import { setDevelopProfiles } from '../engine/developProfileStore';
import { RawDecoder } from '../engine/RawDecoder';

/**
 * Keeps the catalog's base-development profiles in the module-level store the
 * render paths read from, and owns what has to happen around a write.
 *
 * The store is a singleton because the exporter and the background thumbnail
 * renderer are not in the React tree and still have to reach the same answer
 * as the canvas. This hook is the one place that fills it.
 */
export function useDevelopProfiles() {
  const repos = useRepos();
  const revisions = useStorageRevisions();

  const profiles = useMemo(
    () => repos.developProfiles.list(),
    // A write to developProfiles is the only thing that can change this list.
    // The linter cannot see it because the query is a method call rather than
    // a value it can trace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repos, revisions.developProfiles],
  );

  useEffect(() => {
    setDevelopProfiles(profiles);
  }, [profiles]);

  /**
   * Make the profiles current and nudge every mounted RAW tile to look again.
   *
   * Invalidation itself is no longer done here: a developed thumbnail's key
   * carries a stamp for the profiles that produced it
   * (`engine/thumbnailStamp`), so a changed profile simply stops matching and
   * the tile renders a new one on its own. That also covers the case this
   * hook cannot see at all - a profile arriving from another device through
   * sync, where nothing calls this function.
   *
   * What is still needed is the nudge. A tile already on screen has no reason
   * to re-run its effect just because a profile was written, so it would keep
   * showing the previous picture until it remounted. Dropping its memory-cache
   * entry is what the tile already listens for.
   *
   * The store is filled explicitly rather than left to the effect below,
   * because the effect runs after the next render - and a tile that re-reads
   * before it would compute the old stamp and find the old thumbnail.
   */
  const refreshRawThumbnails = useCallback(async () => {
    setDevelopProfiles(repos.developProfiles.list());
    const { thumbMemCache } = await import('../cache/ThumbMemCache');
    const { forgetColdThumbnails } = await import('../engine/ThumbnailRenderer');
    forgetColdThumbnails();
    for (const photo of repos.photos.list({})) {
      if (!photo.contentHash || !RawDecoder.isRawFile(photo.name)) continue;
      thumbMemCache.remove(photo.id);
    }
  }, [repos]);

  const saveProfile = useCallback(async (args: {
    name: string;
    scope: DevelopProfileScope;
    key: string;
    isoFrom?: number | null;
    isoTo?: number | null;
    adjustments: Partial<Adjustments>;
  }) => {
    const row = repos.developProfiles.save(args);
    await refreshRawThumbnails();
    return row;
  }, [repos, refreshRawThumbnails]);

  const deleteProfile = useCallback(async (id: number) => {
    repos.developProfiles.softDelete(id);
    await refreshRawThumbnails();
  }, [repos, refreshRawThumbnails]);

  return { profiles, saveProfile, deleteProfile };
}
