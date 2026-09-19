import type { Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ThumbSize } from './CatalogStorage';
import { MemoryStorage } from './MemoryStorage';
import { pruneRetiredEditThumbs } from './pruneRetiredEditThumbs';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

// Stands in for the profile stores: the RAW is covered by a profile whose
// current stamp is 'stampnew', everything else by none.
vi.mock('../engine/thumbnailStamp', () => ({
  thumbnailStampFor: (subject: { name: string }) => (subject.name === 'IMG_1.CR3' ? 'stampnew' : null),
}));

const RAW_HASH = 'a1'.repeat(32);
const JPEG_HASH = 'b2'.repeat(32);
const ORPHAN_HASH = 'c3'.repeat(32);

function addPhoto(db: Database, name: string, contentHash: string, deletedAt: number | null = null): void {
  db.run(
    `INSERT INTO photos (sourceId, sourcePhotoId, contentHash, name, availability, sourceRevision, indexedAt, updatedAt, deletedAt)
     VALUES ('src', ?, ?, ?, 'online', 0, 1, 1, ?)`,
    [name, contentHash, name, deletedAt],
  );
}

function addThumb(db: Database, key: string, size = 'small'): void {
  db.run(
    "INSERT INTO thumbIndex (contentHash, size, binId, offset, length) VALUES (?, ?, '00', 0, 10)",
    [key, size],
  );
}

function thumbKeys(db: Database): string[] {
  const result = db.exec('SELECT contentHash || \'/\' || size FROM thumbIndex ORDER BY 1');
  return (result[0]?.values ?? []).map(([key]) => String(key));
}

describe('pruneRetiredEditThumbs', () => {
  let storage: MemoryStorage;
  let db: Database;
  let thumbnails: { delete: Mock<(key: string, size?: ThumbSize) => Promise<void>> };

  beforeEach(async () => {
    storage = await MemoryStorage.create();
    db = storage.db;
    thumbnails = {
      delete: vi.fn(async (key: string, size: ThumbSize = 'small') => {
        db.run('DELETE FROM thumbIndex WHERE contentHash = ? AND size = ?', [key, size]);
      }),
    };
  });

  afterEach(async () => {
    await storage.close();
  });

  it('keeps the current stamp and drops the retired ones of the same photo', async () => {
    addPhoto(db, 'IMG_1.CR3', RAW_HASH);
    addThumb(db, `edit:stampold:${RAW_HASH}`);
    addThumb(db, `edit:stampold:${RAW_HASH}`, 'large');
    addThumb(db, `edit:${RAW_HASH}`);
    addThumb(db, `edit:stampnew:${RAW_HASH}`);
    addThumb(db, RAW_HASH);

    await expect(pruneRetiredEditThumbs(db, thumbnails)).resolves.toBe(3);

    expect(thumbKeys(db)).toEqual([RAW_HASH, `edit:stampnew:${RAW_HASH}`].map((key) => `${key}/small`).sort());
    expect(thumbnails.delete).toHaveBeenCalledWith(`edit:stampold:${RAW_HASH}`, 'large');
  });

  it('treats edit:<hash> as current for a photo no profile covers', async () => {
    addPhoto(db, 'IMG_2.JPG', JPEG_HASH);
    addThumb(db, `edit:${JPEG_HASH}`);
    addThumb(db, `edit:stampold:${JPEG_HASH}`);

    await expect(pruneRetiredEditThumbs(db, thumbnails)).resolves.toBe(1);

    expect(thumbKeys(db)).toEqual([`edit:${JPEG_HASH}/small`]);
  });

  it('leaves the keys of a hash alone when no live photo carries it', async () => {
    addPhoto(db, 'IMG_3.CR3', ORPHAN_HASH, 5);
    addThumb(db, `edit:stampold:${ORPHAN_HASH}`);
    addThumb(db, `edit:${ORPHAN_HASH}`);

    await expect(pruneRetiredEditThumbs(db, thumbnails)).resolves.toBe(0);

    expect(thumbnails.delete).not.toHaveBeenCalled();
    expect(thumbKeys(db)).toHaveLength(2);
  });
});
