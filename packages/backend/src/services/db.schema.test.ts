import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BACKEND_OVERLAY,
  CATALOG_SCHEMA_SQL,
  SYNC_TABLES,
  type BackendOverlayColumn,
  type SyncTableName,
} from '@photolib/shared';
import { closeDb, getDb, initDb } from './db.js';

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface SchemaObject {
  type: string;
  name: string;
  table: string;
  sql: string;
  columns: Array<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    defaultValue: string | null;
    primaryKey: number;
  }>;
}

/** The per-user identity routes/sync.ts upserts against. */
const EXPECTED_KEYS: Record<SyncTableName, string[]> = {
  sources: ['userId', 'id'],
  photos: ['userId', 'sourceId', 'sourcePhotoId'],
  photoMeta: ['userId', 'contentHash'],
  edits: ['userId', 'contentHash', 'copyIndex'],
  presets: ['userId', 'syncId'],
  developProfiles: ['userId', 'syncId'],
  lensProfiles: ['userId', 'syncId'],
  collections: ['userId', 'syncId'],
  exports: ['userId', 'syncId'],
};

const OVERLAY_DEFINITIONS: Record<BackendOverlayColumn, Pick<Column, 'type' | 'notnull' | 'dflt_value'>> = {
  userId: { type: 'TEXT', notnull: 1, dflt_value: "'_anon'" },
  revision: { type: 'INTEGER', notnull: 1, dflt_value: '0' },
};

/** Hub-only columns added by migration 005-sync-identities. */
const MIGRATION_COLUMNS: Partial<Record<SyncTableName, string[]>> = {
  collections: ['parentSyncId', 'photoRefs'],
};

let shared: Database;
let temporaryRoot: string | null = null;

beforeAll(async () => {
  const SQL = await initSqlJs();
  shared = new SQL.Database();
  shared.exec(CATALOG_SCHEMA_SQL);
});

afterEach(async () => {
  closeDb();
  if (temporaryRoot) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = null;
  }
});

