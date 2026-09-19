import { useCallback } from 'react';
import { useRepos } from '../contexts/StorageContext';
import type { CollectionRepository, CollectionRow, PhotoView } from '../storage/repos';

export type OrganizePattern = 'year' | 'year-month' | 'year-month-day';

const MONTH_NAMES = [
  'Januar', 'Februar', 'Maerz', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

/**
 * Auto-organize photos into date-based collections.
 *
 * Creates a hierarchy: Year → Month (→ Day) as nested collection sets.
 * Photos without dateTaken go into "Ohne Datum".
 * Idempotent: re-running merges into existing collections.
 */
export function useAutoOrganize() {
  const repos = useRepos();

  const organize = useCallback((
    photos: PhotoView[],
    pattern: OrganizePattern = 'year-month',
    refreshCollections?: () => void,
  ) => {
    const groups = new Map<string, { year: number; month: number; day: number; photoIds: number[] }>();

    for (const p of photos) {
      const date = p.dateTaken ? new Date(p.dateTaken) : null;
      const year = date?.getFullYear() ?? 0;
      const month = date?.getMonth() ?? 0;
      const day = date?.getDate() ?? 0;

      let key: string;
      if (!date) key = 'no-date';
      else if (pattern === 'year') key = `${year}`;
      else if (pattern === 'year-month') key = `${year}-${month}`;
      else key = `${year}-${month}-${day}`;

      if (!groups.has(key)) groups.set(key, { year, month, day, photoIds: [] });
      groups.get(key)!.photoIds.push(p.id);
    }

    const existing = repos.collections.list();
    const existingByName = new Map<string, CollectionRow>();
    for (const c of existing) {
      const parentKey = c.parentId ? `${c.parentId}:${c.name}` : c.name;
      existingByName.set(parentKey, c);
    }

    const yearCollections = new Map<number, number>();

    for (const [key, group] of groups) {
      if (key === 'no-date') {
        const col = ensureCollection(repos.collections, existingByName, 'Ohne Datum', null);
        mergePhotoIds(repos.collections, col.id, group.photoIds);
        continue;
      }

      if (!yearCollections.has(group.year)) {
        const yearCol = ensureCollection(repos.collections, existingByName, `${group.year}`, null);
        yearCollections.set(group.year, yearCol.id);
      }

      if (pattern === 'year') {
        mergePhotoIds(repos.collections, yearCollections.get(group.year)!, group.photoIds);
        continue;
      }

      const yearId = yearCollections.get(group.year)!;
      const monthName = MONTH_NAMES[group.month];
      const monthCol = ensureCollection(repos.collections, existingByName, monthName, yearId);

      if (pattern === 'year-month') {
        mergePhotoIds(repos.collections, monthCol.id, group.photoIds);
        continue;
      }

      const dayName = `${group.day}. ${monthName}`;
      const dayCol = ensureCollection(repos.collections, existingByName, dayName, monthCol.id);
      mergePhotoIds(repos.collections, dayCol.id, group.photoIds);
    }

    refreshCollections?.();
  }, [repos]);

  return { organize };
}

function ensureCollection(
  repo: CollectionRepository,
  existingByName: Map<string, CollectionRow>,
  name: string,
  parentId: number | null,
): CollectionRow {
  const key = parentId ? `${parentId}:${name}` : name;
  const found = existingByName.get(key);
  if (found) return found;

  const id = repo.add({ name, type: 'manual', photoIds: [], parentId });
  const created = repo.get(id);
  if (!created) throw new Error(`failed to add collection ${name}`);
  existingByName.set(key, created);
  return created;
}

function mergePhotoIds(repo: CollectionRepository, collectionId: number, newIds: number[]): void {
  const col = repo.get(collectionId);
  if (!col) return;
  const existing = new Set(col.photoIds ?? []);
  let changed = false;
  for (const id of newIds) {
    if (!existing.has(id)) {
      existing.add(id);
      changed = true;
    }
  }
  if (changed) repo.update(collectionId, { photoIds: Array.from(existing) });
}
