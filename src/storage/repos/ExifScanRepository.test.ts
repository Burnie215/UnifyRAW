import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../MemoryStorage';
import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import { openCatalogDbFromBytes } from '../sqljs-init';
import { selectLocalSince } from '../SyncedStorage';
import { buildRepositories } from './index';
import type { PhotoRow } from './types';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

function listed(id: string): Omit<PhotoRow, 'id' | 'deletedAt'> {
  return {
    sourceId: 'source', sourcePhotoId: id, contentHash: null, name: `${id}.jpg`, mimeType: 'image/jpeg',
    sizeBytes: 1, dateTaken: null, dateModified: null, sourcePath: null, availability: 'online',
    sourceRevision: 0, indexedAt: 1, updatedAt: 100, width: null, height: null, sourceBits: null, camera: null, lens: null,
    iso: null, focalLength: null, aperture: null, shutterSpeed: null, latitude: null, longitude: null,
    blurHash: null, stackId: null, stackPosition: null,
  };
}

// MemoryStorage lost its fromBytes with the dead-code card; reopening a
// catalog goes through openCatalogDbFromBytes, and the repositories need
// nothing from the storage but the database and flush.
function catalogOf(db: Database): CatalogStorage {
  return { db, flush() { /* a test keeps nothing on disk */ } } as unknown as CatalogStorage;
}

describe('ExifScanRepository', () => {
  it('keeps its marks across closing and reopening the catalog', async () => {
    const storage = await MemoryStorage.create();
    buildRepositories(storage, () => undefined).exifScans.markScanned([1, 2], 111);

    const reopenedDb = await openCatalogDbFromBytes(storage.exportDb());
    const reopened = catalogOf(reopenedDb);
    const marks = buildRepositories(reopened, () => undefined).exifScans.scannedIds();

    expect([...marks]).toEqual([1, 2]);
    await storage.close();
    reopenedDb.close();
  });

  it('appears in a catalog written before the table existed, without a migration step', async () => {
    const older = await MemoryStorage.create();
    older.db.exec('DROP TABLE exifScan');
    const bytes = older.exportDb();
    await older.close();

    const openedDb = await openCatalogDbFromBytes(bytes);
    const opened = catalogOf(openedDb);
    const repos = buildRepositories(opened, () => undefined);
    repos.exifScans.markScanned([3], 222);

    expect(repos.exifScans.scannedIds().has(3)).toBe(true);
    openedDb.close();
  });

  it('marks a photo without bumping the storage revision', async () => {
    const storage = await MemoryStorage.create();
    let bumps = 0;
    const repos = buildRepositories(storage, () => { bumps += 1; });

    repos.exifScans.markScanned([1], 333);
    expect(bumps).toBe(0);

    // Control: a write to the photo row itself is what reloads the library.
    const [id] = repos.photos.bulkAdd([listed('p1')]);
    repos.photos.bulkUpdate([{ id, patch: { camera: 'Fujifilm X-T5' } }]);
    expect(bumps).toBe(2);

    await storage.close();
  });

  it('never sends a mark to the sync hub', async () => {
    const storage = await MemoryStorage.create();
    const repos = buildRepositories(storage, () => undefined);
    const [id] = repos.photos.bulkAdd([listed('p1')]);
    const listing = selectLocalSince(storage.db, 'photos', 0);
    expect(listing).toHaveLength(1);
    const pushed = Number(listing[0].localSeq);

    repos.exifScans.markScanned([id], 444);

    expect(selectLocalSince(storage.db, 'photos', pushed)).toEqual([]);
    const columns = storage.db.exec('PRAGMA table_info(exifScan)')[0].values.map((row) => String(row[1]));
    expect(columns).toEqual(['photoId', 'scannedAt']);

    await storage.close();
  });
});
