import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../storage/MemoryStorage';
import { PhotoMetaRepository } from '../storage/repos/PhotoMetaRepository';
import { PhotoRepository } from '../storage/repos/PhotoRepository';
import type { PhotoRow } from '../storage/repos/types';
import {
  applyServerPathMigration,
  normalizeMigrationPath,
  planServerPathMigration,
  serverPathTargetsOwnBackend,
  type MigrationCatalogRow,
  type MigrationTargetAsset,
} from './serverPathMigration';

// sqljs-init passes the Vite `?url` asset path as the wasm location, which
// node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

function row(overrides: Partial<MigrationCatalogRow> = {}): MigrationCatalogRow {
  return {
    id: 1,
    sourcePhotoId: '2025/IMG_0001.CR3',
    name: 'IMG_0001.CR3',
    sizeBytes: 25_000_000,
    contentHash: null,
    deletedAt: null,
    ...overrides,
  };
}

function asset(overrides: Partial<MigrationTargetAsset> = {}): MigrationTargetAsset {
  return {
    id: 'asset-1',
    relativePath: '2025/IMG_0001.CR3',
    name: 'IMG_0001.CR3',
    sizeBytes: 25_000_000,
    quickHash: null,
    status: 'online',
    revision: 7,
    ...overrides,
  };
}

function plan(rows: MigrationCatalogRow[], assets: MigrationTargetAsset[]) {
  return planServerPathMigration({
    sourceId: 'server-path-1',
    targetSourceId: 'library-1',
    rows,
    assets,
  });
}

