import type { Database } from 'sql.js';
import {
  BACKEND_OVERLAY,
  CATALOG_SCHEMA_SQL,
  SYNC_TABLES,
  type BackendOverlayColumn,
  type SyncTableName,
} from '@photolib/shared';
import { rows, tableExists, tableHasColumn } from './migrations/helpers.js';

const OVERLAY_COLUMNS: Record<BackendOverlayColumn, string> = {
  userId: "userId TEXT NOT NULL DEFAULT '_anon'",
  revision: 'revision INTEGER NOT NULL DEFAULT 0',
};

export const BACKEND_PRIMARY_KEYS: Record<SyncTableName, string> = {
  sources: 'PRIMARY KEY (userId, id)',
  photos: 'UNIQUE(userId, sourceId, sourcePhotoId)',
  photoMeta: 'PRIMARY KEY (userId, contentHash)',
  edits: 'PRIMARY KEY (userId, contentHash, copyIndex)',
  presets: 'UNIQUE(userId, syncId)',
  developProfiles: 'UNIQUE(userId, syncId)',
  lensProfiles: 'UNIQUE(userId, syncId)',
  collections: 'UNIQUE(userId, syncId)',
  exports: 'UNIQUE(userId, syncId)',
};

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface DatabaseConstructor {
  new(): Database;
}

/**
 * Creates or rebuilds every sync table from the canonical shared schema.
 *
 * Overlay boundary: production opens a new SQL.js connection with the
 * existing `foreign_keys=OFF` invariant before this migration runs. The old
 * overlay also intentionally did not carry the shared schema's single-user
 * REFERENCES through `PRAGMA table_info`: correct backend references would
 * have to include userId and are a separate schema change, not migration 010.
 */
export function applyUserIdOverlay(db: Database): boolean {
  ensureLegacySyncIds(db);
  const backendColumns = deriveBackendColumns(db);
  let rebuiltLegacyTable = false;
  for (const table of SYNC_TABLES) {
    if (!tableExists(db, table)) {
      db.run(`CREATE TABLE ${table} (${backendColumns[table].join(', ')})`);
    } else if (!tableHasColumn(db, table, 'userId')) {
      uniquifyLegacySyncIds(db, table);
      rebuildTable(db, table, backendColumns[table]);
      rebuiltLegacyTable = true;
    }
  }
  return rebuiltLegacyTable;
}

function deriveBackendColumns(db: Database): Record<SyncTableName, string[]> {
  const SharedDatabase = db.constructor as unknown as DatabaseConstructor;
  const shared = new SharedDatabase();
  try {
    shared.exec(CATALOG_SCHEMA_SQL);
    const result = {} as Record<SyncTableName, string[]>;
    for (const table of SYNC_TABLES) {
      const createSql = String(shared.exec(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        [table],
      )[0].values[0][0]);
      const autoIncrement = /\bAUTOINCREMENT\b/i.test(createSql);
      const columns = tableInfo(shared, table).map((column) => {
        if (column.pk > 0 && autoIncrement) {
          return `${column.name} ${column.type} PRIMARY KEY AUTOINCREMENT`;
        }
        const parts = [column.name, column.type];
        // BACKEND_PRIMARY_KEYS replaces the shared key, and SQLite accepts
        // NULL in a non-INTEGER key column unless it is declared NOT NULL.
        if (column.notnull || column.pk > 0) parts.push('NOT NULL');
        if (column.dflt_value !== null) parts.push(`DEFAULT ${column.dflt_value}`);
        return parts.join(' ');
      });
      result[table] = [
        ...BACKEND_OVERLAY.map((column) => OVERLAY_COLUMNS[column]),
        ...columns,
        BACKEND_PRIMARY_KEYS[table],
      ];
    }
    return result;
  } finally {
    shared.close();
  }
}

function ensureLegacySyncIds(db: Database): void {
  for (const [table, prefix] of [['presets', 'legacy-preset-'], ['collections', 'legacy-collection-']] as const) {
    if (!tableExists(db, table)) continue;
    if (!tableHasColumn(db, table, 'syncId')) db.run(`ALTER TABLE ${table} ADD COLUMN syncId TEXT`);
    const legacySuffix = tableHasColumn(db, table, 'createdAt') ? 'createdAt' : 'rowid';
    db.run(
      `UPDATE ${table} SET syncId = ? || ${legacySuffix} WHERE syncId IS NULL OR syncId = ''`,
      [prefix],
    );
  }
}

function uniquifyLegacySyncIds(db: Database, table: string): void {
  // A single-user catalog can hold two rows whose synthesised legacy syncId is
  // the same (same createdAt); UNIQUE(userId, syncId) would reject the copy.
  if (!tableHasColumn(db, table, 'syncId')) return;
  const legacyRows = rows(
    db,
    `SELECT rowid AS legacyRowId, syncId FROM ${table} ORDER BY rowid`,
  );
  const reserved = new Set(
    legacyRows
      .map((row) => row.syncId)
      .filter((syncId): syncId is string | number => syncId != null && syncId !== '')
      .map(String),
  );
  const seen = new Set<string>();

  for (const row of legacyRows) {
    if (row.syncId == null || row.syncId === '') continue;
    const syncId = String(row.syncId);
    if (!seen.has(syncId)) {
      seen.add(syncId);
      continue;
    }

    const rowId = Number(row.legacyRowId);
    const base = `${syncId}-${rowId}`;
    let candidate = base;
    let discriminator = 2;
    while (reserved.has(candidate)) candidate = `${base}-${discriminator++}`;
    db.run(`UPDATE ${table} SET syncId = ? WHERE rowid = ?`, [candidate, rowId]);
    reserved.add(candidate);
  }
}

function tableInfo(db: Database, table: string): ColumnInfo[] {
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  const columns: ColumnInfo[] = [];
  while (stmt.step()) columns.push(stmt.getAsObject() as unknown as ColumnInfo);
  stmt.free();
  return columns;
}

function rebuildTable(db: Database, table: string, columns: string[]): void {
  const oldColumns = tableInfo(db, table).map((column) => column.name);
  const columnDefinitions = columns.filter((column) =>
    !/^(PRIMARY|UNIQUE|FOREIGN|CHECK)$/i.test(column.split(/\s+/)[0]),
  );
  const columnNames = columnDefinitions.map((column) => column.split(/\s+/)[0]);
  const shared = columnNames.filter((column) => oldColumns.includes(column));

  // Supply only canonical defaults for required columns absent in old rows.
  const now = Date.now();
  const insertColumns = [...shared];
  const selectExpressions: string[] = shared.map((column) => column);
  for (const definition of columnDefinitions) {
    const name = definition.split(/\s+/)[0];
    if (shared.includes(name)) continue;
    if (!/\bNOT NULL\b/i.test(definition) || /\bDEFAULT\b/i.test(definition)) continue;
    insertColumns.push(name);
    selectExpressions.push(/At$/.test(name) ? String(now) : "''");
  }

  db.run(`CREATE TABLE ${table}_new (${columns.join(', ')})`);
  if (oldColumns.length > 0 && insertColumns.length > 0) {
    db.run(
      `INSERT INTO ${table}_new (${insertColumns.join(', ')}) ` +
      `SELECT ${selectExpressions.join(', ')} FROM ${table}`,
    );
  }
  db.run(`DROP TABLE ${table}`);
  db.run(`ALTER TABLE ${table}_new RENAME TO ${table}`);
}
