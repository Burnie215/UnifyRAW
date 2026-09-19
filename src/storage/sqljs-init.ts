import initSqlJs, { type SqlJsStatic, type Database } from 'sql.js';
// Vite resolves this to a hashed URL for the WASM asset.
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { CATALOG_SCHEMA_SQL, CATALOG_SCHEMA_VERSION, SYNC_TABLES, type SyncTableName } from '@photolib/shared';
import { exportSyncId } from './repos/ExportRepository';
import type { ExportRow } from './repos/types';

/** schema_meta key of the catalog-wide counter that numbers local writes (localSeq). */
export const LOCAL_SEQ_KEY = 'sync.localSeq';

let sqlPromise: Promise<SqlJsStatic> | null = null;

export function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => sqlWasmUrl });
  }
  return sqlPromise;
}

export async function createEmptyCatalogDb(): Promise<Database> {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  db.exec(CATALOG_SCHEMA_SQL);
  applyClientOverlay(db);
  const stmt = db.prepare('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)');
  stmt.run(['version', String(CATALOG_SCHEMA_VERSION)]);
  stmt.run(['createdAt', String(Date.now())]);
  stmt.free();
  return db;
}

export async function openCatalogDbFromBytes(bytes: Uint8Array): Promise<Database> {
  const SQL = await getSqlJs();
  const db = new SQL.Database(bytes);
  // Index creation in the canonical schema references the v3 syncId columns,
  // so additive columns must exist before applying that idempotent schema.
  ensureSyncIdentityColumns(db);
  // Apply schema-idempotently to upgrade existing DBs missing tables/indexes.
  db.exec(CATALOG_SCHEMA_SQL);
  migrateCatalogDb(db);
  applyClientOverlay(db);
  return db;
}

/**
 * Give every sync table the client overlay (CLIENT_OVERLAY in
 * @photolib/shared): a localSeq column that two triggers set to the next value
 * of LOCAL_SEQ_KEY on every local write, so push selects "written here since
 * the last push" without trusting any clock. A pull writes a negative
 * localSeq itself, which keeps the triggers out of it.
 *
 * A catalog from before the overlay tracked push by updatedAt
 * (sync.<table>.pushAt): the rows above that mark are numbered in updatedAt
 * order, and both old watermarks are dropped, so the next pull starts at
 * revision 0 (a full pull, harmless under LWW).
 */
export function applyClientOverlay(db: Database): void {
  inTransaction(db, () => {
    let seq = localSeqCounter(db);
    for (const table of SYNC_TABLES) {
      if (!tableColumns(db, table).has('localSeq')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN localSeq INTEGER NOT NULL DEFAULT 0`);
        const pushAt = Number(metaValue(db, `sync.${table}.pushAt`) ?? 0);
        seq = numberRows(db, table, seq, 'updatedAt > ?', [Number.isFinite(pushAt) ? pushAt : 0]);
        db.run('DELETE FROM schema_meta WHERE key IN (?, ?)', [`sync.${table}.pushAt`, `sync.${table}.pullAt`]);
      }
      seq = Math.max(seq, Number(db.exec(`SELECT COALESCE(MAX(localSeq), 0) FROM ${table}`)[0].values[0][0]));
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_localSeq ON ${table}(localSeq)`);
      db.exec(localSeqTriggers(table));
    }
    setLocalSeqCounter(db, seq);
  });
}

/**
 * Mark every row of every sync table as written here, in updatedAt order, so
 * the next push sends the whole catalog. Returns how many rows were marked.
 */
export function markAllForPush(db: Database): number {
  return inTransaction(db, () => {
    const first = localSeqCounter(db);
    let seq = first;
    for (const table of SYNC_TABLES) seq = numberRows(db, table, seq);
    setLocalSeqCounter(db, seq);
    return seq - first;
  });
}

/**
 * Take `count` numbers for a bulk write that sets localSeq itself instead of
 * leaving it to the triggers; returns the first. Call inside the write's
 * transaction, so a rollback returns them.
 */
export function reserveLocalSeqs(db: Database, count: number): number {
  const first = localSeqCounter(db) + 1;
  setLocalSeqCounter(db, first + count - 1);
  return first;
}

// The counter only grows. A per-table MAX(localSeq)+1 would fall back to 0
// once every row came from a pull (localSeq < 0), and below the push
// watermark after the newest row is hard-deleted; either way a write would
// never be pushed.
//
// An update that leaves updatedAt alone is nothing the hub would take (LWW
// needs a newer updatedAt): a rescan of an unchanged library, or collection
// references resolved after a pull. Those stay unmarked.
function localSeqTriggers(table: SyncTableName): string {
  const bump = `
    INSERT INTO schema_meta(key, value) VALUES ('${LOCAL_SEQ_KEY}', '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1;
    UPDATE ${table}
      SET localSeq = (SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key = '${LOCAL_SEQ_KEY}')
      WHERE rowid = NEW.rowid;`;
  return `
    DROP TRIGGER IF EXISTS trg_${table}_seq_ins;
    DROP TRIGGER IF EXISTS trg_${table}_seq_upd;
    CREATE TRIGGER trg_${table}_seq_ins AFTER INSERT ON ${table}
      WHEN NEW.localSeq = 0
      BEGIN ${bump} END;
    CREATE TRIGGER trg_${table}_seq_upd AFTER UPDATE ON ${table}
      WHEN NEW.localSeq = OLD.localSeq AND NEW.updatedAt IS NOT OLD.updatedAt
      BEGIN ${bump} END;`;
}

