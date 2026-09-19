import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../MemoryStorage';
import { PhotoRepository } from './PhotoRepository';
import type { PhotoRow } from './types';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

type NewPhoto = Omit<PhotoRow, 'id' | 'updatedAt' | 'deletedAt'> & Partial<Pick<PhotoRow, 'updatedAt'>>;

function listed(overrides: Partial<NewPhoto> = {}): NewPhoto {
  return {
    sourceId: 'immich-1',
    sourcePhotoId: 'Alle Fotos/asset-1',
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
    width: null,
    height: null,
    sourceBits: null,
    camera: null, lens: null, iso: null, focalLength: null, aperture: null, shutterSpeed: null,
    latitude: null, longitude: null, blurHash: null, stackId: null, stackPosition: null,
    ...overrides,
  };
}

describe('PhotoRepository.bulkAdd', () => {
  let storage: MemoryStorage;
  let repo: PhotoRepository;

  beforeEach(async () => {
    storage = await MemoryStorage.create();
    repo = new PhotoRepository(storage, () => {});
  });

  afterEach(async () => {
    await storage.close();
  });

  it('adds a photo the catalog already holds without failing and keeps its id', () => {
    const [first] = repo.bulkAdd([listed({ updatedAt: 100 })]);
    // The second listing of an overlapping scan, which decided "new" from its
    // own snapshot.
    const [second] = repo.bulkAdd([listed({ updatedAt: 200 })]);

    expect(second).toBe(first);
    expect(repo.count({ sourceId: 'immich-1' })).toBe(1);
  });

  it('keeps a known hash and dimensions when the listing does not carry them', () => {
    const [id] = repo.bulkAdd([listed({ contentHash: 'abc123', width: 6000, height: 4000 })]);
    repo.bulkAdd([listed({ contentHash: null, width: null, height: null })]);

    const row = repo.getById(id)!;
    expect(row.contentHash).toBe('abc123');
    expect(row.width).toBe(6000);
    expect(row.height).toBe(4000);
  });

  it('takes the listing fields of the newer listing', () => {
    const [id] = repo.bulkAdd([listed()]);
    repo.bulkAdd([listed({ name: 'IMG_0001-renamed.CR3', sizeBytes: 26_000_000, availability: 'offline' })]);

    const row = repo.getById(id)!;
    expect(row.name).toBe('IMG_0001-renamed.CR3');
    expect(row.sizeBytes).toBe(26_000_000);
    expect(row.availability).toBe('offline');
  });

  it('moves updatedAt only when a field really changed, so a rescan pushes nothing', () => {
    const [id] = repo.bulkAdd([listed({ updatedAt: 100 })]);

    repo.bulkAdd([listed({ updatedAt: 200 })]);
    expect(repo.getById(id)!.updatedAt).toBe(100);

    repo.bulkAdd([listed({ updatedAt: 300, contentHash: 'filled-in' })]);
    expect(repo.getById(id)!.updatedAt).toBe(300);
  });

  it('leaves a soft-deleted photo deleted', () => {
    const [id] = repo.bulkAdd([listed()]);
    repo.bulkSoftDelete([id]);

    const [again] = repo.bulkAdd([listed()]);

    expect(again).toBe(id);
    expect(repo.listRaw({ sourceId: 'immich-1' })).toEqual([]);
  });

  it('returns one id per photo in order within one batch', () => {
    const ids = repo.bulkAdd([
      listed({ sourcePhotoId: 'a' }),
      listed({ sourcePhotoId: 'b' }),
      listed({ sourcePhotoId: 'a' }),
    ]);

    expect(ids[0]).toBe(ids[2]);
    expect(ids[1]).not.toBe(ids[0]);
    expect(repo.bulkGet(ids).map((row) => row.sourcePhotoId).sort()).toEqual(['a', 'b']);
  });
});

describe('PhotoRepository soft delete and restore', () => {
  let storage: MemoryStorage;
  let repo: PhotoRepository;

  beforeEach(async () => {
    storage = await MemoryStorage.create();
    repo = new PhotoRepository(storage, () => {});
  });

  afterEach(async () => {
    await storage.close();
  });

  it('hides a removed photo from the library but hands it to a listing that asks for it', () => {
    const [id] = repo.bulkAdd([listed()]);
    repo.bulkSoftDelete([id]);

    expect(repo.listRaw({ sourceId: 'immich-1' })).toEqual([]);
    expect(repo.list({ sourceId: 'immich-1' })).toEqual([]);

    const withDeleted = repo.listRaw({ sourceId: 'immich-1', includeDeleted: true });
    expect(withDeleted.map((row) => row.id)).toEqual([id]);
    expect(withDeleted[0].deletedAt).not.toBeNull();
  });

  it('brings the removed photo back under the same id', () => {
    const [id] = repo.bulkAdd([listed()]);
    repo.bulkSoftDelete([id]);

    repo.bulkRestore([id]);

    const rows = repo.listRaw({ sourceId: 'immich-1' });
    expect(rows.map((row) => row.id)).toEqual([id]);
    expect(rows[0].deletedAt).toBeNull();
    expect(repo.count({ sourceId: 'immich-1' })).toBe(1);
  });

  it('restores exactly the ids it was given', () => {
    const [a, b] = repo.bulkAdd([listed({ sourcePhotoId: 'a' }), listed({ sourcePhotoId: 'b' })]);
    repo.bulkSoftDelete([a, b]);

    repo.bulkRestore([a]);

    expect(repo.listRaw({ sourceId: 'immich-1' }).map((row) => row.id)).toEqual([a]);
    expect(repo.getById(b)!.deletedAt).not.toBeNull();
  });

  it('does nothing on an empty id list', () => {
    const [id] = repo.bulkAdd([listed()]);
    repo.bulkSoftDelete([id]);

    repo.bulkRestore([]);

    expect(repo.listRaw({ sourceId: 'immich-1' })).toEqual([]);
  });

  it('takes an ingest update as the way back, keeping the id the collections point at', () => {
    // What a rescan does now: the row is known, so it is patched, not inserted.
    const [id] = repo.bulkAdd([listed()]);
    repo.bulkSoftDelete([id]);

    repo.bulkUpdate([{ id, patch: { deletedAt: null, name: 'IMG_0001.CR3' } }]);

    expect(repo.listRaw({ sourceId: 'immich-1' }).map((row) => row.id)).toEqual([id]);
  });
});

describe('PhotoRepository update columns', () => {
  let storage: MemoryStorage;
  let repo: PhotoRepository;
  let id: number;

  beforeEach(async () => {
    storage = await MemoryStorage.create();
    repo = new PhotoRepository(storage, () => {});
    [id] = repo.bulkAdd([listed()]);
  });

  afterEach(async () => {
    await storage.close();
  });

  it.each(['update', 'bulkUpdate'] as const)('rejects an unexpected SQL column in %s', (method) => {
    const patch = { 'name = NULL WHERE id = ?; --': 'ignored' } as unknown as Partial<Omit<PhotoRow, 'id'>>;

    expect(() => {
      if (method === 'update') repo.update(id, patch);
      else repo.bulkUpdate([{ id, patch }]);
    }).toThrow('Unsupported photo update column');
    expect(repo.getById(id)?.name).toBe('IMG_0001.CR3');
  });
});
