import initSqlJs, { type Database } from 'sql.js';
import { CATALOG_SCHEMA_SQL, CLIENT_OVERLAY, SYNC_TABLES } from '@photolib/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Adjustments } from '../types';
import { MemoryStorage } from './MemoryStorage';
import { buildRepositories } from './repos';
import type { PhotoRow } from './repos/types';
import { createEmptyCatalogDb, LOCAL_SEQ_KEY, markAllForPush, openCatalogDbFromBytes } from './sqljs-init';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

afterEach(() => {
  vi.useRealTimers();
});

function columns(db: Database, table: string) {
  return db.exec(`PRAGMA table_info(${table})`)[0].values
    .map(([, name, type, notnull, dflt]) => ({ name, type, notnull, dflt }));
}

function localSeqs(db: Database, table: string, key: string): Record<string, number> {
  const rows = db.exec(`SELECT ${key}, localSeq FROM ${table} ORDER BY rowid`)[0]?.values ?? [];
  return Object.fromEntries(rows.map(([id, seq]) => [String(id), Number(seq)]));
}

function counter(db: Database): number {
  return Number(db.exec('SELECT value FROM schema_meta WHERE key = ?', [LOCAL_SEQ_KEY])[0].values[0][0]);
}

function insertPreset(db: Database, syncId: string, updatedAt: number): void {
  db.run(
    `INSERT INTO presets (syncId, name, adjustments, createdAt, updatedAt) VALUES (?, ?, '{}', 1, ?)`,
    [syncId, syncId, updatedAt],
  );
}

function listed(id: string): Omit<PhotoRow, 'id' | 'deletedAt'> {
  return {
    sourceId: 'source', sourcePhotoId: id, contentHash: null, name: `${id}.jpg`, mimeType: 'image/jpeg',
    sizeBytes: 1, dateTaken: null, dateModified: null, sourcePath: null, availability: 'online',
    sourceRevision: 0, indexedAt: 1, updatedAt: 100, width: null, height: null, sourceBits: null, camera: null, lens: null,
    iso: null, focalLength: null, aperture: null, shutterSpeed: null, latitude: null, longitude: null,
    blurHash: null, stackId: null, stackPosition: null,
  };
}

/** Repositories stamp updatedAt from Date.now(); two writes need two distinct milliseconds. */
function tick(at: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(at);
}

describe('client overlay', () => {
  it('adds CLIENT_OVERLAY, its index and both triggers to every sync table', async () => {
    const SQL = await initSqlJs();
    const shared = new SQL.Database();
    shared.exec(CATALOG_SCHEMA_SQL);
    const db = await createEmptyCatalogDb();

    for (const table of SYNC_TABLES) {
      expect(columns(db, table).map((column) => column.name), table)
        .toEqual([...columns(shared, table).map((column) => column.name), ...CLIENT_OVERLAY]);
      expect(columns(db, table).find((column) => column.name === 'localSeq'))
        .toEqual({ name: 'localSeq', type: 'INTEGER', notnull: 1, dflt: '0' });
      const objects = db.exec(
        "SELECT name FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger')", [table],
      )[0].values.map(([name]) => name);
      expect(objects, table).toEqual(expect.arrayContaining([
        `idx_${table}_localSeq`, `trg_${table}_seq_ins`, `trg_${table}_seq_upd`,
      ]));
    }
    shared.close();
    db.close();
  });

  it('numbers every local insert and update from one counter across tables', async () => {
    const storage = await MemoryStorage.create();
    const repos = buildRepositories(storage, () => undefined);

    tick(1_000);
    const presetId = repos.presets.add({ name: 'Film', adjustments: {} });
    tick(2_000);
    repos.edits.upsert({ contentHash: 'hash', adjustments: {} as Adjustments });
    tick(3_000);
    repos.presets.update(presetId, { name: 'Film 2' });
    tick(4_000);
    repos.edits.upsert({ contentHash: 'hash', adjustments: { exposure: 1 } as Adjustments });

    expect(Object.values(localSeqs(storage.db, 'presets', 'name'))).toEqual([3]);
    expect(localSeqs(storage.db, 'edits', 'contentHash')).toEqual({ hash: 4 });
    expect(counter(storage.db)).toBe(4);
    await storage.close();
  });

  it('leaves a pulled row (localSeq < 0) alone and marks the next local write to it', async () => {
    const db = await createEmptyCatalogDb();
    db.run(`INSERT INTO presets (syncId, name, adjustments, createdAt, updatedAt, localSeq)
            VALUES ('pulled', 'P', '{}', 1, 10, -1)`);
    expect(localSeqs(db, 'presets', 'syncId')).toEqual({ pulled: -1 });

    db.run("UPDATE presets SET name = 'P2', updatedAt = 20, localSeq = -2 WHERE syncId = 'pulled'");
    expect(localSeqs(db, 'presets', 'syncId')).toEqual({ pulled: -2 });

    db.run("UPDATE presets SET name = 'P3', updatedAt = 30 WHERE syncId = 'pulled'");
    expect(localSeqs(db, 'presets', 'syncId')).toEqual({ pulled: 1 });
    db.close();
  });

  it('does not mark an update that leaves updatedAt alone, such as a rescan of an unchanged library', async () => {
    const storage = await MemoryStorage.create();
    const repos = buildRepositories(storage, () => undefined);

    repos.photos.bulkAdd([listed('a'), listed('b')]);
    const listedOnce = localSeqs(storage.db, 'photos', 'sourcePhotoId');
    expect(listedOnce.a).toBeGreaterThan(0);
    expect(listedOnce.b).toBeGreaterThan(listedOnce.a);

    repos.photos.bulkAdd([listed('a'), listed('b')]);
    storage.db.run("UPDATE photos SET stackPosition = stackPosition WHERE sourcePhotoId = 'a'");
    expect(localSeqs(storage.db, 'photos', 'sourcePhotoId')).toEqual(listedOnce);

    repos.photos.bulkAdd([{ ...listed('a'), name: 'renamed.jpg', updatedAt: 200 }]);
    const renamed = localSeqs(storage.db, 'photos', 'sourcePhotoId');
    expect(renamed.b).toBe(listedOnce.b);
    expect(renamed.a).toBeGreaterThan(listedOnce.b);

    // bulkAdd numbers its rows itself, from the counter the triggers use.
    insertPreset(storage.db, 'after-listing', 300);
    expect(localSeqs(storage.db, 'presets', 'syncId')['after-listing']).toBeGreaterThan(renamed.a);
    await storage.close();
  });

  it('marks every row for the next push on markAllForPush, pulled and pushed rows included', async () => {
    const db = await createEmptyCatalogDb();
    insertPreset(db, 'local', 300);
    db.run(`INSERT INTO presets (syncId, name, adjustments, createdAt, updatedAt, localSeq)
            VALUES ('pulled', 'P', '{}', 1, 100, -1)`);
    db.run(`INSERT INTO edits (contentHash, copyIndex, adjustments, createdAt, updatedAt) VALUES ('pushed', 0, '{}', 1, 50)`);
    db.run("UPDATE edits SET localSeq = 0 WHERE contentHash = 'pushed'");

    expect(markAllForPush(db)).toBe(3);

    // Above every number handed out before (the counter stood at 2), in updatedAt order per table.
    expect(localSeqs(db, 'edits', 'contentHash')).toEqual({ pushed: 3 });
    expect(localSeqs(db, 'presets', 'syncId')).toEqual({ local: 5, pulled: 4 });
    expect(counter(db)).toBe(5);
    db.close();
  });

  it('never hands out a number twice, not even after the newest row is deleted', async () => {
    const db = await createEmptyCatalogDb();
    insertPreset(db, 'a', 1);
    insertPreset(db, 'b', 2);
    db.run("DELETE FROM presets WHERE syncId = 'b'");
    insertPreset(db, 'c', 3);
    expect(localSeqs(db, 'presets', 'syncId')).toEqual({ a: 1, c: 3 });
    db.close();
  });
});