describe('planServerPathMigration', () => {
  it('matches by content hash before path, so a renamed file keeps its row', () => {
    const result = plan(
      [row({ contentHash: 'hash-a', sourcePhotoId: '2025/old-name.CR3', name: 'old-name.CR3' })],
      [asset({ id: 'asset-a', quickHash: 'hash-a', relativePath: '2025/new-name.CR3', name: 'new-name.CR3' })],
    );

    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]).toMatchObject({
      photoId: 1,
      toSourcePhotoId: 'asset-a',
      matchedBy: 'content-hash',
      sourceRevision: 7,
      availability: 'online',
    });
    expect(result.stays).toEqual([]);
    expect(result.totals.unclaimedAssets).toBe(0);
  });

  it('matches by relative path when the row was never hashed', () => {
    const result = plan([row()], [asset({ id: 'asset-b', quickHash: 'hash-b' })]);

    expect(result.moves[0]).toMatchObject({ matchedBy: 'relative-path', toSourcePhotoId: 'asset-b' });
    // The row had no hash, so the asset's may fill it in - that is what puts
    // the row on the same content identity every other library row uses.
    expect(result.moves[0].fillContentHash).toBe('hash-b');
  });

  it('never overwrites a content hash a row already carries', () => {
    // Same path, different bytes: the file was re-encoded after the catalog
    // hashed it. Rating, keywords and edits hang off the OLD hash.
    const result = plan(
      [row({ contentHash: 'hash-old' })],
      [asset({ id: 'asset-c', quickHash: 'hash-new' })],
    );

    expect(result.moves[0]).toMatchObject({ matchedBy: 'relative-path', fillContentHash: null });
  });

  it('falls back to name and size, and ignores rows without a size', () => {
    const matched = plan(
      [row({ sourcePhotoId: 'inbox/IMG_0001.CR3' })],
      [asset({ id: 'asset-d', relativePath: '2025/IMG_0001.CR3' })],
    );
    expect(matched.moves[0]).toMatchObject({ matchedBy: 'name-and-size', toSourcePhotoId: 'asset-d' });

    const unsized = plan(
      [row({ sourcePhotoId: 'inbox/IMG_0001.CR3', sizeBytes: null })],
      [asset({ relativePath: '2025/IMG_0001.CR3' })],
    );
    expect(unsized.moves).toEqual([]);
    expect(unsized.stays[0].reason).toBe('no-match');
  });

  it('leaves an ambiguous row behind instead of guessing', () => {
    const result = plan(
      [row({ sourcePhotoId: 'inbox/IMG_0001.CR3' })],
      [
        asset({ id: 'asset-e', relativePath: '2025/IMG_0001.CR3' }),
        asset({ id: 'asset-f', relativePath: '2024/IMG_0001.CR3' }),
      ],
    );

    expect(result.moves).toEqual([]);
    expect(result.stays[0]).toMatchObject({ photoId: 1, reason: 'ambiguous' });
    expect(result.totals.unclaimedAssets).toBe(2);
  });

  it('escapes an ambiguous tier through a sharper one', () => {
    // Two copies of the same bytes: the hash fits both assets, the path fits
    // exactly one.
    const result = plan(
      [row({ contentHash: 'hash-g', sourcePhotoId: '2025/IMG_0001.CR3' })],
      [
        asset({ id: 'asset-g1', quickHash: 'hash-g', relativePath: '2025/IMG_0001.CR3' }),
        asset({ id: 'asset-g2', quickHash: 'hash-g', relativePath: 'backup/IMG_0001.CR3' }),
      ],
    );

    expect(result.moves[0]).toMatchObject({ matchedBy: 'relative-path', toSourcePhotoId: 'asset-g1' });
    expect(result.totals.unclaimedAssets).toBe(1);
  });

  it('gives a contested asset to the live row and moves the removed one only if it fits elsewhere', () => {
    const result = plan(
      [
        row({ id: 9, deletedAt: 1_700_000_000_000 }),
        row({ id: 10 }),
      ],
      [asset({ id: 'asset-h' })],
    );

    expect(result.moves).toHaveLength(1);
    expect(result.moves[0]).toMatchObject({ photoId: 10, removed: false });
    expect(result.stays[0]).toMatchObject({ photoId: 9, reason: 'asset-already-claimed', removed: true });
  });

  it('carries a removed row along when nothing contests its asset', () => {
    const result = plan(
      [row({ id: 4, deletedAt: 1_700_000_000_000 })],
      [asset({ id: 'asset-i' })],
    );

    expect(result.moves[0]).toMatchObject({ photoId: 4, removed: true, toSourcePhotoId: 'asset-i' });
  });

  it('counts every row exactly once and reports the assets no row claims', () => {
    const result = plan(
      [
        row({ id: 1, contentHash: 'hash-1' }),
        row({ id: 2, sourcePhotoId: '2025/IMG_0002.CR3', name: 'IMG_0002.CR3' }),
        row({ id: 3, sourcePhotoId: 'gone/IMG_0003.CR3', name: 'IMG_0003.CR3', sizeBytes: 17 }),
      ],
      [
        asset({ id: 'asset-1', quickHash: 'hash-1' }),
        asset({ id: 'asset-2', relativePath: '2025/IMG_0002.CR3', name: 'IMG_0002.CR3' }),
        asset({ id: 'asset-3', relativePath: '2025/IMG_0009.CR3', name: 'IMG_0009.CR3' }),
      ],
    );

    expect(result.totals).toMatchObject({
      rows: 3,
      moves: 2,
      stays: 1,
      unclaimedAssets: 1,
    });
    expect(result.totals.moves + result.totals.stays).toBe(result.totals.rows);
    expect(result.totals.matchedBy).toEqual({
      'content-hash': 1,
      'relative-path': 1,
      'name-and-size': 0,
    });
    expect(result.totals.stayedBecause).toEqual({
      'no-match': 1,
      'ambiguous': 0,
      'asset-already-claimed': 0,
    });
  });

  it('is decided by the plan alone - the same input plans the same moves twice', () => {
    const rows = [row({ id: 1, contentHash: 'hash-1' }), row({ id: 2, sourcePhotoId: 'a/b.jpg', name: 'b.jpg' })];
    const assets = [asset({ id: 'asset-1', quickHash: 'hash-1' }), asset({ id: 'asset-2', relativePath: 'a/b.jpg', name: 'b.jpg' })];

    expect(plan(rows, assets)).toEqual(plan([...rows].reverse(), [...assets].reverse()));
  });
});

describe('normalizeMigrationPath', () => {
  it('makes both sides of a path comparison comparable', () => {
    expect(normalizeMigrationPath('/2025//IMG_0001.CR3')).toBe('2025/IMG_0001.CR3');
    expect(normalizeMigrationPath('./2025/IMG_0001.CR3')).toBe('2025/IMG_0001.CR3');
    expect(normalizeMigrationPath('2025\\IMG_0001.CR3')).toBe('2025/IMG_0001.CR3');
    expect(normalizeMigrationPath('2025/trip/')).toBe('2025/trip');
  });
});

describe('serverPathTargetsOwnBackend', () => {
  it('accepts the same-origin self-hosted case, including an empty server URL', () => {
    expect(serverPathTargetsOwnBackend('', '', 'https://photo.example.com')).toBe(true);
    expect(serverPathTargetsOwnBackend('https://photo.example.com', '', 'https://photo.example.com')).toBe(true);
  });

  it('accepts a source that points at the configured backend of an online build', () => {
    expect(serverPathTargetsOwnBackend(
      'https://backend.example.com',
      'https://backend.example.com',
      'https://app.example.com',
    )).toBe(true);
  });

  it('refuses a source pointing at somebody else\'s server', () => {
    expect(serverPathTargetsOwnBackend(
      'https://other.example.com',
      'https://backend.example.com',
      'https://app.example.com',
    )).toBe(false);
    expect(serverPathTargetsOwnBackend('ftp://nas.local', '', 'https://photo.example.com')).toBe(false);
  });
});

