/**
 * In-memory negative cache for assets that the upstream source reports as
 * missing/inaccessible (HTTP 400/404). Without this, every grid re-render +
 * hover triggers another fetch for the same stale asset → backend spam.
 *
 * Key format: `${sourceId}|${sourcePhotoId}|${op}` where `op` is one of
 * `file`, `thumb`, `display`. Different ops are cached separately because a
 * source may serve a thumbnail but not the original (or vice versa).
 *
 * TTL is short (5 min) so transient outages auto-recover; permanent deletes
 * stay quiet until either TTL expires (5min retry) or the user clears the
 * cache manually.
 */

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, number>();
/** In-flight dedupe: when multiple consumers request the same asset
 *  concurrently we attach to a single shared promise instead of firing
 *  N parallel /api/proxy requests that will all 400 in the same way. */
const inflight = new Map<string, Promise<unknown>>();

export type StaleAssetOp = 'file' | 'thumb' | 'display';

function key(sourceId: string, sourcePhotoId: string, op: StaleAssetOp): string {
  return `${sourceId}|${sourcePhotoId}|${op}`;
}

export function isStale(sourceId: string, sourcePhotoId: string, op: StaleAssetOp): boolean {
  const k = key(sourceId, sourcePhotoId, op);
  const expiry = cache.get(k);
  if (expiry === undefined) return false;
  if (Date.now() >= expiry) {
    cache.delete(k);
    return false;
  }
  return true;
}

export function markStale(sourceId: string, sourcePhotoId: string, op: StaleAssetOp): void {
  const k = key(sourceId, sourcePhotoId, op);
  const wasNew = !cache.has(k);
  cache.set(k, Date.now() + TTL_MS);
  if (wasNew) notifyListeners(sourceId, sourcePhotoId);
}

/** Mark all ops stale for one asset — used when we know an asset is fully gone. */
export function markStaleAll(sourceId: string, sourcePhotoId: string): void {
  markStale(sourceId, sourcePhotoId, 'file');
  markStale(sourceId, sourcePhotoId, 'thumb');
  markStale(sourceId, sourcePhotoId, 'display');
}

/** Set of (sourceId|sourcePhotoId) tuples that any op has marked stale. */
const detectedAssets = new Set<string>();
type StaleListener = (sourceId: string, sourcePhotoId: string, totalDetected: number) => void;
const listeners = new Set<StaleListener>();

function notifyListeners(sourceId: string, sourcePhotoId: string): void {
  const assetKey = `${sourceId}|${sourcePhotoId}`;
  const isNew = !detectedAssets.has(assetKey);
  detectedAssets.add(assetKey);
  if (isNew) {
    for (const l of listeners) {
      try { l(sourceId, sourcePhotoId, detectedAssets.size); } catch { /* */ }
    }
  }
}

export function onStaleDetected(listener: StaleListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function detectedStaleAssets(): Array<{ sourceId: string; sourcePhotoId: string }> {
  return Array.from(detectedAssets).map((s) => {
    const [sourceId, sourcePhotoId] = s.split('|');
    return { sourceId, sourcePhotoId };
  });
}

export function clearDetectedAssets(): void {
  detectedAssets.clear();
}

export function clearStaleCache(): void {
  cache.clear();
}

/**
 * Dedupe concurrent fetches for the same (sourceId, sourcePhotoId, op).
 * If another caller is already fetching, attach to its promise instead of
 * launching a duplicate request.
 */
export async function dedupeFetch<T>(
  sourceId: string,
  sourcePhotoId: string,
  op: StaleAssetOp,
  fetcher: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  // A signalled read has one owner. Sharing it would let that owner abort
  // every waiter, while joining an older flight would leave its own abort
  // unable to stop the actual IO. Keep only unowned/background reads shared.
  if (signal) return fetcher();
  const k = key(sourceId, sourcePhotoId, op);
  const existing = inflight.get(k);
  if (existing) return existing as Promise<T>;
  const promise = fetcher().finally(() => {
    inflight.delete(k);
  });
  inflight.set(k, promise);
  return promise;
}

/**
 * Share the binary fetch, but give every caller ownership of its own object
 * URL. Consumers revoke the URL when they finish, so sharing the URL itself
 * lets one consumer invalidate another consumer's still-visible image.
 */
export async function dedupeObjectUrlFetch(
  sourceId: string,
  sourcePhotoId: string,
  op: StaleAssetOp,
  fetcher: () => Promise<Blob | null>,
  signal?: AbortSignal,
): Promise<string | null> {
  const blob = await dedupeFetch(sourceId, sourcePhotoId, op, fetcher, signal);
  if (signal?.aborted) return null;
  return blob ? URL.createObjectURL(blob) : null;
}

export function staleCacheSize(): number {
  return cache.size;
}