describe('backend schema', () => {
  it('matches the checked-in schema Golden', async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-db-schema-'));
    await initDb(path.join(temporaryRoot, 'golden.db'));
    const golden = JSON.parse(await fs.readFile(
      new URL('../db/fixtures/backend-schema-golden.json', import.meta.url),
      'utf8',
    )) as SchemaObject[];

    expect(schemaSnapshot(getDb())).toEqual(golden);
  });

  it('derives every sync table of a fresh database from the shared schema', async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-db-schema-'));
    await initDb(path.join(temporaryRoot, 'fresh.db'));

    expectBackendMatchesShared(getDb());
  });

  it('rebuilds a catalog from before the per-user overlay into the same schema', async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-db-schema-'));
    const filePath = path.join(temporaryRoot, 'legacy.db');
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.exec(CATALOG_SCHEMA_SQL);
    // A v2 catalog: presets without syncId, two of them saved in the same millisecond.
    legacy.exec('DROP TABLE presets');
    legacy.exec(`CREATE TABLE presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      adjustments TEXT NOT NULL,
      category TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      deletedAt INTEGER
    )`);
    legacy.exec(`
      INSERT INTO sources (id, type, label, config, addedAt, updatedAt) VALUES ('s1', 'local', 'Local', '{}', 1, 2);
      INSERT INTO photos (sourceId, sourcePhotoId, name, indexedAt, updatedAt) VALUES ('s1', 'p1', 'a.jpg', 1, 2);
      INSERT INTO photoMeta (contentHash, rating, updatedAt) VALUES ('h1', 3, 2);
      INSERT INTO edits (contentHash, copyIndex, adjustments, createdAt, updatedAt) VALUES ('h1', 0, '{}', 1, 2);
      INSERT INTO presets (name, adjustments, createdAt, updatedAt) VALUES ('A', '{}', 7, 7);
      INSERT INTO presets (name, adjustments, createdAt, updatedAt) VALUES ('B', '{}', 7, 7);
      INSERT INTO developProfiles (syncId, name, scope, key, adjustments, createdAt, updatedAt)
        VALUES ('d1', 'X-T5', 'camera', 'fujifilm x-t5', '{}', 1, 2);
      INSERT INTO lensProfiles (syncId, name, key, coefficients, createdAt, updatedAt)
        VALUES ('l1', 'XF 23', 'xf23', '{}', 1, 2);
      INSERT INTO collections (syncId, name, type, createdAt, updatedAt)
        VALUES ('c1', 'Picks', 'manual', 1, 2);
      INSERT INTO collections (syncId, name, type, parentId, photoIds, createdAt, updatedAt)
        VALUES ('c2', 'Child', 'manual', 1, '[1]', 3, 4);
      INSERT INTO exports (syncId, contentHash, copyIndex, targetSourceId, targetAssetId,
                           format, editStackHash, filename, bytes, status, uploadedAt, updatedAt)
        VALUES ('h1/0/s1/e1/jpg', 'h1', 0, 's1', 'a1', 'jpg', 'e1', 'a_edit_e1.jpg', 7, 'ok', 1, 2);
    `);
    await fs.writeFile(filePath, legacy.export());
    legacy.close();

    await initDb(filePath);

    expectBackendMatchesShared(getDb());
    for (const table of SYNC_TABLES) {
      const owners = getDb().exec(`SELECT DISTINCT userId FROM ${table}`)[0]?.values ?? [];
      expect(owners, table).toEqual([['_anon']]);
    }
    const presetIds = getDb().exec('SELECT syncId FROM presets ORDER BY id')[0].values.map((row) => row[0]);
    expect(presetIds).toHaveLength(2);
    expect(new Set(presetIds).size).toBe(2);
    expect(presetIds.every((id) => String(id).startsWith('legacy-preset-7'))).toBe(true);
    expect(getDb().exec(
      'SELECT id, type, label, config, addedAt, updatedAt FROM sources',
    )[0].values).toEqual([['s1', 'local', 'Local', '{}', 1, 2]]);
    expect(getDb().exec(
      'SELECT id, sourceId, sourcePhotoId, name, indexedAt, updatedAt FROM photos',
    )[0].values).toEqual([[1, 's1', 'p1', 'a.jpg', 1, 2]]);
    expect(getDb().exec(
      'SELECT name, adjustments, createdAt, updatedAt FROM presets ORDER BY id',
    )[0].values).toEqual([
      ['A', '{}', 7, 7],
      ['B', '{}', 7, 7],
    ]);
    expect(getDb().exec(`
      SELECT syncId, name, type, parentId, photoIds, parentSyncId, photoRefs
      FROM collections ORDER BY id
    `)[0].values).toEqual([
      ['c1', 'Picks', 'manual', null, null, null, '[]'],
      ['c2', 'Child', 'manual', 1, '[1]', 'c1', '[{"sourceId":"s1","sourcePhotoId":"p1"}]'],
    ]);
    expect(getDb().exec(
      'SELECT syncId, targetAssetId, filename, bytes FROM exports',
    )[0].values).toEqual([['h1/0/s1/e1/jpg', 'a1', 'a_edit_e1.jpg', 7]]);
    expectEveryRowNumbered(getDb(), 11);
  });

  it('adds revisions to a hub database from before migration 7', async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-db-schema-'));
    const filePath = path.join(temporaryRoot, 'hub.db');
    await initDb(filePath);
    const hub = getDb();
    hub.exec(`
      INSERT INTO edits (userId, contentHash, copyIndex, adjustments, createdAt, updatedAt) VALUES ('u', 'h1', 0, '{}', 1, 30);
      INSERT INTO presets (userId, syncId, name, adjustments, createdAt, updatedAt) VALUES ('u', 'p1', 'P', '{}', 1, 20);
      INSERT INTO developProfiles (userId, syncId, name, scope, key, adjustments, createdAt, updatedAt)
        VALUES ('u', 'd1', 'X-T5', 'camera', 'x-t5', '{}', 1, 10);
    `);
    for (const table of SYNC_TABLES) {
      hub.exec(`DROP INDEX idx_backend_${table}_revision`);
      hub.exec(`ALTER TABLE ${table} DROP COLUMN revision`);
    }
    hub.exec('DROP TABLE sync_counter');
    hub.exec('DELETE FROM server_schema_migrations WHERE version = 7');
    closeDb();

    await initDb(filePath);

    expectBackendMatchesShared(getDb());
    const revisions = ['developProfiles', 'presets', 'edits']
      .map((table) => getDb().exec(`SELECT revision FROM ${table}`)[0].values[0][0]);
    expect(revisions).toEqual([1, 2, 3]);
    expectEveryRowNumbered(getDb(), 3);
  });
});

