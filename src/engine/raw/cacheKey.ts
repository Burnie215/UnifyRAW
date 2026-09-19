export interface RawCacheIdentity {
  sourceId: string;
  sourcePhotoId: string;
  sizeBytes?: number | null;
  dateModified?: number | null;
  sourceRevision?: number | null;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Stable, filename-safe RAW cache identity. File metadata is deliberately
 * part of the key so replacing a local file at the same path cannot serve
 * stale decoded pixels. The hash also prevents collisions after truncation.
 *
 * `contentHash` is deliberately NOT an input, although the row has one. It is
 * computed lazily on the first editor open, so a key that used it named the
 * photo differently before and after that open: the first open decoded under
 * `size|mtime|rev` and every later one looked under the hash, missed, and
 * decoded again - measured in the running app, one full re-decode per open for
 * every photo of the 22 providers that do not hash during the scan (F087 put a
 * cache migration behind this, which lost the race against the decode it was
 * meant to move). It also bought no invalidation: `ensureContentHash` returns
 * early once a row has a hash, so the hash never changes again either.
 */
export function makeRawCacheKey(photo: RawCacheIdentity): string {
  const version = `size:${photo.sizeBytes ?? 'unknown'}|mtime:${photo.dateModified ?? 'unknown'}|rev:${photo.sourceRevision ?? 0}`;
  const identity = `${photo.sourceId}|${photo.sourcePhotoId}|${version}`;
  const readable = `${photo.sourceId}_${photo.sourcePhotoId}`
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 120);
  return `${readable}_${fnv1a(identity)}`;
}
