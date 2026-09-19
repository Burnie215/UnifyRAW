import type { CatalogStorage, CompactResult } from './CatalogStorage';

export type { CompactResult } from './CatalogStorage';

/**
 * Rewrites every thumb bin tightly and drops the records thumbIndex no
 * longer names. Folder-backed storages do it themselves, through the same
 * per-bin write queue their appends use (`FolderStorage.compactThumbs`);
 * memory storage keeps a Map and never accumulates slack.
 */
export async function compactThumbBins(storage: CatalogStorage): Promise<CompactResult> {
  if (storage.compactThumbs) return storage.compactThumbs();
  const now = Date.now();
  return { startedAt: now, finishedAt: now, binsTouched: 0, binsSkipped: 0, bytesBefore: 0, bytesAfter: 0, errors: ['no folder root (memory storage)'] };
}
