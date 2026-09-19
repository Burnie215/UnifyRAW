import type { Database } from 'sql.js';
import type { BackendMigration } from '../migrations.js';
import {
  ensureColumn,
  firstRow,
  rows,
  tableExists,
  tableHasColumn,
  type SqlParam,
} from './helpers.js';

export const syncIdentitiesMigration: BackendMigration = {
  version: 5,
  name: 'stable-sync-identities',
  up(db) {
    ensureSyncIdentitySchema(db);
    backfillLegacySyncIdentities(db);
  },
};

export function ensureSyncIdentitySchema(db: Database): void {
  if (!tableExists(db, 'presets') || !tableExists(db, 'collections')) return;
  ensureColumn(db, 'collections', 'parentSyncId', 'TEXT');
  ensureColumn(db, 'collections', 'photoRefs', 'TEXT');
  if (!tableHasColumn(db, 'presets', 'userId') || !tableHasColumn(db, 'collections', 'userId')) return;
  db.exec('CREATE INDEX IF NOT EXISTS idx_backend_presets_syncId ON presets(userId, syncId)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_backend_collections_syncId ON collections(userId, syncId)');
}

export function backfillLegacySyncIdentities(db: Database): void {
  if (!tableExists(db, 'presets') || !tableExists(db, 'collections')) return;
  if (!tableHasColumn(db, 'presets', 'userId') || !tableHasColumn(db, 'collections', 'userId')) return;

  // Best-effort conversion of legacy server-local IDs. Future clients send
  // stable source/photo references directly, so this path runs only once.
  const collections = rows(db, 'SELECT id, userId, parentId, photoIds FROM collections');
  for (const collection of collections) {
    const userId = String(collection.userId);
    let parentSyncId: string | null = null;
    if (collection.parentId != null) {
      parentSyncId = scalarString(
        db,
        'SELECT syncId FROM collections WHERE userId = ? AND id = ?',
        [userId, Number(collection.parentId)],
      );
    }

    const photoRefs: Array<{ sourceId: string; sourcePhotoId: string }> = [];
    for (const photoId of parseNumericArray(collection.photoIds)) {
      const photo = firstRow(
        db,
        'SELECT sourceId, sourcePhotoId FROM photos WHERE userId = ? AND id = ?',
        [userId, photoId],
      );
      if (photo?.sourceId != null && photo.sourcePhotoId != null) {
        photoRefs.push({
          sourceId: String(photo.sourceId),
          sourcePhotoId: String(photo.sourcePhotoId),
        });
      }
    }

    db.run(
      'UPDATE collections SET parentSyncId = ?, photoRefs = ? WHERE id = ?',
      [parentSyncId, JSON.stringify(photoRefs), Number(collection.id)],
    );
  }
}

function scalarString(db: Database, sql: string, params: SqlParam[]): string | null {
  const row = firstRow(db, sql, params);
  if (!row) return null;
  const value = Object.values(row)[0];
  return value == null ? null : String(value);
}

function parseNumericArray(value: unknown): number[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0)
      : [];
  } catch {
    return [];
  }
}
