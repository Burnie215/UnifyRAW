import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_SCHEMA_SQL, SYNC_TABLES } from '@photolib/shared';
import { runBackendMigrations, type BackendMigration } from './migrations.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backend migrations', () => {
  it('creates the integrated-library registry and is idempotent', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    runBackendMigrations(db);
    runBackendMigrations(db);

    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )[0].values.map((row) => row[0]);
    expect(tables).toContain('server_libraries');
    expect(tables).toContain('server_library_roots');
    expect(tables).toContain('server_library_scans');
    expect(tables).toContain('server_library_assets');
    expect(tables).toContain('server_library_imports');
    expect(tables).toContain('users');

    const applied = db.exec('SELECT version, name FROM server_schema_migrations')[0];
    expect(applied.values).toEqual([
      [1, 'integrated-library-registry'],
      [2, 'integrated-library-assets'],
      [3, 'managed-library-imports'],
      [4, 'auth-users-and-roles'],
      [5, 'stable-sync-identities'],
      [6, 'redact-source-credentials'],
      [7, 'sync-revisions'],
      [8, 'user-token-version'],
      [9, 'reclaim-edit-document-history'],
      [10, 'catalog-schema-user-id-overlay'],
      [11, 'photo-source-bits'],
      [12, 'export-ledger-sync'],
    ]);
    db.close();
  });

  it('creates every overlaid sync table through the migration runner on a fresh database', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();

    runBackendMigrations(db);

    for (const table of SYNC_TABLES) {
      const names = db.exec(`PRAGMA table_info(${table})`)[0].values.map((column) => column[1]);
      expect(names, table).toContain('userId');
      expect(names, table).toContain('revision');
    }
    expect(db.exec('SELECT name FROM server_schema_migrations WHERE version = 10')[0].values)
      .toEqual([['catalog-schema-user-id-overlay']]);
    db.close();
  });

  it('overlays a raw legacy catalog without losing rows and can rerun migration 10', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(CATALOG_SCHEMA_SQL);
    db.exec(`
      INSERT INTO sources (id, type, label, config, addedAt, updatedAt)
      VALUES ('legacy-source', 'webdav', 'Legacy', '{"url":"https://dav.test","password":"secret"}', 1, 2)
    `);

    runBackendMigrations(db);

    expect(primaryKeyColumns(db, 'sources')).toEqual(['userId', 'id']);
    expect(db.exec('SELECT userId, id FROM sources')[0].values).toEqual([['_anon', 'legacy-source']]);
    expect(String(db.exec('SELECT config FROM sources')[0].values[0][0])).not.toContain('secret');
    const revision = db.exec('SELECT revision FROM sources')[0].values[0][0];
    const schema = schemaSql(db);

    db.exec('DELETE FROM server_schema_migrations WHERE version = 10');
    runBackendMigrations(db);

    expect(schemaSql(db)).toEqual(schema);
    expect(db.exec('SELECT userId, id, revision FROM sources')[0].values)
      .toEqual([['_anon', 'legacy-source', revision]]);
    expect(db.exec('SELECT COUNT(*) FROM server_schema_migrations WHERE version = 10')[0].values)
      .toEqual([[1]]);
    db.close();
  });

  it('adds a column the shared schema grew to a hub that is already overlaid', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(CATALOG_SCHEMA_SQL);
    runBackendMigrations(db);
    db.exec(`
      INSERT INTO photos (userId, sourceId, sourcePhotoId, name, indexedAt, updatedAt)
      VALUES ('_anon', 's1', 'p1', 'a.heic', 1, 2)
    `);

    // What a running hub looks like: already at 10, so neither the overlay
    // rebuild nor CREATE TABLE IF NOT EXISTS would ever reach it again.
    db.exec('ALTER TABLE photos DROP COLUMN sourceBits');
    db.exec('DELETE FROM server_schema_migrations WHERE version = 11');

    runBackendMigrations(db);

    const columns = db.exec('PRAGMA table_info(photos)')[0].values.map((column) => column[1]);
    expect(columns).toContain('sourceBits');
    expect(db.exec('SELECT sourcePhotoId, sourceBits FROM photos')[0].values).toEqual([['p1', null]]);
    db.close();
  });

  it('overlays an export ledger a hub still carries in its local-only shape', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(CATALOG_SCHEMA_SQL);
    runBackendMigrations(db);

    // What a running hub looks like: already past 10, so its `exports` is the
    // one the shared schema created back when the ledger was local-only -
    // no userId, no revision, no syncId, and out of reach of both the overlay
    // rebuild and CREATE TABLE IF NOT EXISTS.
    db.exec('DROP TABLE exports');
    db.exec(`CREATE TABLE exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contentHash TEXT NOT NULL, copyIndex INTEGER NOT NULL DEFAULT 0,
      targetSourceId TEXT NOT NULL, targetAssetId TEXT NOT NULL, targetUrl TEXT,
      format TEXT NOT NULL, editStackHash TEXT NOT NULL, filename TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ok',
      uploadedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER)`);
    db.exec(`INSERT INTO exports
      (contentHash, copyIndex, targetSourceId, targetAssetId, format, editStackHash, filename, uploadedAt, updatedAt)
      VALUES ('h1', 0, 's1', 'a1', 'jpg', 'e1', 'p.jpg', 5, 5)`);
    db.exec('DELETE FROM server_schema_migrations WHERE version = 12');

    runBackendMigrations(db);

    const columns = db.exec('PRAGMA table_info(exports)')[0].values.map((column) => column[1]);
    expect(columns).toEqual(expect.arrayContaining(['userId', 'revision', 'syncId']));
    expect(db.exec('SELECT userId, syncId, targetAssetId, revision FROM exports')[0].values)
      .toEqual([['_anon', 'h1/0/s1/e1/jpg', 'a1', 1]]);
    expect(db.exec('SELECT value FROM sync_counter')[0].values).toEqual([[1]]);
    expect(indexNames(db, 'exports')).toContain('idx_backend_exports_revision');
    // One ledger per account, not one for the whole hub.
    expect(() => db.exec(`INSERT INTO exports
      (userId, syncId, contentHash, targetSourceId, targetAssetId, format, editStackHash, filename, uploadedAt, updatedAt)
      VALUES ('_anon', 'h1/0/s1/e1/jpg', 'h1', 's1', 'a2', 'jpg', 'e1', 'p.jpg', 6, 6)`)).toThrow(/UNIQUE/);
    db.exec(`INSERT INTO exports
      (userId, syncId, contentHash, targetSourceId, targetAssetId, format, editStackHash, filename, uploadedAt, updatedAt)
      VALUES ('other', 'h1/0/s1/e1/jpg', 'h1', 's1', 'a2', 'jpg', 'e1', 'p.jpg', 6, 6)`);
    expect(db.exec('SELECT COUNT(*) FROM exports')[0].values).toEqual([[2]]);
    db.close();
  });

  it('deduplicates legacy sync ids without colliding with an existing suffix', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(CATALOG_SCHEMA_SQL);
    db.exec(`
      INSERT INTO presets (syncId, name, adjustments, createdAt, updatedAt) VALUES
        ('x', 'First', '{"exposure":1}', 1, 1),
        ('x', 'Second', '{"exposure":2}', 2, 2),
        ('x-2', 'Existing suffix', '{"exposure":3}', 3, 3)
    `);

    runBackendMigrations(db);

    const presets = db.exec('SELECT name, syncId, adjustments FROM presets ORDER BY id')[0].values;
    expect(presets.map((row) => row[0])).toEqual(['First', 'Second', 'Existing suffix']);
    expect(presets.map((row) => row[2])).toEqual([
      '{"exposure":1}', '{"exposure":2}', '{"exposure":3}',
    ]);
    const syncIds = presets.map((row) => String(row[1]));
    expect(syncIds[0]).toBe('x');
    expect(syncIds[2]).toBe('x-2');
    expect(new Set(syncIds).size).toBe(3);
    expect(syncIds[1]).toBe('x-2-2');
    db.close();
  });

  it('gives every existing user token version 0, and adds the column only once', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        passwordHash TEXT NOT NULL,
        salt TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        createdAt INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('u1', 'first', 'hash', '', 'admin', 1);
    `);

    runBackendMigrations(db);
    db.exec('DELETE FROM server_schema_migrations WHERE version = 8');
    runBackendMigrations(db);

    const columns = db.exec('PRAGMA table_info(users)')[0];
    const at = (name: string) => columns.columns.indexOf(name);
    const tokenVersion = columns.values.filter((column) => column[at('name')] === 'tokenVersion');
    expect(tokenVersion).toHaveLength(1);
    expect(tokenVersion[0][at('notnull')]).toBe(1);
    expect(db.exec('SELECT id, tokenVersion FROM users')[0].values).toEqual([['u1', 0]]);
    db.exec("INSERT INTO users (id, username, passwordHash, salt, createdAt) VALUES ('u2', 'second', 'h', '', 2)");
    expect(db.exec("SELECT tokenVersion FROM users WHERE id = 'u2'")[0].values).toEqual([[0]]);
    db.close();
  });

  it('adds roles to legacy users and promotes only the oldest account', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        passwordHash TEXT NOT NULL,
        salt TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('later', 'later', 'hash', '', 2);
      INSERT INTO users VALUES ('first', 'first', 'hash', '', 1);
    `);

    runBackendMigrations(db);

    const rows = db.exec('SELECT id, role FROM users ORDER BY createdAt')[0].values;
    expect(rows).toEqual([
      ['first', 'admin'],
      ['later', 'user'],
    ]);
    db.close();
  });

  it('rolls back a failed migration without recording it', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const failing: BackendMigration = {
      version: 99,
      name: 'failing-test-migration',
      up(database) {
        database.exec('CREATE TABLE should_be_rolled_back (id INTEGER)');
        throw new Error('expected failure');
      },
    };

    expect(() => runBackendMigrations(db, [failing])).toThrow(
      'Backend migration 99 (failing-test-migration) failed',
    );

    const table = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='should_be_rolled_back'",
    );
    expect(table).toHaveLength(0);
    const applied = db.exec('SELECT version FROM server_schema_migrations');
    expect(applied).toHaveLength(0);
    db.close();
  });

  it('numbers existing sync rows in updatedAt order across all tables', async () => {
    const db = await hubWithRows();

    runBackendMigrations(db);

    const numbered = revisionsInOrder(db);
    expect(numbered.map(([key]) => key)).toEqual(['p5', 'e10', 'p20', 'e25', 'p30', 'e40']);
    expect(numbered.map(([, revision]) => revision)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(db.exec('SELECT value FROM sync_counter')[0].values).toEqual([[6]]);
    db.close();
  });

  it('numbers every row above the counter when migration 7 runs again after a rollback', async () => {
    const db = await hubWithRows();
    runBackendMigrations(db);
    // The old image inserts without a revision and keeps it on update.
    db.exec("INSERT INTO edits (userId, contentHash, updatedAt) VALUES ('a', 'e50', 50)");
    db.exec("UPDATE presets SET updatedAt = 60 WHERE syncId = 'p5'");
    db.exec('DELETE FROM server_schema_migrations WHERE version = 7');

    runBackendMigrations(db);

    const numbered = revisionsInOrder(db);
    expect(numbered.map(([key]) => key)).toEqual(['e10', 'p20', 'e25', 'p30', 'e40', 'e50', 'p5']);
    expect(numbered.map(([, revision]) => revision)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(db.exec('SELECT value FROM sync_counter')[0].values).toEqual([[13]]);
    db.close();
  });

  it('adds a unique (userId, syncId) key to hub tables without one, unless a pair is duplicated', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    // The shape the old applySchema left behind: shared schema plus an appended userId.
    for (const table of ['developProfiles', 'lensProfiles']) {
      db.exec(`CREATE TABLE ${table} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        syncId TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        userId TEXT NOT NULL DEFAULT '_anon'
      )`);
    }
    db.exec(`
      INSERT INTO developProfiles (syncId, updatedAt, userId) VALUES ('d1', 1, 'a'), ('d1', 2, 'b');
      INSERT INTO lensProfiles (syncId, updatedAt, userId) VALUES ('l1', 1, 'a'), ('l1', 2, 'a');
    `);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    runBackendMigrations(db);

    expect(uniqueIndexes(db, 'developProfiles')).toEqual(['idx_backend_developProfiles_identity']);
    expect(() => db.exec("INSERT INTO developProfiles (syncId, updatedAt, userId) VALUES ('d1', 3, 'a')"))
      .toThrow(/UNIQUE/);
    expect(uniqueIndexes(db, 'lensProfiles')).toEqual([]);
    expect(db.exec('SELECT COUNT(*) FROM lensProfiles')[0].values).toEqual([[2]]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lensProfiles'));
    expect(db.exec('SELECT version FROM server_schema_migrations WHERE version = 7')[0].values).toEqual([[7]]);
    db.close();
  });

  it('reclaims obsolete hub document history without changing current edit data', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec(`
      CREATE TABLE edits (
        userId TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        copyIndex INTEGER NOT NULL,
        adjustments TEXT NOT NULL,
        document TEXT,
        history TEXT,
        documentHistory TEXT,
        updatedAt INTEGER NOT NULL
      );
      INSERT INTO edits VALUES
        ('u', 'old', 0, '{"exposure":1}', '{"version":1}', '[{"exposure":0}]', '[{"version":1}]', 10),
        ('u', 'empty', 0, '{}', NULL, '[]', NULL, 20);
    `);

    runBackendMigrations(db);

    expect(db.exec(`
      SELECT contentHash, adjustments, document, history, documentHistory, updatedAt
      FROM edits ORDER BY contentHash
    `)[0].values).toEqual([
      ['empty', '{}', null, '[]', null, 20],
      ['old', '{"exposure":1}', '{"version":1}', '[{"exposure":0}]', null, 10],
    ]);

    db.exec('DELETE FROM server_schema_migrations WHERE version = 9');
    runBackendMigrations(db);
    expect(db.exec('SELECT documentHistory FROM edits ORDER BY contentHash')[0].values)
      .toEqual([[null], [null]]);
    expect(db.exec('SELECT COUNT(*) FROM server_schema_migrations WHERE version = 9')[0].values)
      .toEqual([[1]]);
    db.close();
  });
});

