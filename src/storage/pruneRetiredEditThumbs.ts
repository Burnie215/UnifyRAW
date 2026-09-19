import type { Database } from 'sql.js';
import { editThumbnailKey } from '../cache/editThumbnailKey';
import { thumbnailStampFor } from '../engine/thumbnailStamp';
import type { ThumbSize } from './CatalogStorage';

const EDIT_PREFIX = 'edit:';

/** The content hash inside `edit:<hash>` or `edit:<stamp>:<hash>`. */
function hashOfEditKey(key: string): string {
  const rest = key.slice(EDIT_PREFIX.length);
  return rest.slice(rest.lastIndexOf(':') + 1);
}

/**
 * Delete the developed thumbnails stored under a profile stamp that no longer
 * applies, and return how many index rows went.
 *
 * A profile change moves the photo to a new key (see `engine/thumbnailStamp`)
 * and leaves the old rendering behind, one per change. For each hash only the
 * key the gallery would ask for today survives. A hash with no live photo in
 * the catalog is left alone: without the photo there is no telling which of
 * its keys is the current one.
 */
export async function pruneRetiredEditThumbs(
  db: Database,
  thumbnails: { delete(key: string, size?: ThumbSize): Promise<void> },
): Promise<number> {
  const byHash = new Map<string, Array<{ key: string; size: ThumbSize }>>();
  const rows = db.exec(`SELECT contentHash, size FROM thumbIndex WHERE contentHash LIKE '${EDIT_PREFIX}%'`);
  for (const [key, size] of rows[0]?.values ?? []) {
    const hash = hashOfEditKey(String(key));
    const list = byHash.get(hash) ?? [];
    list.push({ key: String(key), size: size as ThumbSize });
    byHash.set(hash, list);
  }

  let removed = 0;
  const photoStmt = db.prepare(
    'SELECT name, camera, iso, lens, focalLength FROM photos WHERE contentHash = ? AND deletedAt IS NULL LIMIT 1',
  );
  try {
    for (const [hash, entries] of byHash) {
      photoStmt.bind([hash]);
      const photo = photoStmt.step()
        ? photoStmt.getAsObject() as { name: string; camera: string | null; iso: number | null; lens: string | null; focalLength: number | null }
        : null;
      photoStmt.reset();
      if (!photo) continue;

      const current = editThumbnailKey(hash, thumbnailStampFor(photo));
      for (const entry of entries) {
        if (entry.key === current) continue;
        await thumbnails.delete(entry.key, entry.size);
        removed++;
      }
    }
  } finally {
    photoStmt.free();
  }
  return removed;
}
