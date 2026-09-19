import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDirectory, listFakeEntries } from '../../test/fakeFileSystem';
import { RawPixelsOpfsCache } from './RawPixelsOpfsCache';
import type { RawPixelData } from './RawDecoderStrategy';

const INDEX = '_index.v2.json';
let root: FileSystemDirectoryHandle;

function samplePixels(fill: number): RawPixelData {
  return {
    data: new Uint16Array(4 * 2 * 3).fill(fill),
    width: 4, height: 2, channels: 3, bits: 16,
    colorMatrix: null, asShotNeutral: null,
  };
}

function pixelsDir(): Promise<FileSystemDirectoryHandle> {
  return root.getDirectoryHandle('pixels', { create: true });
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: string | Uint8Array): Promise<void> {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(data as FileSystemWriteChunkType);
  await writable.close();
}

async function binFiles(): Promise<string[]> {
  return (await listFakeEntries(await pixelsDir())).filter((n) => n.endsWith('.bin'));
}

async function fileSize(name: string): Promise<number> {
  return (await (await (await pixelsDir()).getFileHandle(name)).getFile()).size;
}

beforeEach(() => {
  root = createFakeDirectory();
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RawPixelsOpfsCache index repair (F123)', () => {
  it('serves the pixels after a crash left the index empty, and counts them', async () => {
    await new RawPixelsOpfsCache().put('k', '1200v6', samplePixels(7));
    await writeFile(await pixelsDir(), INDEX, '');

    const cache = new RawPixelsOpfsCache();
    expect((await cache.get('k', '1200v6'))?.data).toEqual(samplePixels(7).data);
    const [bin] = await binFiles();
    expect(await cache.totalBytes()).toBe(await fileSize(bin));
  });

  it('still wipes a store that has no index at all (fresh or v1)', async () => {
    await writeFile(await pixelsDir(), 'legacy-1200.bin', new Uint8Array(10));
    const cache = new RawPixelsOpfsCache();
    expect(await cache.totalBytes()).toBe(0);
    expect(await listFakeEntries(await pixelsDir())).toEqual([]);
  });

  it('lets the LRU delete files it only knows by name after a rebuild', async () => {
    const first = new RawPixelsOpfsCache();
    await first.put('a', '1200v6', samplePixels(1));
    await first.put('b', '1200v6', samplePixels(2));
    await writeFile(await pixelsDir(), INDEX, '{"broken"');

    const cache = new RawPixelsOpfsCache();
    expect(await cache.totalBytes()).toBeGreaterThan(0);
    await cache.lruEvictTo(0);
    expect(await binFiles()).toEqual([]);
  });

  it('counts a file once when a put follows the rebuild', async () => {
    await new RawPixelsOpfsCache().put('a', '1200v6', samplePixels(1));
    await writeFile(await pixelsDir(), INDEX, 'null');

    const cache = new RawPixelsOpfsCache();
    await cache.put('a', '1200v6', samplePixels(1));
    const [bin] = await binFiles();
    expect(await cache.totalBytes()).toBe(await fileSize(bin));
  });

  it('knows a rebuilt file through has()', async () => {
    await new RawPixelsOpfsCache().put('a', '1200v6', samplePixels(1));
    await writeFile(await pixelsDir(), INDEX, '');
    const cache = new RawPixelsOpfsCache();
    expect(await cache.has('a', '1200v6')).toBe(true);
    expect(await cache.has('a', '2540v6')).toBe(false);
  });
});

describe('RawPixelsOpfsCache lookup and key changes (F087)', () => {
  it('answers has() from the index without touching a file', async () => {
    const cache = new RawPixelsOpfsCache();
    await cache.put('a', '1200v6', samplePixels(1));
    const lookup = vi.spyOn(await pixelsDir(), 'getFileHandle');
    expect(await cache.has('a', '1200v6')).toBe(true);
    expect(await cache.has('b', '1200v6')).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('renames every bucket of a key, and the index on disk follows', async () => {
    const cache = new RawPixelsOpfsCache();
    await cache.put('old', '1200v6', samplePixels(1));
    await cache.put('old', '2540v6', samplePixels(2));
    const bytes = await cache.totalBytes();

    expect(await cache.rename('old', 'new')).toBe(2);
    expect(await cache.get('old', '1200v6')).toBeNull();
    expect((await cache.get('new', '2540v6'))?.data).toEqual(samplePixels(2).data);

    const reloaded = new RawPixelsOpfsCache();
    expect(await reloaded.has('new', '1200v6')).toBe(true);
    expect(await reloaded.has('old', '1200v6')).toBe(false);
    expect(await reloaded.totalBytes()).toBe(bytes);
    expect(await binFiles()).toHaveLength(2);
  });

  it('renames a file known only from a rebuilt index', async () => {
    await new RawPixelsOpfsCache().put('old', '1200v6', samplePixels(3));
    await writeFile(await pixelsDir(), INDEX, '');
    const cache = new RawPixelsOpfsCache();
    expect(await cache.rename('old', 'new')).toBe(1);
    expect((await cache.get('new', '1200v6'))?.data).toEqual(samplePixels(3).data);
    expect(await binFiles()).toHaveLength(1);
  });

  it('keeps a bucket that already exists under the new key', async () => {
    const cache = new RawPixelsOpfsCache();
    await cache.put('old', '1200v6', samplePixels(1));
    await cache.put('new', '1200v6', samplePixels(9));
    expect(await cache.rename('old', 'new')).toBe(0);
    expect((await cache.get('new', '1200v6'))?.data).toEqual(samplePixels(9).data);
    expect(await cache.get('old', '1200v6')).toBeNull();
  });

  it('evicts only the entries a predicate selects', async () => {
    const cache = new RawPixelsOpfsCache();
    for (const variant of ['1200v5', '1200v6', '1200']) await cache.put('k', variant, samplePixels(1));
    expect(await cache.evictWhere((_key, variant) => variant === '1200v5')).toBe(1);
    expect(await cache.has('k', '1200v5')).toBe(false);
    expect(await cache.has('k', '1200v6')).toBe(true);
    expect(await cache.has('k', '1200')).toBe(true);
    expect(await binFiles()).toHaveLength(2);
  });
});
