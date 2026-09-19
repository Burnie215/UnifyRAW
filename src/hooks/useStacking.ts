import { useCallback, useMemo } from 'react';
import { useRepos } from '../contexts/StorageContext';
import type { PhotoView } from '../storage/repos';
import {
  planAutoStack, planCreateStack, planSetStackHead, planUnstack, plannedStackCount,
  type StackIndex, type StackUpdate,
} from '../data/photoStacks';

/**
 * Turns the stacking plans from [photoStacks](../data/photoStacks.ts) into
 * catalog writes. The rules live there; this hook only resolves ids against the
 * photos it was given, writes one batch, and tells the library to reload.
 */
export function useStacking(photos: PhotoView[], index: StackIndex, onPhotosChanged: () => void) {
  const repos = useRepos();
  const byId = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);

  const resolve = useCallback(
    (photoIds: readonly number[]): PhotoView[] =>
      photoIds.map((id) => byId.get(id)).filter((photo): photo is PhotoView => !!photo),
    [byId],
  );

  const apply = useCallback((updates: StackUpdate[]): boolean => {
    if (updates.length === 0) return false;
    repos.photos.bulkUpdate(updates);
    onPhotosChanged();
    return true;
  }, [repos, onPhotosChanged]);

  /** Stacks the given photos into one new stack. */
  const stackPhotos = useCallback(
    (photoIds: readonly number[]): boolean => apply(planCreateStack(resolve(photoIds), crypto.randomUUID())),
    [apply, resolve],
  );

  const unstackPhotos = useCallback(
    (photoIds: readonly number[]): boolean => apply(planUnstack(resolve(photoIds))),
    [apply, resolve],
  );

  const setStackHead = useCallback(
    (photoId: number): boolean => apply(planSetStackHead(photoId, index)),
    [apply, index],
  );

  /** Groups bursts of untouched photos; returns how many stacks were created. */
  const autoStack = useCallback((): number => {
    const updates = planAutoStack(photos, () => crypto.randomUUID());
    apply(updates);
    return plannedStackCount(updates);
  }, [apply, photos]);

  return { autoStack, stackPhotos, unstackPhotos, setStackHead };
}
