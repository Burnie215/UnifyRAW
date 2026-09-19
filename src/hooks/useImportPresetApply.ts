import { useCallback } from 'react';
import { useRepos } from '../contexts/StorageContext';
import { useAutoOrganize } from './useAutoOrganize';
import { loadImportPreset } from './useImportPreset';
import {
  findDevelopPreset,
  planImportPresetEdits,
  planImportPresetMeta,
  type AddedPhoto,
} from './importPresetPlan';

/**
 * Makes the import tab's preset do something.
 *
 * Two moments, both driven by the rows an ingest actually created:
 * `applyToNewPhotos` writes rating, flag, colour label, keywords and the
 * develop preset layer right after the rows land, `organizeNewPhotos` sorts
 * them into date collections once the run is over. Which rows are new comes
 * from `planIngest`, so a rescan - which produces updates, not additions -
 * reaches neither. What each write may touch is decided in
 * [importPresetPlan](./importPresetPlan.ts) and tested there.
 */
export function useImportPresetApply() {
  const repos = useRepos();
  const { organize } = useAutoOrganize();

  const applyToNewPhotos = useCallback((added: readonly AddedPhoto[]) => {
    if (added.length === 0) return;
    const hashes = added
      .map((photo) => photo.contentHash)
      .filter((hash): hash is string => !!hash);
    if (hashes.length === 0) return;

    const preset = loadImportPreset();
    for (const write of planImportPresetMeta(added, preset, repos.photoMeta.bulkGet(hashes))) {
      repos.photoMeta.set(write.contentHash, write.patch);
    }

    const developPreset = findDevelopPreset(repos.presets.list(), preset.developPreset);
    if (!developPreset) return;
    // One query for the whole table instead of one per photo: an import batch
    // is up to 500 rows.
    const edited = new Set(repos.edits.editedAtByHash().keys());
    for (const write of planImportPresetEdits(added, developPreset, edited)) {
      repos.edits.upsert({
        contentHash: write.contentHash,
        copyIndex: 0,
        adjustments: write.adjustments,
        document: write.document,
      });
    }
  }, [repos]);

  const organizeNewPhotos = useCallback((added: readonly AddedPhoto[]) => {
    if (added.length === 0) return;
    const preset = loadImportPreset();
    if (!preset.autoOrganize) return;
    // Only what this run imported: the setting is an import setting, and
    // re-filing the whole library after every scan is not what it promises.
    const photos = repos.photos.bulkGet(added.map((photo) => photo.id));
    if (photos.length === 0) return;
    organize(photos, preset.organizePattern);
  }, [organize, repos]);

  return { applyToNewPhotos, organizeNewPhotos };
}
