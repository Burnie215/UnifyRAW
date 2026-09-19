import { detectedStaleAssets, clearDetectedAssets } from './staleAssetCache';
import type { PhotoRepository } from '../storage/repos';

/**
 * Walk the catalog and remove every photo whose (sourceId, sourcePhotoId)
 * tuple was reported stale (404/400 from upstream) during this session.
 *
 * Returns the count of removed catalog rows. Stale-detection set is cleared
 * afterwards so a new run starts fresh.
 */
export function removeDetectedStalePhotos(photoRepo: PhotoRepository): number {
  const stale = detectedStaleAssets();
  if (stale.length === 0) return 0;

  const staleSet = new Set(stale.map((s) => `${s.sourceId}|${s.sourcePhotoId}`));
  const all = photoRepo.listRaw();
  const toDelete: number[] = [];
  for (const p of all) {
    if (p.id && staleSet.has(`${p.sourceId}|${p.sourcePhotoId}`)) {
      toDelete.push(p.id);
    }
  }
  if (toDelete.length > 0) {
    photoRepo.bulkSoftDelete(toDelete);
  }
  clearDetectedAssets();
  return toDelete.length;
}
