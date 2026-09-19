import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDirectory, readFakeFile } from '../test/fakeFileSystem';
import { stubWebLocks } from '../test/fakeLocks';
import { compactThumbBins } from './compact';
import { FolderStorage } from './FolderStorage';
import { MemoryStorage } from './MemoryStorage';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

const PREFIX = 4;
const jpeg = (fill: number, length: number) => new Uint8Array(length).fill(fill);

async function readAll(storage: FolderStorage): Promise<Record<string, number[] | null>> {
  const rows = storage.db.exec('SELECT contentHash, size, length FROM thumbIndex ORDER BY contentHash')[0]?.values ?? [];
  const out: Record<string, number[] | null> = {};
  for (const [hash, size, length] of rows) {
    const blob = await storage.readThumb(String(hash), size as 'small' | 'large');
    out[String(hash)] = blob && blob.size === Number(length) ? [...new Uint8Array(await blob.arrayBuffer())] : null;
  }
  return out;
}

beforeEach(() => {
  stubWebLocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FolderStorage.compactThumbs', () => {
  it('rewrites every bin with slack and keeps every indexed thumb readable', async () => {
    const root = createFakeDirectory();
    const storage = await FolderStorage.open(root, 'opfs');
    await storage.writeThumb('ab01', 'small', new Blob([jpeg(1, 3)]));
    await storage.writeThumb('ab01', 'small', new Blob([jpeg(2, 3)]));
    await storage.writeThumb('cd01', 'small', new Blob([jpeg(3, 5)]));
    await storage.writeThumb('ab02', 'large', new Blob([jpeg(4, 6)]));

    const result = await compactThumbBins(storage);
    expect(result).toMatchObject({
      binsTouched: 1,
      binsSkipped: 2,
      bytesBefore: 2 * (PREFIX + 3) + (PREFIX + 5) + (PREFIX + 6),
      bytesAfter: (PREFIX + 3) + (PREFIX + 5) + (PREFIX + 6),
      errors: [],
    });
    expect((await readFakeFile(root, 'thumbs/small/ab.bin'))?.size).toBe(PREFIX + 3);
    expect(await readAll(storage)).toEqual({ ab01: [2, 2, 2], ab02: [4, 4, 4, 4, 4, 4], cd01: [3, 3, 3, 3, 3] });
  });

  it('keeps thumbs written alongside the compaction, awaited or not', async () => {
    const root = createFakeDirectory();
    const storage = await FolderStorage.open(root, 'opfs');
    await storage.writeThumb('ab01', 'small', new Blob([jpeg(1, 4)]));
    await storage.writeThumb('ab01', 'small', new Blob([jpeg(2, 4)]));

    const writes = [3, 4, 5].map((fill) => storage.writeThumb(`ab0${fill}`, 'small', new Blob([jpeg(fill, 4)])));
    const compaction = storage.compactThumbs();
    const more = [6, 7].map((fill) => storage.writeThumb(`ab0${fill}`, 'small', new Blob([jpeg(fill, 4)])));
    const [result] = await Promise.all([compaction, ...writes, ...more]);

    expect(result.errors).toEqual([]);
    expect(await readAll(storage)).toEqual({
      ab01: [2, 2, 2, 2],
      ab03: [3, 3, 3, 3],
      ab04: [4, 4, 4, 4],
      ab05: [5, 5, 5, 5],
      ab06: [6, 6, 6, 6],
      ab07: [7, 7, 7, 7],
    });
    expect((await readFakeFile(root, 'thumbs/small/ab.bin'))?.size).toBe(6 * (PREFIX + 4));
  });

  it('persists the moved offsets', async () => {
    const root = createFakeDirectory();
    const storage = await FolderStorage.open(root, 'opfs');
    await storage.writeThumb('ab01', 'small', new Blob([jpeg(1, 4)]));
    await storage.writeThumb('ab02', 'small', new Blob([jpeg(2, 4)]));
    await storage.writeThumb('ab01', 'small', new Blob([jpeg(3, 4)]));
    await storage.compactThumbs();
    await storage.close();

    const reopened = await FolderStorage.open(root, 'opfs');
    expect(await readAll(reopened)).toEqual({ ab01: [3, 3, 3, 3], ab02: [2, 2, 2, 2] });
  });
});

describe('compactThumbBins without a folder', () => {
  it('reports that a memory catalog has nothing to compact', async () => {
    const result = await compactThumbBins(await MemoryStorage.create());
    expect(result).toMatchObject({ binsTouched: 0, binsSkipped: 0, errors: ['no folder root (memory storage)'] });
  });
});