/** Two sync tables whose rowid order is not their updatedAt order. */
async function hubWithRows(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.exec(`
    CREATE TABLE edits (userId TEXT NOT NULL, contentHash TEXT NOT NULL, updatedAt INTEGER NOT NULL);
    CREATE TABLE presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      syncId TEXT NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    INSERT INTO edits VALUES ('a', 'e40', 40), ('b', 'e10', 10), ('a', 'e25', 25);
    INSERT INTO presets (userId, syncId, updatedAt) VALUES ('a', 'p30', 30), ('b', 'p5', 5), ('a', 'p20', 20);
  `);
  return db;
}

function revisionsInOrder(db: Database): Array<[string, number]> {
  return [
    ...db.exec('SELECT contentHash, revision FROM edits')[0].values,
    ...db.exec('SELECT syncId, revision FROM presets')[0].values,
  ]
    .map(([key, revision]): [string, number] => [String(key), Number(revision)])
    .sort((a, b) => a[1] - b[1]);
}

function indexNames(db: Database, table: string): string[] {
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
    [table],
  )[0];
  return result ? result.values.map((row) => String(row[0])) : [];
}

function uniqueIndexes(db: Database, table: string): string[] {
  const indexes = db.exec(`PRAGMA index_list(${table})`)[0];
  if (!indexes) return [];
  const nameAt = indexes.columns.indexOf('name');
  const uniqueAt = indexes.columns.indexOf('unique');
  return indexes.values.filter((row) => row[uniqueAt] === 1).map((row) => String(row[nameAt]));
}

function primaryKeyColumns(db: Database, table: string): string[] {
  const result = db.exec(`PRAGMA table_info(${table})`)[0];
  const nameAt = result.columns.indexOf('name');
  const primaryKeyAt = result.columns.indexOf('pk');
  return result.values
    .filter((column) => Number(column[primaryKeyAt]) > 0)
    .sort((a, b) => Number(a[primaryKeyAt]) - Number(b[primaryKeyAt]))
    .map((column) => String(column[nameAt]));
}

function schemaSql(db: Database): Array<[string, string, string]> {
  const result = db.exec(`
    SELECT type, name, sql FROM sqlite_master
    WHERE type IN ('table', 'index') AND sql IS NOT NULL
    ORDER BY type, name
  `)[0];
  return result.values.map(([type, name, sql]) => [String(type), String(name), String(sql)]);
}
