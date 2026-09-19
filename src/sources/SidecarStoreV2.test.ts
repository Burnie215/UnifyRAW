import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidecarStoreV2 } from './SidecarStoreV2';
import {
  createFakeDirectory,
  fakeFileHandle,
  listFakeEntries,
  readFakeFile,
} from '../test/fakeFileSystem';

const FLUSH_DELAY_MS = 3000;

function jpeg(...payload: number[]): Blob {
  return new Blob([new Uint8Array([0xff, 0xd8, ...payload, 0xff, 0xd9])], { type: 'image/jpeg' });
}

async function bytesOf(blob: Blob | null): Promise<number[] | null> {
  return blob ? [...new Uint8Array(await blob.arrayBuffer())] : null;
}

async function readIndex(root: FileSystemDirectoryHandle): Promise<unknown> {
  const file = await readFakeFile(root, '.photolib/index.json');
  return file ? JSON.parse(await file.text()) : null;
}

async function writeFakeFile(
  root: FileSystemDirectoryHandle,
  path: string,
  contents: Blob | string,
): Promise<void> {
  const segments = path.split('/');
  const fileName = segments.pop()!;
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true });
  const handle = await dir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

// setImmediate stays real so a test can let the async flush chain finish.
const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SidecarStoreV2', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts empty on an empty directory and writes .photolib/index.json only on flush', async () => {
    const root = createFakeDirectory();
    const store = new SidecarStoreV2(root);

    await store.init();
    expect(await store.getIndex()).toEqual({});
    expect(await store.count()).toBe(0);
    expect(await listFakeEntries(root)).toEqual([]);

    await store.setMeta('a.jpg', { w: 10 });
    await store.flushIndex();

    expect(await listFakeEntries(root)).toEqual(['.photolib']);
    expect(await readIndex(root)).toEqual({ version: 2, entries: { 'a.jpg': { w: 10 } } });
  });

  it('merges setMeta calls and reads them back after reopening the directory', async () => {
    const root = createFakeDirectory();
    const store = new SidecarStoreV2(root);

    await store.setMeta('Urlaub 2024/a.jpg', { w: 4000, h: 3000 });
    await store.setMeta('Urlaub 2024/a.jpg', { c: 'X-T5', h: 2999 });
    expect(await store.getMeta('Urlaub 2024/a.jpg')).toEqual({ w: 4000, h: 2999, c: 'X-T5' });
    expect(await store.getMeta('missing.jpg')).toBeNull();

    await store.flushIndex();

    const reopened = new SidecarStoreV2(root);
    expect(await reopened.getIndex()).toEqual({
      'Urlaub 2024/a.jpg': { w: 4000, h: 2999, c: 'X-T5' },
    });
  });

  it('appends thumbs to per-folder bins and reads the same bytes back', async () => {
    const root = createFakeDirectory();
    const store = new SidecarStoreV2(root);

    await store.writeThumb('a.jpg', jpeg(1, 2, 3), { w: 160 });
    await store.writeThumb('b.jpg', jpeg(4, 5));
    await store.writeThumb('Urlaub 2024/c.jpg', jpeg(6));

    expect(await bytesOf(await store.readThumb('a.jpg'))).toEqual([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    expect(await bytesOf(await store.readThumb('b.jpg'))).toEqual([0xff, 0xd8, 4, 5, 0xff, 0xd9]);
    expect(await bytesOf(await store.readThumb('Urlaub 2024/c.jpg'))).toEqual([0xff, 0xd8, 6, 0xff, 0xd9]);
    expect(await store.getMeta('b.jpg')).toEqual({ t: [7, 6], tb: 2 });
    expect(await store.thumbCount()).toBe(3);
    expect((await store.listThumbBins()).sort()).toEqual(['_dir_Urlaub%202024', '_root']);
    expect((await readFakeFile(root, '.photolib/thumbs/_root.bin'))?.size).toBe(13);

    await store.flushIndex();
    const reopened = new SidecarStoreV2(root);
    expect(await bytesOf(await reopened.readThumb('b.jpg'))).toEqual([0xff, 0xd8, 4, 5, 0xff, 0xd9]);
    expect(await reopened.getMeta('a.jpg')).toEqual({ t: [0, 7], tb: 2, w: 160 });
  });

  it('uses distinct bin names for directories whose legacy names collide', async () => {
    const root = createFakeDirectory();
    const store = new SidecarStoreV2(root);

    await store.writeThumb('a/b/one.jpg', jpeg(1));
    await store.writeThumb('a b/two.jpg', jpeg(2));

    const bins = (await store.listThumbBins()).sort();
    expect(bins).toHaveLength(2);
    expect(bins[0]).not.toBe(bins[1]);
    expect(await bytesOf(await store.readThumb('a/b/one.jpg'))).toEqual([0xff, 0xd8, 1, 0xff, 0xd9]);
    expect(await bytesOf(await store.readThumb('a b/two.jpg'))).toEqual([0xff, 0xd8, 2, 0xff, 0xd9]);
  });

  it('continues to read thumbnails from legacy lossy bin names', async () => {
    const root = createFakeDirectory();
    const thumb = jpeg(7, 8);
    await writeFakeFile(root, '.photolib/thumbs/Urlaub_2024.bin', thumb);
    await writeFakeFile(root, '.photolib/index.json', JSON.stringify({
      version: 2,
      entries: { 'Urlaub 2024/photo.jpg': { t: [0, thumb.size] } },
    }));

    const store = new SidecarStoreV2(root);

    expect(await bytesOf(await store.readThumb('Urlaub 2024/photo.jpg')))
      .toEqual([0xff, 0xd8, 7, 8, 0xff, 0xd9]);
  });

  it('returns null for thumbs whose bin is missing', async () => {
    const root = createFakeDirectory();
    const store = new SidecarStoreV2(root);

    await store.setMeta('a.jpg', { t: [0, 7] });
    await store.flushIndex();

    expect(await store.readThumb('a.jpg')).toBeNull();
    expect(await store.readThumb('never-written.jpg')).toBeNull();
  });

  it('writes the index once, 3 s after the first change, and later changes do not reset the timer', async () => {
    const root = createFakeDirectory();
    const store = new SidecarStoreV2(root);

    await store.setMeta('a.jpg', { w: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    await store.setMeta('b.jpg', { w: 2 });
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS - 2000 - 1);
    await nextMacrotask();
    expect(await readIndex(root)).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    await nextMacrotask();
    expect(await readIndex(root)).toEqual({
      version: 2,
      entries: { 'a.jpg': { w: 1 }, 'b.jpg': { w: 2 } },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('schedules another index flush when a timer fires during an active write', async () => {
    const root = createFakeDirectory();
    const store = new SidecarStoreV2(root);
    await store.setMeta('initial.jpg', { w: 1 });
    await store.flushIndex();

    const indexHandle = await fakeFileHandle(root, '.photolib/index.json');
    let releaseWrite!: () => void;
    const heldWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let createWritableCalls = 0;
    indexHandle.beforeCreateWritable = async () => {
      createWritableCalls++;
      if (createWritableCalls === 1) await heldWrite;
    };

    await store.setMeta('first.jpg', { w: 2 });
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    await nextMacrotask();
    expect(createWritableCalls).toBe(1);

    await store.setMeta('second.jpg', { w: 3 });
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    await nextMacrotask();
    expect(createWritableCalls).toBe(1);

    releaseWrite();
    await nextMacrotask();
    await vi.advanceTimersByTimeAsync(FLUSH_DELAY_MS);
    await nextMacrotask();

    expect(createWritableCalls).toBe(2);
    expect(await readIndex(root)).toEqual({
      version: 2,
      entries: {
        'initial.jpg': { w: 1 },
        'first.jpg': { w: 2 },
        'second.jpg': { w: 3 },
      },
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
