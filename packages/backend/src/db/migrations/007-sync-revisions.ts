import type { Database } from 'sql.js';
import { SYNC_TABLES } from '@photolib/shared';
import type { BackendMigration } from '../migrations.js';
import { ensureColumn, firstRow, rows, tableExists, tableHasColumn } from './helpers.js';

/** Tables the hub identifies by (userId, syncId); see BACKEND_PRIMARY_KEYS. */
const SYNC_ID_TABLES = ['presets', 'developProfiles', 'lensProfiles', 'collections'] as const;

/**
 * Pull runs over a hub-assigned revision instead of the client's updatedAt:
 * one counter for all sync tables, bumped for every merged row. Existing rows
 * are numbered in updatedAt order, which is the order the old since-cursor
 * handed them out.
 */
export const syncRevisionsMigration: BackendMigration = {
  version: 7,
  name: 'sync-revisions',
  up(db) {
    ensureSyncRevisionSchema(db, 'all');
  },
};

export function ensureSyncRevisionSchema(
  db: Database,
  backfill: 'all' | 'unnumbered' = 'all',
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL
    )`);
  db.exec('INSERT OR IGNORE INTO sync_counter (id, value) VALUES (1, 0)');

  const tables = SYNC_TABLES.filter((table) =>
    tableExists(db, table) && tableHasColumn(db, table, 'userId'),
  );
  for (const table of tables) {
    ensureColumn(db, table, 'revision', 'INTEGER NOT NULL DEFAULT 0');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_backend_${table}_revision ON ${table}(userId, revision)`);
  }
  backfillRevisions(db, tables, backfill);

  for (const table of SYNC_ID_TABLES) {
    if (tableExists(db, table) && tableHasColumn(db, table, 'userId')) ensureUniqueSyncId(db, table);
  }
}

function backfillRevisions(
  db: Database,
  tables: readonly string[],
  backfill: 'all' | 'unnumbered',
): void {
  const pending: Array<{ table: number; rowid: number; updatedAt: number }> = [];
  tables.forEach((table, index) => {
    const where = backfill === 'unnumbered' ? ' WHERE revision <= 0' : '';
    for (const row of rows(db, `SELECT rowid AS lwwRowId, updatedAt FROM ${table}${where}`)) {
      pending.push({ table: index, rowid: Number(row.lwwRowId), updatedAt: Number(row.updatedAt) });
    }
  });
  pending.sort((a, b) => a.updatedAt - b.updatedAt || a.table - b.table || a.rowid - b.rowid);

  // Continues after the stored counter, so a rerun after a rollback to an
  // image without revisions (version 7 deleted from server_schema_migrations)
  // numbers every row above anything a client has already pulled.
  let revision = Number(firstRow(db, 'SELECT value FROM sync_counter WHERE id = 1')?.value ?? 0);
  const updates = tables.map((table) => db.prepare(`UPDATE ${table} SET revision = ? WHERE rowid = ?`));
  try {
    for (const row of pending) {
      revision += 1;
      updates[row.table].run([revision, row.rowid]);
    }
  } finally {
    for (const update of updates) update.free();
  }
  db.run('UPDATE sync_counter SET value = ? WHERE id = 1', [revision]);
}

/**
 * Hubs from before the derived schema keep these tables without a unique
 * (userId, syncId). The index is only added when no pair is duplicated, so
 * this step can never fail the migration; a duplicated pair stays as it is
 * and is reported, because picking the row to drop is not the hub's call.
 */
function ensureUniqueSyncId(db: Database, table: string): void {
  if (hasUniqueKey(db, table, ['userId', 'syncId'])) return;
  const duplicate = firstRow(
    db,
    `SELECT userId, syncId FROM ${table} WHERE syncId IS NOT NULL
     GROUP BY userId, syncId HAVING COUNT(*) > 1 LIMIT 1`,
  );
  if (duplicate) {
    console.warn(`[migration 7] ${table} has duplicate (userId, syncId) rows; no unique index added`);
    return;
  }
  db.exec(`CREATE UNIQUE INDEX idx_backend_${table}_identity ON ${table}(userId, syncId)`);
}

function hasUniqueKey(db: Database, table: string, key: readonly string[]): boolean {
  return rows(db, `PRAGMA index_list(${table})`)
    .filter((index) => Number(index.unique) === 1)
    .some((index) => {
      const columns = rows(db, `PRAGMA index_info(${String(index.name)})`)
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((info) => String(info.name));
      return columns.length === key.length && columns.every((column, at) => column === key[at]);
    });
}
