import type { StorageKind } from './CatalogStorage';

/** Lets go of a held catalog lock; resolves once another open can take it. */
export type CatalogLockRelease = () => Promise<void>;

/**
 * OPFS holds one catalog per origin. A picked folder is known by its name
 * only: handles cannot be compared across tabs without a round trip through
 * IndexedDB, and two different folders with the same name merely cost an
 * unnecessary read-only mode.
 */
export function catalogLockName(kind: StorageKind, root: FileSystemDirectoryHandle): string {
  return kind === 'opfs' ? 'photolib-catalog:opfs' : `photolib-catalog:${kind}:${root.name}`;
}

function lockManager(): LockManager | null {
  if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') return null;
  return navigator.locks;
}

/**
 * Takes the exclusive lock for a catalog without waiting: resolves with the
 * release function, or null while another tab holds it. Without Web Locks
 * (Safari < 15.4, Firefox < 96, node) the catalog opens writable as before,
 * without multi-tab protection.
 */
export function acquireCatalogLock(name: string): Promise<CatalogLockRelease | null> {
  const locks = lockManager();
  if (!locks) {
    console.info(`[storage] Web Locks unavailable, ${name} opens without multi-tab protection`);
    return Promise.resolve(() => Promise.resolve());
  }
  return new Promise((resolve, reject) => {
    // Settles only after the lock is gone, which is what a release has to wait for.
    const held: Promise<unknown> = locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return undefined;
      }
      return new Promise<void>((letGo) => {
        resolve(async () => {
          letGo();
          await held;
        });
      });
    });
    held.catch(reject);
  });
}

/**
 * Resolves once the holder of `name` lets go. The lock is handed back at
 * once; the caller only learns that the catalog is free.
 */
export async function waitForCatalogLock(name: string, signal?: AbortSignal): Promise<void> {
  const locks = lockManager();
  if (!locks) throw new Error('Web Locks unavailable');
  await locks.request(name, { signal }, () => undefined);
}
