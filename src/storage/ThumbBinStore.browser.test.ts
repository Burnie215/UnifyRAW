import { describe, expect, it } from 'vitest';
import { ThumbBinStore } from './ThumbBinStore';

/**
 * A thumbnail read out of a bin has to survive the next write to that bin.
 *
 * `read()` used to hand back `file.slice(...)`, which is not a copy: the blob
 * points at the .bin file, and the browser remembers the size and mtime it had
 * at the time. Appending the next thumbnail - 256 buckets, so a grid fills the
 * same file over and over - moved the file on, and every object URL a tile was
 * still showing failed with net::ERR_UPLOAD_FILE_CHANGED. Measured on a live
 * instance on 2026-09-14: tiles went blank while scrolling, and came
 * back for a moment after a reload.
 *
 * This is a browser test because a fake file system cannot reproduce it: only
 * a real File from a real file handle carries the snapshot that goes stale.
 */

/** A 1x1 PNG - real bytes, so a failure to load means the blob is dead. */
function pngBytes(): Uint8Array<ArrayBuffer> {
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const bin = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Read the blob's bytes back through its object URL, the way an <img> does.
 *
 * Not `new Image()`: the browser serves a URL it has already decoded from its
 * image cache and never touches the file again, so a dead blob still "loads".
 * A fetch goes to the bytes every time.
 */
async function stillReadable(url: string): Promise<boolean> {
  try {
    const bytes = await (await fetch(url)).arrayBuffer();
    return bytes.byteLength > 0;
  } catch {
    return false;
  }
}

async function freshStore(): Promise<ThumbBinStore> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(`thumbs-${Date.now()}-${Math.random().toString(36).slice(2)}`, { create: true });
  return new ThumbBinStore(dir);
}

// Same first hex byte, so both land in bin `ab`.
const HASH_A = 'ab11111111111111';
const HASH_B = 'ab22222222222222';

describe('ThumbBinStore.read', () => {
  it('returns a thumbnail that survives the next append to the same bin', async () => {
    const store = await freshStore();
    const loc = await store.append(HASH_A, 'small', new Blob([pngBytes()]));

    const shown = await store.read(loc, 'small');
    expect(shown).not.toBeNull();
    const url = URL.createObjectURL(shown!);
    expect(await stillReadable(url)).toBe(true);

    // A second tile's thumbnail lands in the same bin file.
    await store.append(HASH_B, 'small', new Blob([pngBytes()]));

    expect(await stillReadable(url)).toBe(true);
    URL.revokeObjectURL(url);
  });

  it('returns a thumbnail that survives compaction of the same bin', async () => {
    const store = await freshStore();
    const locA = await store.append(HASH_A, 'small', new Blob([pngBytes()]));
    const locB = await store.append(HASH_B, 'small', new Blob([pngBytes()]));

    const shown = await store.read(locB, 'small');
    const url = URL.createObjectURL(shown!);
    expect(await stillReadable(url)).toBe(true);

    // Drop A and rewrite the bin without it.
    await store.compactBin('small', 'ab', () => [{ hash: HASH_B, offset: locB.offset, length: locB.length }], () => {});

    expect(await stillReadable(url)).toBe(true);
    URL.revokeObjectURL(url);
    expect(locA.offset).toBeGreaterThanOrEqual(0);
  });

  it('reads back the exact bytes that were written', async () => {
    const store = await freshStore();
    const loc = await store.append(HASH_A, 'small', new Blob([pngBytes()]));
    const blob = await store.read(loc, 'small');
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(pngBytes());
  });
});
