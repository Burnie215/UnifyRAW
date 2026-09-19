/**
 * RawPixelsOpfsCache against the real OPFS and Web Locks of Chromium (F123,
 * F087). Each test works in its own directory and removes it afterwards.
 *
 * Browser-mode-only. Run with: npx vitest --project browser RawPixelsOpfsCache
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RawPixelsOpfsCache } from './RawPixelsOpfsCache';
import type { RawPixelData } from './RawDecoderStrategy';

const INDEX = '_index.v2.json';
const dirs: string[] = [];

function freshDir(): string {
  const name = `pixels-test-${crypto.randomUUID()}`;
  dirs.push(name);
  return name;
}

function samplePixels(fill: number): RawPixelData {
  return {
    data: new Uint16Array(16 * 8 * 3).fill(fill),
    width: 16, height: 8, channels: 3, bits: 16,
    colorMatrix: null, asShotNeutral: null,
  };
}

async function overwriteIndex(dirName: string, text: string): Promise<void> {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(dirName);
  const writable = await (await dir.getFileHandle(INDEX, { create: true })).createWritable();
  await writable.write(text);
  await writable.close();
}

afterEach(async () => {
  const root = await navigator.storage.getDirectory();
  for (const name of dirs.splice(0)) await root.removeEntry(name, { recursive: true }).catch(() => {});
});

describe('RawPixelsOpfsCache in the real OPFS', () => {
  it('serves the pixels after a crash left the index empty, without wiping', async () => {
    const dir = freshDir();
    await new RawPixelsOpfsCache(dir).put('k', '1200v6', samplePixels(7));
    await overwriteIndex(dir, '');

    const cache = new RawPixelsOpfsCache(dir);
    const got = await cache.get('k', '1200v6');
    expect(Array.from(got?.data ?? [])).toEqual(Array.from(samplePixels(7).data));
    expect(await cache.totalBytes()).toBeGreaterThan(0);
  });

  it('turns the old key into a miss and the new one into a hit on rename', async () => {
    const dir = freshDir();
    const cache = new RawPixelsOpfsCache(dir);
    await cache.put('old', '1200v6', samplePixels(3));

    expect(await cache.rename('old', 'new')).toBe(1);
    expect(await cache.get('old', '1200v6')).toBeNull();
    expect(Array.from((await cache.get('new', '1200v6'))?.data ?? [])).toEqual(Array.from(samplePixels(3).data));
    expect(await new RawPixelsOpfsCache(dir).has('new', '1200v6')).toBe(true);
  });

  it('answers has() from the index', async () => {
    const dir = freshDir();
    const cache = new RawPixelsOpfsCache(dir);
    await cache.put('k', '1200v6', samplePixels(1));
    expect(await cache.has('k', '1200v6')).toBe(true);
    expect(await cache.has('k', '2540v6')).toBe(false);
  });
});
