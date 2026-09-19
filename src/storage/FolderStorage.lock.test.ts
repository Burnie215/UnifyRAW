import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDirectory, readFakeFile } from '../test/fakeFileSystem';
import { stubWebLocks } from '../test/fakeLocks';
import { acquireCatalogLock } from './catalogLock';
import { compactThumbBins } from './compact';
import { CatalogReadOnlyError, EncryptedCatalogError, FolderStorage } from './FolderStorage';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

async function fileBytes(root: FileSystemDirectoryHandle, path: string): Promise<Uint8Array | null> {
  const file = await readFakeFile(root, path);
  return file ? new Uint8Array(await file.arrayBuffer()) : null;
}

async function writeBytes(root: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<void> {
  const writable = await (await root.getFileHandle(name, { create: true })).createWritable();
  await writable.write(bytes as BufferSource);
  await writable.close();
}

function writeProbe(storage: FolderStorage, value: string): void {
  storage.db.run("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('probe', ?)", [value]);
}

function readProbe(storage: FolderStorage): string | null {
  const result = storage.db.exec("SELECT value FROM schema_meta WHERE key = 'probe'");
  return result.length > 0 ? String(result[0].values[0][0]) : null;
}

const thumb = (...bytes: number[]) => new Blob([new Uint8Array(bytes)]);

beforeEach(() => {
  stubWebLocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('FolderStorage opened twice on one catalog', () => {
  it('opens the second instance read-only and leaves version.json to the holder', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const root = createFakeDirectory();
    vi.setSystemTime(1_000);
    const holder = await FolderStorage.open(root, 'opfs');
    vi.setSystemTime(2_000);
    const reader = await FolderStorage.open(root, 'opfs');

    expect(holder.info.readOnly).toBeUndefined();
    expect(reader.info).toMatchObject({ readOnly: true, readOnlyReason: 'locked' });
    const version = JSON.parse(new TextDecoder().decode((await fileBytes(root, 'version.json'))!));
    expect(version.lastOpenedAt).toBe(1_000);
  });

  it('persists through the holder and never through the reader, not even on close', async () => {
    const root = createFakeDirectory();
    const holder = await FolderStorage.open(root, 'opfs');
    const reader = await FolderStorage.open(root, 'opfs');
    writeProbe(holder, 'holder');
    await holder.flushNow();
    const afterHolder = await fileBytes(root, 'catalog.sqlite');

    writeProbe(reader, 'reader');
    reader.flush();
    await reader.flushNow();
    await reader.close();
    expect(await fileBytes(root, 'catalog.sqlite')).toEqual(afterHolder);
  });

  it('leaves the thumb bins and its own thumb index alone', async () => {
    const root = createFakeDirectory();
    const holder = await FolderStorage.open(root, 'opfs');
    await holder.writeThumb('ab01', 'small', thumb(1, 2, 3));
    await holder.flushNow();
    const reader = await FolderStorage.open(root, 'opfs');
    const bin = await fileBytes(root, 'thumbs/small/ab.bin');
    expect(bin?.byteLength).toBe(7);

    await reader.writeThumb('ab02', 'small', thumb(9, 9));
    await reader.deleteThumb('ab01', 'small');
    expect(await fileBytes(root, 'thumbs/small/ab.bin')).toEqual(bin);
    expect(await reader.readThumb('ab02', 'small')).toBeNull();
    expect((await reader.readThumb('ab01', 'small'))?.size).toBe(3);
  });

  it('refuses encryption changes and bin compaction', async () => {
    const root = createFakeDirectory();
    const holder = await FolderStorage.open(root, 'opfs');
    // The same hash twice leaves a dead record behind: something to compact.
    await holder.writeThumb('ab01', 'small', thumb(1, 2, 3));
    await holder.writeThumb('ab01', 'small', thumb(4, 5, 6));
    await holder.flushNow();
    const reader = await FolderStorage.open(root, 'opfs');
    const catalog = await fileBytes(root, 'catalog.sqlite');
    const bin = await fileBytes(root, 'thumbs/small/ab.bin');
    expect(bin?.byteLength).toBe(14);

    await expect(reader.enableEncryption('a long passphrase')).rejects.toBeInstanceOf(CatalogReadOnlyError);
    await expect(reader.disableEncryption()).rejects.toBeInstanceOf(CatalogReadOnlyError);
    expect((await compactThumbBins(reader)).errors).toEqual(['read-only']);

    expect(await fileBytes(root, 'catalog.sqlite')).toEqual(catalog);
    expect(await fileBytes(root, 'thumbs/small/ab.bin')).toEqual(bin);
  });

  it('hands the catalog to the next open once the holder closes', async () => {
    const root = createFakeDirectory();
    const holder = await FolderStorage.open(root, 'opfs');
    writeProbe(holder, 'kept');
    await holder.close();

    const next = await FolderStorage.open(root, 'opfs');
    expect(next.info.readOnly).toBeUndefined();
    expect(readProbe(next)).toBe('kept');
  });

  it('treats two picked folders of the same name as one catalog', async () => {
    const first = await FolderStorage.open(createFakeDirectory('Fotos'), 'filesystem');
    const sameName = await FolderStorage.open(createFakeDirectory('Fotos'), 'filesystem');
    const other = await FolderStorage.open(createFakeDirectory('Archiv'), 'filesystem');
    expect(first.info.readOnly).toBeUndefined();
    expect(sameName.info.readOnly).toBe(true);
    expect(other.info.readOnly).toBeUndefined();
  });

  it('lets go of the lock when the open fails', async () => {
    const root = createFakeDirectory();
    const envelope = new Uint8Array(64);
    envelope.set(new TextEncoder().encode('PLE1'));
    await writeBytes(root, 'catalog.sqlite', envelope);

    await expect(FolderStorage.open(root, 'opfs')).rejects.toBeInstanceOf(EncryptedCatalogError);
    expect(await acquireCatalogLock('photolib-catalog:opfs')).toBeTypeOf('function');
  });
});
