import { describe, expect, it, vi } from 'vitest';
import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import { MemoryStorage } from '../MemoryStorage';
import { openCatalogDbFromBytes } from '../sqljs-init';
import { buildRepositories } from './index';
import { exportSyncId } from './ExportRepository';
import type { ExportRow } from './types';

vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

function catalogOf(db: Database): CatalogStorage {
  return { db, flush() { /* the exported DB bytes are the persistence boundary */ } } as CatalogStorage;
}

function exported(
  overrides: Partial<Omit<ExportRow, 'id' | 'syncId' | 'updatedAt'>> = {},
): Omit<ExportRow, 'id' | 'syncId' | 'updatedAt'> {
  return {
    contentHash: 'content-a',
    copyIndex: 0,
    targetSourceId: 'immich-a',
    targetAssetId: 'asset-1',
    targetUrl: 'https://photos.example/asset-1',
    format: 'jpg',
    editStackHash: 'stack-a',
    filename: 'photo__edit-stack-a.jpg',
    bytes: 1234,
    status: 'ok',
    uploadedAt: 1_700_000_000_000,
    deletedAt: null,
    ...overrides,
  };
}

describe('ExportRepository', () => {
  it('upserts a repeated export identity instead of adding a second row', async () => {
    const storage = await MemoryStorage.create();
    const writes: string[] = [];
    const exports = buildRepositories(storage, (table) => writes.push(table)).exports;

    exports.record(exported());
    exports.record(exported({
      targetAssetId: 'asset-returned-for-existing',
      targetUrl: null,
      bytes: 4321,
      uploadedAt: 1_700_000_000_500,
    }));

    const rows = exports.listForHash('content-a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetAssetId: 'asset-returned-for-existing',
      targetUrl: null,
      bytes: 4321,
      uploadedAt: 1_700_000_000_500,
      status: 'ok',
    });
    expect(writes).toEqual(['exports', 'exports']);
    await storage.close();
  });

  it('keeps different formats or edit stacks as distinct exports and filters copies', async () => {
    const storage = await MemoryStorage.create();
    const exports = buildRepositories(storage, () => undefined).exports;
    exports.record(exported());
    exports.record(exported({ format: 'png', targetAssetId: 'asset-png', uploadedAt: 20 }));
    exports.record(exported({ editStackHash: 'stack-b', targetAssetId: 'asset-stack-b', uploadedAt: 30 }));
    exports.record(exported({ copyIndex: 1, targetAssetId: 'asset-copy', uploadedAt: 40 }));

    expect(exports.listForHash('content-a')).toHaveLength(4);
    expect(exports.listForHash('content-a', 0).map((row) => row.targetAssetId)).toEqual([
      'asset-1',
      'asset-stack-b',
      'asset-png',
    ]);
    expect(exports.listForHash('content-a', 1).map((row) => row.targetAssetId)).toEqual(['asset-copy']);
    await storage.close();
  });

  it('returns the latest target export and can mark that asset missing', async () => {
    const storage = await MemoryStorage.create();
    const exports = buildRepositories(storage, () => undefined).exports;
    exports.record(exported({ uploadedAt: 100 }));
    exports.record(exported({ editStackHash: 'stack-b', targetAssetId: 'asset-2', uploadedAt: 200 }));
    exports.record(exported({ targetSourceId: 'other', targetAssetId: 'asset-other', uploadedAt: 300 }));

    const latest = exports.latestFor('content-a', 0, 'immich-a');
    expect(latest?.targetAssetId).toBe('asset-2');
    exports.markMissing(latest!.id);
    expect(exports.latestFor('content-a', 0, 'immich-a')?.status).toBe('missing');
    await storage.close();
  });

  it('survives exporting and reopening the catalog database', async () => {
    const storage = await MemoryStorage.create();
    buildRepositories(storage, () => undefined).exports.record(exported());

    const reopenedDb = await openCatalogDbFromBytes(storage.exportDb());
    const row = buildRepositories(catalogOf(reopenedDb), () => undefined).exports.latestFor(
      'content-a',
      0,
      'immich-a',
    );

    expect(row).toMatchObject({ targetAssetId: 'asset-1', editStackHash: 'stack-a', bytes: 1234 });
    await storage.close();
    reopenedDb.close();
  });

  it('gives a ledger written before the identity column its syncId on reopen', async () => {
    const older = await MemoryStorage.create();
    // The v5 ledger: no syncId, identity carried by a unique index instead.
    older.db.exec('DROP TABLE exports');
    older.db.exec(`CREATE TABLE exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contentHash TEXT NOT NULL, copyIndex INTEGER NOT NULL DEFAULT 0,
      targetSourceId TEXT NOT NULL, targetAssetId TEXT NOT NULL, targetUrl TEXT,
      format TEXT NOT NULL, editStackHash TEXT NOT NULL, filename TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ok',
      uploadedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER)`);
    older.db.exec(`CREATE UNIQUE INDEX idx_exports_identity
      ON exports(contentHash, copyIndex, targetSourceId, editStackHash, format)`);
    older.db.exec(`INSERT INTO exports
      (contentHash, copyIndex, targetSourceId, targetAssetId, targetUrl, format,
       editStackHash, filename, bytes, status, uploadedAt, updatedAt, deletedAt)
      VALUES ('content-a', 0, 'immich-a', 'asset-1', NULL, 'jpg', 'stack-a', 'p.jpg', 1, 'ok', 5, 5, NULL)`);
    const bytes = older.exportDb();
    await older.close();

    const openedDb = await openCatalogDbFromBytes(bytes);
    const exports = buildRepositories(catalogOf(openedDb), () => undefined).exports;
    const [migrated] = exports.listForHash('content-a');
    expect(migrated.syncId).toBe(exportSyncId(migrated));

    // The upsert now conflicts on syncId, so the same export has to land on
    // the migrated row rather than beside it.
    exports.record(exported({ targetAssetId: 'asset-2', uploadedAt: 600 }));
    expect(exports.listForHash('content-a')).toHaveLength(1);
    expect(exports.latestFor('content-a', 0, 'immich-a')?.targetAssetId).toBe('asset-2');
    openedDb.close();
  });

  it('appears when a catalog created before schema v4 is reopened', async () => {
    const older = await MemoryStorage.create();
    older.db.exec('DROP TABLE exports');
    const bytes = older.exportDb();
    await older.close();

    const openedDb = await openCatalogDbFromBytes(bytes);
    const exports = buildRepositories(catalogOf(openedDb), () => undefined).exports;
    exports.record(exported());

    expect(exports.listForHash('content-a')).toHaveLength(1);
    openedDb.close();
  });
});
