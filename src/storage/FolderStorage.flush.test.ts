import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDirectory, fakeFileHandle } from '../test/fakeFileSystem';
import { stubWebLocks } from '../test/fakeLocks';
import type { CatalogStorageEventMap } from './CatalogStorage';
import { FolderStorage } from './FolderStorage';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const quotaExceeded = () => new DOMException('no space left', 'QuotaExceededError');
const thumb = (...bytes: number[]) => new Blob([new Uint8Array(bytes)]);

function writeProbe(storage: FolderStorage, value: string): void {
  storage.db.run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('probe', ?)", [value]);
}

function readProbe(storage: FolderStorage): string | null {
  const result = storage.db.exec("SELECT value FROM schema_meta WHERE key = 'probe'");
  return result.length > 0 ? String(result[0].values[0][0]) : null;
}

function record(storage: FolderStorage) {
  const errors: CatalogStorageEventMap['error'][] = [];
  const flushes: CatalogStorageEventMap['flush'][] = [];
  storage.on('error', (ev) => errors.push(ev));
  storage.on('flush', (ev) => flushes.push(ev));
  return { errors, flushes };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

beforeEach(() => {
  stubWebLocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FolderStorage when a write fails', () => {
  it('reports a failed flush, retries it on its own and reports the write that lands', async () => {
    const root = createFakeDirectory();
    const storage = await FolderStorage.open(root, 'opfs');
    const events = record(storage);
    const catalog = await fakeFileHandle(root, 'catalog.sqlite');
    catalog.beforeCreateWritable = () => { throw quotaExceeded(); };

    writeProbe(storage, 'kept');
    await storage.flushNow();
    expect(events.errors).toHaveLength(1);
    expect(events.errors[0].op).toBe('flush');
    expect((events.errors[0].error as DOMException).name).toBe('QuotaExceededError');
    expect(events.flushes).toHaveLength(0);

    catalog.beforeCreateWritable = null;
    await vi.waitFor(() => expect(events.flushes).toHaveLength(1), { timeout: 3000 });
    expect(events.errors).toHaveLength(1);
    await storage.close();

    const reopened = await FolderStorage.open(root, 'opfs');
    expect(readProbe(reopened)).toBe('kept');
  });

  it('reports a failed thumbnail append and still rejects the write', async () => {
    const root = createFakeDirectory();
    const storage = await FolderStorage.open(root, 'opfs');
    const events = record(storage);
    await storage.writeThumb('ab01', 'small', thumb(1, 2, 3));
    (await fakeFileHandle(root, 'thumbs/small/ab.bin')).beforeCreateWritable = () => { throw quotaExceeded(); };

    await expect(storage.writeThumb('ab02', 'small', thumb(4, 5))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(events.errors.map((ev) => ev.op)).toEqual(['thumb-write']);
    expect(await storage.readThumb('ab02', 'small')).toBeNull();
  });

  it('stops retrying once closed and rejects the close with the last error', async () => {
    const root = createFakeDirectory();
    const storage = await FolderStorage.open(root, 'opfs');
    const events = record(storage);
    (await fakeFileHandle(root, 'catalog.sqlite')).beforeCreateWritable = () => { throw quotaExceeded(); };

    writeProbe(storage, 'lost');
    await expect(storage.close()).rejects.toMatchObject({ name: 'QuotaExceededError' });
    const errorsAtClose = events.errors.length;
    storage.flush();
    // Past the first retry (1 s) and the idle time of the flush() above (0.5 s):
    // either would export the closed database and report that as a new error.
    await sleep(1200);
    expect(events.errors).toHaveLength(errorsAtClose);
  });
});

describe('FolderStorage.flushNow and close', () => {
  it('persist a change made while an earlier flush was still writing', async () => {
    const root = createFakeDirectory();
    const storage = await FolderStorage.open(root, 'opfs');
    const catalog = await fakeFileHandle(root, 'catalog.sqlite');
    const held = gate();
    catalog.beforeCreateWritable = () => held.opened;

    writeProbe(storage, 'first');
    const firstFlush = storage.flushNow();
    await sleep(10);
    writeProbe(storage, 'second');
    const closing = storage.close();
    catalog.beforeCreateWritable = null;
    held.open();
    await Promise.all([firstFlush, closing]);

    const reopened = await FolderStorage.open(root, 'opfs');
    expect(readProbe(reopened)).toBe('second');
  });

  it('resolves only after version.json has landed', async () => {
    const root = createFakeDirectory();
    const storage = await FolderStorage.open(root, 'opfs');
    const held = gate();
    (await fakeFileHandle(root, 'version.json')).beforeCreateWritable = () => held.opened;

    // Something to write: a flush with nothing changed does not touch a file.
    writeProbe(storage, 'pending');
    let done = false;
    const flushed = storage.flushNow().then(() => { done = true; });
    await sleep(20);
    expect(done).toBe(false);
    held.open();
    await flushed;
    expect(done).toBe(true);
  });
});

describe('FolderStorage flushing without a change', () => {
  it('rewrites the catalog only after a row changed', async () => {
    const root = createFakeDirectory();
    const storage = await FolderStorage.open(root, 'opfs');
    const events = record(storage);

    writeProbe(storage, 'one');
    await storage.flushNow();
    await storage.flushNow();
    await storage.flushNow();
    expect(events.flushes).toHaveLength(1);

    writeProbe(storage, 'two');
    await storage.flushNow();
    expect(events.flushes).toHaveLength(2);

    await storage.close();
  });

  it('retries a failed write although nothing changed since', async () => {
    const root = createFakeDirectory();
    const storage = await FolderStorage.open(root, 'opfs');
    const events = record(storage);
    const catalog = await fakeFileHandle(root, 'catalog.sqlite');
    let failing = true;
    catalog.beforeCreateWritable = () => { if (failing) throw quotaExceeded(); };

    writeProbe(storage, 'kept');
    await storage.flushNow();
    expect(events.flushes).toHaveLength(0);
    expect(events.errors).toHaveLength(1);

    failing = false;
    await storage.flushNow();
    expect(events.flushes).toHaveLength(1);

    await storage.close();
  });
});
