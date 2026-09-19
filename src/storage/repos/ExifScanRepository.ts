import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';

/**
 * Which photos this device has already read from disk looking for EXIF.
 *
 * Local-only, next to thumbIndex and faces: the mark says "these bytes were
 * read here", so it must not travel through the hub - a device that has never
 * seen the file would inherit "already scanned" and leave its capture columns
 * empty forever.
 *
 * Marking takes no `onWrite`, unlike every synced repository: a mark changes
 * nothing any view shows, and bumping the storage revision would reload the
 * whole photo table for it (F086).
 */
export class ExifScanRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;

  constructor(storage: CatalogStorage) {
    this.storage = storage;
    this.db = storage.db;
  }

  /** Ids of every photo whose file was read here, whether it had EXIF or not. */
  scannedIds(): Set<number> {
    const rows = this.db.exec('SELECT photoId FROM exifScan')[0]?.values ?? [];
    return new Set(rows.map((row) => Number(row[0])));
  }

  markScanned(photoIds: readonly number[], at: number = Date.now()): void {
    if (photoIds.length === 0) return;
    const stmt = this.db.prepare('INSERT OR REPLACE INTO exifScan (photoId, scannedAt) VALUES (?, ?)');
    this.db.run('BEGIN');
    try {
      for (const id of photoIds) stmt.run([id, at]);
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    } finally {
      stmt.free();
    }
    this.storage.flush();
  }

  /** Drop the mark, so the next backfill run reads the file again. */
  forget(photoIds: readonly number[]): void {
    if (photoIds.length === 0) return;
    const placeholders = photoIds.map(() => '?').join(',');
    this.db.run(`DELETE FROM exifScan WHERE photoId IN (${placeholders})`, [...photoIds]);
    this.storage.flush();
  }
}
