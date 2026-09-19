import { useCallback } from 'react';
import { useRepos } from '../contexts/StorageContext';
import { splitMetaTargets, type PhotoMetaOutcome } from '../data/photoMeta';
import type { PhotoColorLabel, PhotoFlag } from '../storage/repos';

/**
 * Photo-level user metadata actions (rating/flag/colorLabel/keywords).
 *
 * In the new schema these fields live on photoMeta, keyed by contentHash.
 * We look up the contentHash for each photoId and dispatch to the meta
 * repo. Photos without a contentHash cannot carry metadata — they are
 * reported as `skipped` so the caller can say so, and they pick the value
 * up again after the first contentHash backfill.
 *
 * `expandIds` widens the selection before it is resolved: a rating given to
 * one half of a grouped RAW+JPEG pair belongs to the shot, not to the file,
 * and the two halves have different content hashes.
 *
 * `onPushable` fires after a write to a field a source could also hold
 * (rating, flag, keywords) and carries the photos that really took the write
 * — a skipped photo has nothing in photoMeta to send. That is the trigger the
 * optional metadata auto-push hangs on. A colour label has no counterpart in
 * any source, so it deliberately does not fire.
 */
export function usePhotoActions(
  onRefresh?: () => void,
  expandIds?: (photoIds: number[]) => number[],
  onPushable?: (photoIds: number[]) => void,
) {
  const repos = useRepos();

  const resolve = useCallback((photoIds: number[]) => {
    return splitMetaTargets(repos.photos.bulkGet(expandIds ? expandIds(photoIds) : photoIds));
  }, [expandIds, repos]);

  const write = useCallback((
    photoIds: number[],
    patch: Parameters<typeof repos.photoMeta.set>[1],
    pushable = true,
  ): PhotoMetaOutcome => {
    const { targets, skipped } = resolve(photoIds);
    for (const photo of targets) repos.photoMeta.set(photo.contentHash, patch);
    onRefresh?.();
    if (pushable) onPushable?.(targets.map((photo) => photo.id));
    return { applied: targets.length, skipped };
  }, [onPushable, onRefresh, repos, resolve]);

  const setRating = useCallback((photoIds: number[], rating: number) => {
    return write(photoIds, { rating });
  }, [write]);

  const setFlag = useCallback((photoIds: number[], flag: PhotoFlag) => {
    return write(photoIds, { flag });
  }, [write]);

  const setColorLabel = useCallback((photoIds: number[], colorLabel: PhotoColorLabel) => {
    return write(photoIds, { colorLabel }, false);
  }, [write]);

  const addKeywords = useCallback((photoIds: number[], keywords: string[]): PhotoMetaOutcome => {
    const { targets, skipped } = resolve(photoIds);
    for (const p of targets) {
      const existing = new Set(p.keywords);
      keywords.forEach((k) => existing.add(k.trim()));
      repos.photoMeta.set(p.contentHash, { keywords: Array.from(existing) });
    }
    onRefresh?.();
    onPushable?.(targets.map((photo) => photo.id));
    return { applied: targets.length, skipped };
  }, [onPushable, onRefresh, repos, resolve]);

  const removeKeyword = useCallback((photoIds: number[], keyword: string): PhotoMetaOutcome => {
    const { targets, skipped } = resolve(photoIds);
    for (const p of targets) {
      repos.photoMeta.set(p.contentHash, { keywords: p.keywords.filter((k) => k !== keyword) });
    }
    onRefresh?.();
    onPushable?.(targets.map((photo) => photo.id));
    return { applied: targets.length, skipped };
  }, [onPushable, onRefresh, repos, resolve]);

  return { setRating, setFlag, setColorLabel, addKeywords, removeKeyword };
}