function expectEveryRowNumbered(backend: Database, rowCount: number): void {
  for (const table of SYNC_TABLES) {
    const unnumbered = backend.exec(`SELECT COUNT(*) FROM ${table} WHERE revision <= 0`)[0].values[0][0];
    expect(unnumbered, `${table} rows without a revision`).toBe(0);
  }
  expect(backend.exec('SELECT value FROM sync_counter')[0].values).toEqual([[rowCount]]);
}

function expectBackendMatchesShared(backend: Database): void {
  for (const table of SYNC_TABLES) {
    const sharedColumns = columns(shared, table);
    const backendColumns = new Map(columns(backend, table).map((column) => [column.name, column]));
    const expectedNames = [
      ...BACKEND_OVERLAY,
      ...sharedColumns.map((column) => column.name),
      ...(MIGRATION_COLUMNS[table] ?? []),
    ];
    expect([...backendColumns.keys()].sort(), `${table} columns`).toEqual([...expectedNames].sort());

    for (const column of sharedColumns) {
      const actual = backendColumns.get(column.name);
      expect(
        { type: actual?.type, notnull: actual?.notnull, dflt_value: actual?.dflt_value },
        `${table}.${column.name}`,
      ).toEqual({
        type: column.type,
        // SQLite accepts NULL in a non-INTEGER key column unless it says NOT NULL.
        notnull: column.notnull || EXPECTED_KEYS[table].includes(column.name) ? 1 : 0,
        dflt_value: column.dflt_value,
      });
    }

    for (const column of BACKEND_OVERLAY) {
      const actual = backendColumns.get(column);
      expect(
        { type: actual?.type, notnull: actual?.notnull, dflt_value: actual?.dflt_value },
        `${table}.${column}`,
      ).toEqual(OVERLAY_DEFINITIONS[column]);
    }

    const keys = uniqueKeys(backend, table);
    expect(keys, `${table} key`).toContainEqual(EXPECTED_KEYS[table]);
    for (const key of keys) expect(key, `${table} unique key ${key.join(',')}`).toContain('userId');

    if (/\bAUTOINCREMENT\b/i.test(tableSql(shared, table))) {
      expect(tableSql(backend, table), `${table} keeps its row id`).toMatch(/\bid INTEGER PRIMARY KEY AUTOINCREMENT\b/i);
    }

    const backendIndexes = new Set(indexNames(backend, table));
    for (const index of [...indexNames(shared, table), `idx_backend_${table}_revision`]) {
      expect(backendIndexes.has(index), `${table} index ${index}`).toBe(true);
    }
  }
}

function columns(db: Database, table: string): Column[] {
  const result = db.exec(`PRAGMA table_info(${table})`)[0];
  return result.values.map((row) => Object.fromEntries(
    result.columns.map((name, index) => [name, row[index]]),
  ) as unknown as Column);
}

function uniqueKeys(db: Database, table: string): string[][] {
  const indexes = db.exec(`PRAGMA index_list(${table})`)[0];
  if (!indexes) return [];
  const nameAt = indexes.columns.indexOf('name');
  const uniqueAt = indexes.columns.indexOf('unique');
  return indexes.values
    .filter((row) => row[uniqueAt] === 1)
    .map((row) => db.exec(`PRAGMA index_info(${String(row[nameAt])})`)[0].values
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map((info) => String(info[2])));
}

function indexNames(db: Database, table: string): string[] {
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
    [table],
  )[0];
  return result ? result.values.map((row) => String(row[0])) : [];
}

function tableSql(db: Database, table: string): string {
  return String(db.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table])[0].values[0][0]);
}

function schemaSnapshot(db: Database): SchemaObject[] {
  const objects = db.exec(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_master
    WHERE type IN ('table', 'index')
      AND sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `)[0];

  return objects.values.map((row) => {
    const [type, name, table, sql] = row.map(String);
    const snapshotColumns = type === 'table'
      ? columns(db, name).map((column, cid) => ({
          cid,
          name: column.name,
          type: column.type,
          notnull: column.notnull,
          defaultValue: column.dflt_value,
          primaryKey: column.pk,
        }))
      : [];
    return { type, name, table, sql, columns: snapshotColumns };
  });
}
