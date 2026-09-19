import { useState, useEffect, useCallback } from 'react';
import { useRepos, useStorageRevisions } from '../contexts/StorageContext';
import type { CollectionRow, CollectionRule, PhotoView } from '../storage/repos';
import { matchesCollectionRules } from '../data/collectionRules';

export function useCollections() {
  const repos = useRepos();
  const revisions = useStorageRevisions();
  const [collections, setCollections] = useState<CollectionRow[]>([]);

  const refresh = useCallback(() => {
    setCollections(repos.collections.list());
  }, [repos]);

  useEffect(() => { refresh(); }, [refresh, revisions.collections]);

  const addCollection = useCallback((name: string, type: 'manual' | 'smart', parentId?: number) => {
    return repos.collections.add({
      name,
      type,
      photoIds: type === 'manual' ? [] : null,
      rules: type === 'smart' ? [] : null,
      parentId: parentId ?? null,
    });
  }, [repos]);

  const deleteCollection = useCallback((id: number) => {
    const all = repos.collections.list();
    const toDelete = [id];
    const findChildren = (parentId: number) => {
      for (const c of all) {
        if (c.parentId === parentId) {
          toDelete.push(c.id);
          findChildren(c.id);
        }
      }
    };
    findChildren(id);
    repos.collections.bulkSoftDelete(toDelete);
  }, [repos]);

  const renameCollection = useCallback((id: number, name: string) => {
    repos.collections.update(id, { name });
  }, [repos]);

  /**
   * Add many photos in one write.
   *
   * One repo write, not one per photo: every write bumps the storage revision,
   * and that re-reads the whole photo table. Adding a two-hundred-photo
   * selection a photo at a time did it two hundred times.
   */
  const addPhotosToCollection = useCallback((collectionId: number, photoIds: readonly number[]) => {
    if (photoIds.length === 0) return;
    const col = repos.collections.get(collectionId);
    if (!col || col.type !== 'manual') return;
    const ids = new Set(col.photoIds ?? []);
    const before = ids.size;
    for (const id of photoIds) ids.add(id);
    if (ids.size === before) return;
    repos.collections.update(collectionId, { photoIds: Array.from(ids) });
  }, [repos]);

  /** Counterpart to `addPhotosToCollection`, same reason. */
  const removePhotosFromCollection = useCallback((collectionId: number, photoIds: readonly number[]) => {
    if (photoIds.length === 0) return;
    const col = repos.collections.get(collectionId);
    if (!col || col.type !== 'manual') return;
    const drop = new Set(photoIds);
    const kept = (col.photoIds ?? []).filter((id) => !drop.has(id));
    if (kept.length === (col.photoIds ?? []).length) return;
    repos.collections.update(collectionId, { photoIds: kept });
  }, [repos]);

  const updateSmartRules = useCallback((id: number, rules: CollectionRule[]) => {
    repos.collections.update(id, { rules });
  }, [repos]);

  const getSmartCollectionPhotos = useCallback((collection: CollectionRow): PhotoView[] => {
    if (collection.type !== 'smart') return [];
    return repos.photos.list().filter((photo) => matchesCollectionRules(photo, collection.rules));
  }, [repos]);

  const moveCollection = useCallback((id: number, newParentId: number | null) => {
    if (newParentId !== null) {
      const all = repos.collections.list();
      const isDescendant = (parentId: number, targetId: number): boolean => {
        for (const c of all) {
          if (c.parentId === parentId) {
            if (c.id === targetId) return true;
            if (isDescendant(c.id, targetId)) return true;
          }
        }
        return false;
      };
      if (isDescendant(id, newParentId) || id === newParentId) return;
    }
    repos.collections.update(id, { parentId: newParentId });
  }, [repos]);

  const getDescendantIds = useCallback((parentId: number): number[] => {
    const result: number[] = [];
    const findChildren = (pid: number) => {
      for (const c of collections) {
        if (c.parentId === pid) {
          result.push(c.id);
          findChildren(c.id);
        }
      }
    };
    findChildren(parentId);
    return result;
  }, [collections]);

  return {
    collections,
    addCollection,
    deleteCollection,
    renameCollection,
    moveCollection,
    getDescendantIds,
    addPhotosToCollection,
    removePhotosFromCollection,
    updateSmartRules,
    getSmartCollectionPhotos,
    refresh,
  };
}