describe('catalog column migration', () => {
  it('gives an existing catalog the sourceBits column without touching its rows', async () => {
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.exec(CATALOG_SCHEMA_SQL);
    legacy.run(`INSERT INTO photos (sourceId, sourcePhotoId, name, indexedAt, updatedAt, width)
                VALUES ('s1', 'p1', 'a.heic', 1, 2, 4032)`);
    // A catalog written before the column existed. Opening it must add the
    // column, or every ingest afterwards fails on an unknown SQL column.
    legacy.exec('ALTER TABLE photos DROP COLUMN sourceBits');

    const db = await openCatalogDbFromBytes(legacy.export());
    legacy.close();

    const columns = db.exec('PRAGMA table_info(photos)')[0].values.map((column) => column[1]);
    expect(columns).toContain('sourceBits');
    // NULL, not 0: nothing has read the file, so the probe still owes one look.
    expect(db.exec('SELECT name, width, sourceBits FROM photos')[0].values)
      .toEqual([['a.heic', 4032, null]]);
    db.close();
  });
});

describe('watermark migration', () => {
  it('numbers the rows above the old push watermark in updatedAt order and drops the old watermarks', async () => {
    const SQL = await initSqlJs();
    const legacy = new SQL.Database();
    legacy.exec(CATALOG_SCHEMA_SQL);
    insertPreset(legacy, 'pushed', 100);
    insertPreset(legacy, 'newest', 300);
    insertPreset(legacy, 'newer', 200);
    legacy.run(`INSERT INTO edits (contentHash, copyIndex, adjustments, createdAt, updatedAt)
                VALUES ('pushed', 0, '{}', 1, 150), ('pending', 0, '{}', 1, 250)`);
    // No push watermark at all: this table never reached the hub.
    legacy.run("INSERT INTO photoMeta (contentHash, rating, updatedAt) VALUES ('never-pushed', 3, 50)");
    for (const [key, value] of [
      ['sync.presets.pushAt', 150], ['sync.presets.pullAt', 400],
      ['sync.edits.pushAt', 200], ['sync.edits.pullAt', 200],
    ] as const) {
      legacy.run('INSERT INTO schema_meta (key, value) VALUES (?, ?)', [key, String(value)]);
    }

    const db = await openCatalogDbFromBytes(legacy.export());
    legacy.close();

    // Numbered table by table in SYNC_TABLES order (photoMeta, edits, presets).
    expect(localSeqs(db, 'photoMeta', 'contentHash')).toEqual({ 'never-pushed': 1 });
    expect(localSeqs(db, 'edits', 'contentHash')).toEqual({ pushed: 0, pending: 2 });
    expect(localSeqs(db, 'presets', 'syncId')).toEqual({ pushed: 0, newest: 4, newer: 3 });
    expect(counter(db)).toBe(4);
    expect(db.exec("SELECT key FROM schema_meta WHERE key LIKE 'sync.%'")[0].values).toEqual([[LOCAL_SEQ_KEY]]);

    // A second open finds the overlay and renumbers nothing; the triggers still count on.
    const reopened = await openCatalogDbFromBytes(db.export());
    db.close();
    expect(localSeqs(reopened, 'presets', 'syncId')).toEqual({ pushed: 0, newest: 4, newer: 3 });
    insertPreset(reopened, 'after-reopen', 500);
    expect(localSeqs(reopened, 'presets', 'syncId')['after-reopen']).toBe(5);
    reopened.close();
  });
});
