import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { waitForCatalogLock } from './catalogLock';
import { FolderStorage } from './FolderStorage';
import { buildRepositories } from './repos';

// Real OPFS and real Web Locks. Every test works in its own OPFS directory;
// the 'opfs' lock name ignores the directory, so it is the same lock the app takes.
let root: FileSystemDirectoryHandle;
let dirName: string;
const opened = new Set<FolderStorage>();

async function open(): Promise<FolderStorage> {
  const storage = await FolderStorage.open(root, 'opfs');
  opened.add(storage);
  return storage;
}

async function close(storage: FolderStorage): Promise<void> {
  opened.delete(storage);
  await storage.close();
}

async function catalogBytes(): Promise<Uint8Array> {
  const file = await (await root.getFileHandle('catalog.sqlite')).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

function rate(storage: FolderStorage, rating: number): void {
  buildRepositories(storage, () => undefined).photoMeta.set('c0ffee', { rating });
}

function ratingIn(storage: FolderStorage): number | null {
  return buildRepositories(storage, () => undefined).photoMeta.get('c0ffee')?.rating ?? null;
}

beforeEach(async () => {
  dirName = `folder-storage-test-${crypto.randomUUID()}`;
  root = await (await navigator.storage.getDirectory()).getDirectoryHandle(dirName, { create: true });
});

afterEach(async () => {
  for (const storage of opened) await close(storage).catch(() => undefined);
  // No retry: OPFS refuses to remove a directory with an open writable, so this
  // also checks that close() waits for every file it writes, version.json included.
  await (await navigator.storage.getDirectory()).removeEntry(dirName, { recursive: true });
});

describe('FolderStorage in two tabs on the OPFS catalog', () => {
  it('opens the second instance read-only', async () => {
    const holder = await open();
    const reader = await open();
    expect(holder.info.readOnly).toBeUndefined();
    expect(reader.info).toMatchObject({ readOnly: true, readOnlyReason: 'locked' });
  });

  it('persists a rating through the holder and nothing through the reader', async () => {
    const holder = await open();
    const reader = await open();
    const before = await catalogBytes();

    rate(holder, 4);
    await holder.flushNow();
    const afterHolder = await catalogBytes();
    expect(afterHolder).not.toEqual(before);

    rate(reader, 1);
    await reader.flushNow();
    expect(await catalogBytes()).toEqual(afterHolder);
  });

  it('hands the catalog to a third open once the holder closes', async () => {
    const holder = await open();
    const reader = await open();
    rate(holder, 5);
    await close(holder);

    const next = await open();
    expect(next.info.readOnly).toBeUndefined();
    expect(ratingIn(next)).toBe(5);

    const afterHandOver = await catalogBytes();
    rate(reader, 1);
    await close(reader);
    expect(await catalogBytes()).toEqual(afterHandOver);
  });

  it('compacts the thumb bins while thumbnails keep being written, and every thumb still reads back', async () => {
    const storage = await open();
    const hash = (i: number) => `0${i % 8}${String(i).padStart(6, '0')}`;
    const jpeg = (i: number, version = 0) => new Uint8Array(40 + (i % 17)).fill((i + version * 101) % 251);
    const write = (i: number, version = 0) => storage.writeThumb(hash(i), 'small', new Blob([jpeg(i, version)]));

    // 120 thumbs in 8 bins; the first 60 written again leave dead records behind.
    for (let i = 0; i < 120; i++) await write(i);
    for (let i = 0; i < 60; i++) await write(i, 1);
    const during: Promise<void>[] = [];
    for (let i = 120; i < 160; i++) during.push(write(i));
    const compaction = storage.compactThumbs();
    for (let i = 160; i < 200; i++) during.push(write(i));
    const [result] = await Promise.all([compaction, ...during]);

    expect(result.errors).toEqual([]);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);
    for (let i = 0; i < 200; i++) {
      const blob = await storage.readThumb(hash(i), 'small');
      expect(blob && new Uint8Array(await blob.arrayBuffer()), hash(i)).toEqual(jpeg(i, i < 60 ? 1 : 0));
    }
  });

  it('tells a waiting reader when the holder lets go', async () => {
    const holder = await open();
    await open();
    let free = false;
    const waiting = waitForCatalogLock('photolib-catalog:opfs').then(() => { free = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(free).toBe(false);

    await close(holder);
    await waiting;
    expect(free).toBe(true);
  });
});