describe('applyServerPathMigration', () => {
  let storage: MemoryStorage;
  let photos: PhotoRepository;
  let meta: PhotoMetaRepository;

  beforeEach(async () => {
    storage = await MemoryStorage.create();
    photos = new PhotoRepository(storage, () => {});
    meta = new PhotoMetaRepository(storage, () => {});
  });

  afterEach(async () => {
    await storage.close();
  });

  function listed(overrides: Partial<PhotoRow> = {}): Omit<PhotoRow, 'id' | 'updatedAt' | 'deletedAt'> {
    return {
      sourceId: 'server-path-1',
      sourcePhotoId: '2025/IMG_0001.CR3',
      contentHash: null,
      name: 'IMG_0001.CR3',
      mimeType: 'image/x-canon-cr3',
      sizeBytes: 25_000_000,
      dateTaken: 1_700_000_000_000,
      dateModified: 1_700_000_000_000,
      sourcePath: null,
      availability: 'online',
      sourceRevision: 0,
      indexedAt: 1_000,
      width: null, height: null, sourceBits: null,
      camera: null, lens: null, iso: null, focalLength: null, aperture: null, shutterSpeed: null,
      latitude: null, longitude: null, blurHash: null, stackId: null, stackPosition: null,
      ...overrides,
    };
  }

  it('moves the row to the library source without changing its id, hash or rating', () => {
    const id = photos.add(listed({ contentHash: 'hash-a' }));
    meta.set('hash-a', { rating: 4, flag: 'pick', keywords: ['Urlaub'] });

    const migration = plan(
      [row({ id, contentHash: 'hash-a' })],
      [asset({ id: 'asset-a', quickHash: 'hash-a', status: 'offline', revision: 12 })],
    );
    expect(applyServerPathMigration(photos, migration)).toBe(1);

    expect(photos.count({ sourceId: 'server-path-1' })).toBe(0);
    const moved = photos.getById(id);
    expect(moved).toMatchObject({
      id,
      sourceId: 'library-1',
      sourcePhotoId: 'asset-a',
      contentHash: 'hash-a',
      sourcePath: '2025/IMG_0001.CR3',
      availability: 'offline',
      sourceRevision: 12,
      // The user data rides on the content hash and therefore on the row.
      rating: 4,
      flag: 'pick',
      keywords: ['Urlaub'],
    });
  });

  it('leaves every row that stays exactly where it was', () => {
    const moving = photos.add(listed({ contentHash: 'hash-a' }));
    const staying = photos.add(listed({ sourcePhotoId: 'gone/IMG_0002.CR3', name: 'IMG_0002.CR3', sizeBytes: 17 }));

    const migration = plan(
      [
        row({ id: moving, contentHash: 'hash-a' }),
        row({ id: staying, sourcePhotoId: 'gone/IMG_0002.CR3', name: 'IMG_0002.CR3', sizeBytes: 17 }),
      ],
      [asset({ id: 'asset-a', quickHash: 'hash-a' })],
    );
    applyServerPathMigration(photos, migration);

    expect(photos.getById(staying)).toMatchObject({
      sourceId: 'server-path-1',
      sourcePhotoId: 'gone/IMG_0002.CR3',
    });
    // Nothing is deleted: both rows are still in the catalog, on two sources.
    expect(photos.count({ sourceId: 'server-path-1' })).toBe(1);
    expect(photos.count({ sourceId: 'library-1' })).toBe(1);
  });

  it('writes nothing at all when one move collides with an existing row', () => {
    const first = photos.add(listed({ contentHash: 'hash-a' }));
    const second = photos.add(listed({ sourcePhotoId: '2025/IMG_0002.CR3', name: 'IMG_0002.CR3' }));
    // A row that already sits on the target source under the id one move wants.
    photos.add(listed({ sourceId: 'library-1', sourcePhotoId: 'asset-a' }));

    const migration = plan(
      [
        row({ id: first, contentHash: 'hash-a' }),
        row({ id: second, sourcePhotoId: '2025/IMG_0002.CR3', name: 'IMG_0002.CR3' }),
      ],
      [
        asset({ id: 'asset-a', quickHash: 'hash-a' }),
        asset({ id: 'asset-b', relativePath: '2025/IMG_0002.CR3', name: 'IMG_0002.CR3' }),
      ],
    );
    expect(migration.moves).toHaveLength(2);

    expect(() => applyServerPathMigration(photos, migration)).toThrow();
    expect(photos.getById(first)).toMatchObject({ sourceId: 'server-path-1' });
    expect(photos.getById(second)).toMatchObject({ sourceId: 'server-path-1' });
  });
});
