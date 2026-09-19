import type { CatalogStorage } from './CatalogStorage';

/** Hands the in-memory catalog to the browser as a .sqlite download. */
export function downloadCatalog(storage: CatalogStorage): void {
  const blob = new Blob([storage.exportDb() as BlobPart], { type: 'application/x-sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `photolib-catalog-${new Date().toISOString().slice(0, 10)}.sqlite`;
  a.click();
  URL.revokeObjectURL(url);
}
