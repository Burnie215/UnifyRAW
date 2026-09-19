import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from 'sql.js';
import type { CatalogStorage, ThumbSize } from '../CatalogStorage';
import { createEmptyCatalogDb } from '../sqljs-init';
import { ThumbnailRepository } from './ThumbnailRepository';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

function memoryStorage(db?: Database): CatalogStorage {
  const blobs = new Map<string, Blob>();
  const key = (hash: string, size: ThumbSize) => `${size}/${hash}`;
  return {
    info: { kind: 'memory', label: 'test', persistent: false },
    db: (db ?? {}) as CatalogStorage['db'],
    readThumb: async (hash, size) => blobs.get(key(hash, size)) ?? null,
    writeThumb: async (hash, size, blob) => {
      blobs.set(key(hash, size), blob);
      // FolderStorage locates a thumb through thumbIndex, so the fake keeps
      // that table in step: it is what a bulk delete enumerates.
      db?.run(
        `INSERT OR REPLACE INTO thumbIndex(contentHash, size, binId, offset, length)
         VALUES (?, ?, '00', 0, ?)`,
        [hash, size, blob.size],
      );
    },
    deleteThumb: async (hash, size) => {
      blobs.delete(key(hash, size));
      db?.run('DELETE FROM thumbIndex WHERE contentHash = ? AND size = ?', [hash, size]);
    },
    flush: () => {},
    flushNow: async () => {},
    exportDb: () => new Uint8Array(),
    close: async () => {},
  };
}

describe('ThumbnailRepository', () => {
  it('deletes a persisted thumbnail and its RAM entry', async () => {
    const storage = memoryStorage();
    const repository = new ThumbnailRepository(storage);
    const blob = new Blob(['thumbnail'], { type: 'image/jpeg' });

    await repository.set('edit:hash', blob);
    expect(await repository.get('edit:hash')).not.toBeNull();

    await repository.delete('edit:hash');
    expect(await repository.get('edit:hash')).toBeNull();
    expect(repository.ramSize).toBe(0);
  });
});

describe('ThumbnailRepository.deleteByPrefix', () => {
  let db: Database | null = null;
  afterEach(() => { db?.close(); db = null; });

  it('takes the developed thumbnails and leaves the source ones', async () => {
    db = await createEmptyCatalogDb();
    const storage = memoryStorage(db);
    const repository = new ThumbnailRepository(storage);
    const blob = new Blob(['thumbnail'], { type: 'image/jpeg' });
    for (const key of ['edit:aaa', 'edit:stamp:bbb', 'ccc']) await repository.set(key, blob);
    await repository.set('edit:aaa', blob, 'large');

    expect(await repository.deleteByPrefix('edit:')).toBe(3);

    expect(await repository.get('edit:aaa')).toBeNull();
    expect(await repository.get('edit:aaa', 'large')).toBeNull();
    expect(await repository.get('edit:stamp:bbb')).toBeNull();
    expect(await repository.get('ccc')).not.toBeNull();
    // The index rows go with them, or the next run would find them again.
    expect(db.exec('SELECT contentHash FROM thumbIndex')[0]?.values.flat()).toEqual(['ccc']);
  });
});

/**
 * The background walker asks this once per pass instead of reading a blob per
 * photo, the way it already reads the sidecar index once per source.
 */
describe('ThumbnailRepository.storedKeys', () => {
  let db: Database | null = null;
  afterEach(() => { db?.close(); db = null; });

  it('names every key that has a small thumbnail, and only those', async () => {
    db = await createEmptyCatalogDb();
    const repository = new ThumbnailRepository(memoryStorage(db));
    const blob = new Blob(['thumbnail'], { type: 'image/jpeg' });
    await repository.set('src:local-1_a_dng_abc', blob);
    await repository.set('hash-b', blob);
    await repository.set('only-large', blob, 'large');

    expect([...await repository.storedKeys()].sort())
      .toEqual(['hash-b', 'src:local-1_a_dng_abc']);
    expect([...await repository.storedKeys('large')]).toEqual(['only-large']);
  });

  it('answers "nothing stored" for a catalog without a thumb index', async () => {
    const repository = new ThumbnailRepository(memoryStorage());
    await repository.set('hash-b', new Blob(['t']));
    expect(await repository.storedKeys()).toEqual(new Set());
  });
});
