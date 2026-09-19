/**
 * Persist FileSystemDirectoryHandle instances across sessions via IndexedDB.
 *
 * Two purposes:
 *   1. Re-open the chosen catalog folder on the next page load (`catalogRoot`).
 *   2. Re-open per-LocalSource folder handles after the user picked a catalog
 *      via the new CatalogStorage (`source:<sourceId>`). The new sql.js
 *      `sources.config` JSON cannot hold a handle so we stash them here.
 */

const DB_NAME = 'photolib-storage-meta';
const STORE = 'handles';
const CATALOG_KEY = 'catalogRoot';

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const idb = req.result;
      if (!idb.objectStoreNames.contains(STORE)) idb.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const idb = await openIdb();
  return new Promise<T>((resolve, reject) => {
    const tx = idb.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => idb.close();
    tx.onerror = () => idb.close();
  });
}

// ─── Catalog root ───

export async function saveCatalogHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (s) => s.put(handle, CATALOG_KEY));
}

export async function loadCatalogHandle(): Promise<FileSystemDirectoryHandle | null> {
  const value = await withStore('readonly', (s) => s.get(CATALOG_KEY)) as FileSystemDirectoryHandle | undefined;
  return value ?? null;
}

export async function clearCatalogHandle(): Promise<void> {
  await withStore('readwrite', (s) => s.delete(CATALOG_KEY));
}

// ─── Per-source LocalSource handles ───

function sourceKey(sourceId: string): string {
  return `source:${sourceId}`;
}

export async function saveSourceHandle(sourceId: string, handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (s) => s.put(handle, sourceKey(sourceId)));
}

export async function loadSourceHandle(sourceId: string): Promise<FileSystemDirectoryHandle | null> {
  const value = await withStore('readonly', (s) => s.get(sourceKey(sourceId))) as FileSystemDirectoryHandle | undefined;
  return value ?? null;
}

export async function deleteSourceHandle(sourceId: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(sourceKey(sourceId)));
}

// ─── Permission helper ───

export async function ensureHandlePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  };
  if (!h.queryPermission || !h.requestPermission) return true;
  const state = await h.queryPermission({ mode: 'readwrite' });
  if (state === 'granted') return true;
  if (state === 'denied') return false;
  const granted = await h.requestPermission({ mode: 'readwrite' });
  return granted === 'granted';
}