/** Give the rows matching `where` the next numbers after `seq`, in updatedAt order; returns the last one. */
function numberRows(db: Database, table: SyncTableName, seq: number, where = '1', params: number[] = []): number {
  const rowids = db.exec(`SELECT rowid FROM ${table} WHERE ${where} ORDER BY updatedAt, rowid`, params)[0]?.values ?? [];
  const stmt = db.prepare(`UPDATE ${table} SET localSeq = ? WHERE rowid = ?`);
  try {
    for (const [rowid] of rowids) {
      seq += 1;
      stmt.run([seq, Number(rowid)]);
    }
  } finally {
    stmt.free();
  }
  return seq;
}

function localSeqCounter(db: Database): number {
  return Number(metaValue(db, LOCAL_SEQ_KEY) ?? 0) || 0;
}

function setLocalSeqCounter(db: Database, value: number): void {
  db.run('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)', [LOCAL_SEQ_KEY, String(value)]);
}

function metaValue(db: Database, key: string): string | null {
  const value = db.exec('SELECT value FROM schema_meta WHERE key = ?', [key])[0]?.values[0]?.[0];
  return value == null ? null : String(value);
}

function inTransaction<T>(db: Database, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  }
}

function migrateCatalogDb(db: Database): void {
  const columns = tableColumns(db, 'photos');
  db.exec('BEGIN');
  try {
    if (!columns.has('sourcePath')) db.exec('ALTER TABLE photos ADD COLUMN sourcePath TEXT');
    if (!columns.has('availability')) {
      db.exec("ALTER TABLE photos ADD COLUMN availability TEXT NOT NULL DEFAULT 'online'");
    }
    if (!columns.has('sourceRevision')) {
      db.exec('ALTER TABLE photos ADD COLUMN sourceRevision INTEGER NOT NULL DEFAULT 0');
    }
    // Nullable on purpose: an existing catalog has probed nothing yet, and
    // NULL is what tells the probe to read the file once.
    if (!columns.has('sourceBits')) db.exec('ALTER TABLE photos ADD COLUMN sourceBits INTEGER');
    db.run('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)', [
      'version',
      String(CATALOG_SCHEMA_VERSION),
    ]);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve migration error */ }
    throw error;
  }
}

function ensureSyncIdentityColumns(db: Database): void {
  for (const [table, prefix] of [['presets', 'legacy-preset-'], ['collections', 'legacy-collection-']] as const) {
    const columns = tableColumns(db, table);
    if (columns.size === 0) continue;
    if (!columns.has('syncId')) db.exec(`ALTER TABLE ${table} ADD COLUMN syncId TEXT`);
    db.run(
      `UPDATE ${table} SET syncId = ? || createdAt WHERE syncId IS NULL OR syncId = ''`,
      [prefix],
    );
  }
  ensureExportSyncIds(db);
}

/**
 * Give a ledger written before the column its `syncId`, derived from the same
 * five columns the canonical schema derives it from, so a ledger entry means
 * the same row here as on every other device.
 *
 * The unique key comes as a named index rather than the schema's
 * `UNIQUE(syncId)`: a table that already exists is untouched by
 * CREATE TABLE IF NOT EXISTS, and without any unique key the ON CONFLICT in
 * ExportRepository has no conflict target and every export would throw. The
 * old identity index guaranteed the derived ids are distinct, so the index
 * cannot fail to build.
 */
function ensureExportSyncIds(db: Database): void {
  const columns = tableColumns(db, 'exports');
  if (columns.size === 0 || columns.has('syncId')) return;
  db.exec('ALTER TABLE exports ADD COLUMN syncId TEXT');
  const rows = db.exec(
    'SELECT rowid, contentHash, copyIndex, targetSourceId, editStackHash, format FROM exports',
  )[0]?.values ?? [];
  const update = db.prepare('UPDATE exports SET syncId = ? WHERE rowid = ?');
  try {
    for (const [rowid, contentHash, copyIndex, targetSourceId, editStackHash, format] of rows) {
      update.run([
        exportSyncId({
          contentHash: String(contentHash),
          copyIndex: Number(copyIndex),
          targetSourceId: String(targetSourceId),
          editStackHash: String(editStackHash),
          format: String(format) as ExportRow['format'],
        }),
        Number(rowid),
      ]);
    }
  } finally {
    update.free();
  }
  db.exec('DROP INDEX IF EXISTS idx_exports_identity');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_exports_syncId ON exports(syncId)');
}

function tableColumns(db: Database, table: string): Set<string> {
  const result = db.exec(`PRAGMA table_info(${table})`);
  if (result.length === 0) return new Set();
  return new Set(result[0].values.map((row) => String(row[1])));
}
