import { useCallback, useEffect, useMemo } from 'react';
import { useRepos, useStorageRevisions } from '../contexts/StorageContext';
import type { LensCoefficients } from '../engine/lensProfile';
import { setLensProfiles } from '../engine/lensProfileStore';
import { RawDecoder } from '../engine/RawDecoder';

/**
 * Keeps the catalog's measured lens profiles in the store the render paths
 * read from, and refreshes what a write invalidates.
 *
 * Same shape as `useDevelopProfiles`, and for the same reason: the exporter
 * and the background thumbnail renderer are not in the React tree.
 */
export function useLensProfiles() {
  const repos = useRepos();
  const revisions = useStorageRevisions();

  const profiles = useMemo(
    () => repos.lensProfiles.list(),
    // A write to lensProfiles is the only thing that can change this list; the
    // linter cannot trace a method call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repos, revisions.lensProfiles],
  );

  useEffect(() => {
    setLensProfiles(profiles);
  }, [profiles]);

  /** Same nudge as `useDevelopProfiles.refreshRawThumbnails`, and for the same
   *  reason - the key's profile stamp handles invalidation, but a tile already
   *  on screen has to be told to look again. */
  const refreshRawThumbnails = useCallback(async () => {
    setLensProfiles(repos.lensProfiles.list());
    const { thumbMemCache } = await import('../cache/ThumbMemCache');
    const { forgetColdThumbnails } = await import('../engine/ThumbnailRenderer');
    forgetColdThumbnails();
    for (const photo of repos.photos.list({})) {
      if (!photo.contentHash || !RawDecoder.isRawFile(photo.name)) continue;
      thumbMemCache.remove(photo.id);
    }
  }, [repos]);

  const saveLensProfile = useCallback(async (args: {
    name: string;
    key: string;
    focalFrom?: number | null;
    focalTo?: number | null;
    coefficients: LensCoefficients;
  }) => {
    const row = repos.lensProfiles.save(args);
    await refreshRawThumbnails();
    return row;
  }, [repos, refreshRawThumbnails]);

  const deleteLensProfile = useCallback(async (id: number) => {
    repos.lensProfiles.softDelete(id);
    await refreshRawThumbnails();
  }, [repos, refreshRawThumbnails]);

  return { lensProfiles: profiles, saveLensProfile, deleteLensProfile };
}
