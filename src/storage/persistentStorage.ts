/**
 * What the browser promises about the catalog it is holding.
 *
 * `best-effort` is the default for OPFS and means evictable: browsers drop it
 * under storage pressure, and WebKit deletes script-written storage after
 * seven days without a visit. `persistent` is what
 * navigator.storage.persist() grants - after that only the user can remove it.
 */
export type PersistenceState = 'unknown' | 'best-effort' | 'persistent';

/** Reads the current promise without asking for a better one. */
export async function readPersistence(): Promise<PersistenceState> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.persisted !== 'function') {
    return 'unknown';
  }
  try {
    return await navigator.storage.persisted() ? 'persistent' : 'best-effort';
  } catch {
    return 'unknown';
  }
}

/**
 * Asks the browser to keep this origin's storage for good, and reports what
 * it answered.
 *
 * Chromium and WebKit decide from engagement history without showing
 * anything; Firefox turns this into a permission prompt, which is why the
 * caller picks the moment (shouldAskForPersistence) rather than asking at
 * startup. A refusal is not an error: the catalog keeps working, it is merely
 * evictable, and the storage tab says so.
 */
export async function requestPersistence(): Promise<PersistenceState> {
  const already = await readPersistence();
  if (already !== 'best-effort') return already;
  try {
    return await navigator.storage.persist() ? 'persistent' : 'best-effort';
  } catch {
    return 'best-effort';
  }
}
