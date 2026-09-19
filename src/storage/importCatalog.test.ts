import initSqlJs from 'sql.js';
import { CATALOG_SCHEMA_SQL, CATALOG_SCHEMA_VERSION } from '@photolib/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  CatalogImportError,
  looksLikeSqlite,
  prepareImportedCatalog,
  schemaVersionAccepted,
} from './importCatalog';
import { createEmptyCatalogDb } from './sqljs-init';

// sqljs-init passes the Vite `?url` asset path as the wasm location, which
// node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

async function catalogBytes(fill: (db: import('sql.js').Database) => void): Promise<Uint8Array> {
  const db = await createEmptyCatalogDb();
  fill(db);
  const bytes = db.export();
  db.close();
  return bytes;
}

describe('recognising a SQLite file', () => {
  it('accepts the magic every SQLite file starts with', async () => {
    expect(looksLikeSqlite(await catalogBytes(() => {}))).toBe(true);
  });

  it('rejects what someone picked by mistake', () => {
    // A JPEG, an HTML error page, an empty file.
    expect(looksLikeSqlite(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(looksLikeSqlite(new TextEncoder().encode('<!doctype html><title>404'))).toBe(false);
    expect(looksLikeSqlite(new Uint8Array(0))).toBe(false);
  });
});

describe('which catalog versions may be opened', () => {
  it('takes anything this build knows or predates', () => {
    expect(schemaVersionAccepted(1, 6)).toBe(true);
    expect(schemaVersionAccepted(6, 6)).toBe(true);
  });

  it('refuses a catalog from a newer build', () => {
    // It would open, be written back through the older schema, and silently
    // lose whatever the newer one added.
    expect(schemaVersionAccepted(7, 6)).toBe(false);
  });

  it('treats a catalog without a recorded version as older', () => {
    expect(schemaVersionAccepted(null, 6)).toBe(true);
  });
});

describe('preparing an offered catalog', () => {
  it('counts the photos it would install', async () => {
    const bytes = await catalogBytes((db) => {
      db.run(`INSERT INTO photos (sourceId, sourcePhotoId, name, indexedAt, updatedAt)
              VALUES ('s1', 'p1', 'a.raf', 1, 2), ('s1', 'p2', 'b.raf', 1, 2)`);
      db.run(`INSERT INTO photos (sourceId, sourcePhotoId, name, indexedAt, updatedAt, deletedAt)
              VALUES ('s1', 'p3', 'gone.raf', 1, 2, 3)`);
    });
    const prepared = await prepareImportedCatalog(bytes);
    expect(prepared.photos).toBe(2);
  });

  it('empties the thumbnail index, which points at bins that are not here', async () => {
    const bytes = await catalogBytes((db) => {
      db.run(`INSERT INTO thumbIndex (contentHash, size, binId, offset, length)
              VALUES ('abc', 'small', 'bin-0', 0, 512)`);
    });
    const prepared = await prepareImportedCatalog(bytes);

    const SQL = await initSqlJs();
    const installed = new SQL.Database(prepared.bytes);
    // Left in place, every tile would resolve to a byte range of a bin file
    // that belongs to the catalog this came from.
    expect(installed.exec('SELECT COUNT(*) FROM thumbIndex')[0].values[0][0]).toBe(0);
    installed.close();
  });

  it('refuses a file that is not SQLite at all', async () => {
    await expect(prepareImportedCatalog(new TextEncoder().encode('not a catalog')))
      .rejects.toMatchObject({ reason: 'not-sqlite' });
  });

  it('refuses a SQLite file that holds some other application', async () => {
    const SQL = await initSqlJs();
    const stranger = new SQL.Database();
    stranger.run('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
    const bytes = stranger.export();
    stranger.close();
    await expect(prepareImportedCatalog(bytes)).rejects.toMatchObject({ reason: 'not-a-catalog' });
  });

  it('refuses a catalog written by a newer build, and says which', async () => {
    const SQL = await initSqlJs();
    const future = new SQL.Database();
    future.exec(CATALOG_SCHEMA_SQL);
    future.run('INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)',
      ['version', String(CATALOG_SCHEMA_VERSION + 1)]);
    const bytes = future.export();
    future.close();

    const refusal = await prepareImportedCatalog(bytes).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(CatalogImportError);
    expect(refusal).toMatchObject({ reason: 'newer-schema', foundVersion: CATALOG_SCHEMA_VERSION + 1 });
  });
});
