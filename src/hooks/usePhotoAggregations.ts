import { useMemo } from 'react';
import type { PhotoView, SourceRow } from '../storage/repos';
import type { KeywordAggregation } from '../data/keywordTree';

export function aggregateKeywords(photos: PhotoView[]): KeywordAggregation[] {
  const photoIdentitiesByKeyword = new Map<string, Set<string>>();
  photos.forEach((photo, index) => {
    const identity = typeof photo.id === 'number' ? `photo:${photo.id}` : `pending:${index}`;
    for (const keyword of new Set(photo.keywords ?? [])) {
      let identities = photoIdentitiesByKeyword.get(keyword);
      if (!identities) {
        identities = new Set();
        photoIdentitiesByKeyword.set(keyword, identities);
      }
      identities.add(identity);
    }
  });

  return Array.from(photoIdentitiesByKeyword.entries())
    .map(([keyword, photoIdentities]) => ({
      keyword,
      count: photoIdentities.size,
      photoIdentities,
    }))
    .sort((a, b) => a.keyword.localeCompare(b.keyword));
}

/**
 * Pure derived aggregations over the photo list:
 * - allKeywords with usage counts (alpha-sorted)
 * - unique cameras / lenses (alpha-sorted)
 * - per-source photo counts
 * - folder tree as a flat path→count map plus a source-id→label map
 *
 * Hidden sources are excluded from the folder tree only (counts and lists
 * still cover all photos so the sidebar source list stays accurate).
 */
export function usePhotoAggregations(
  photos: PhotoView[],
  sources: SourceRow[],
  hiddenSources: Set<string>,
) {
  const allKeywords = useMemo(() => {
    return aggregateKeywords(photos);
  }, [photos]);

  const cameras = useMemo(() => {
    const set = new Set<string>();
    for (const p of photos) if (p.camera) set.add(p.camera);
    return Array.from(set).sort();
  }, [photos]);

  const lenses = useMemo(() => {
    const set = new Set<string>();
    for (const p of photos) if (p.lens) set.add(p.lens);
    return Array.from(set).sort();
  }, [photos]);

  const photoCountBySource = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of photos) {
      counts[p.sourceId] = (counts[p.sourceId] ?? 0) + 1;
    }
    return counts;
  }, [photos]);

  const sourceLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sources) map.set(s.id, s.label);
    return map;
  }, [sources]);

  const folderTree = useMemo(() => {
    const tree = new Map<string, number>();
    for (const p of photos) {
      if (hiddenSources.has(p.sourceId)) continue;
      const sourceKey = `§${p.sourceId}`;
      tree.set(sourceKey, (tree.get(sourceKey) ?? 0) + 1);
      const parts = (p.sourcePath ?? p.sourcePhotoId).split('/');
      for (let i = 1; i < parts.length; i++) {
        const path = sourceKey + '/' + parts.slice(0, i).join('/');
        tree.set(path, (tree.get(path) ?? 0) + 1);
      }
    }
    return { tree, sourceLabels };
  }, [photos, hiddenSources, sourceLabels]);

  return { allKeywords, cameras, lenses, photoCountBySource, sourceLabels, folderTree };
}
