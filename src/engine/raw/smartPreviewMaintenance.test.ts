import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDirectory, listFakeEntries } from '../../test/fakeFileSystem';
import { evictSmartPreviews, scheduleSmartPreviewEviction, sweepStalePreviewVersions } from './smartPreviewMaintenance';
import type { RawPixelData } from './RawDecoderStrategy';

async function writeBytes(dir: FileSystemDirectoryHandle, name: string, size: number): Promise<void> {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await writable.write(new Uint8Array(size));
  await writable.close();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sweepStalePreviewVersions (F038)', () => {
  it('deletes slots of older versions and keeps current slots and foreign files', async () => {
    const dir = createFakeDirectory();
    for (const name of [
      'k_1200_v5.tiff', 'k_1200_v5.jpg', 'k_1200_v6.tiff', 'k_1800_v6.jpg',
      'k_native_8000_v6.tiff', 'k_native_8000_v7.tiff', 'notes.txt',
    ]) await writeBytes(dir, name, 1);

    expect(await sweepStalePreviewVersions(dir)).toBe(3);
    expect((await listFakeEntries(dir)).sort())
      .toEqual(['k_1200_v6.tiff', 'k_1800_v6.jpg', 'k_native_8000_v7.tiff', 'notes.txt']);
  });
});

describe('evictSmartPreviews (F087)', () => {
  it('deletes the oldest-written files until the store fits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const dir = createFakeDirectory();
    vi.setSystemTime(1_000);
    await writeBytes(dir, 'a_1200_v6.tiff', 100);
    vi.setSystemTime(2_000);
    await writeBytes(dir, 'b_1200_v6.tiff', 100);
    vi.setSystemTime(3_000);
    await writeBytes(dir, 'c_1200_v6.tiff', 100);

    expect(await evictSmartPreviews(dir, 150)).toBe(2);
    expect(await listFakeEntries(dir)).toEqual(['c_1200_v6.tiff']);
  });

  it('leaves a store under its cap alone', async () => {
    const dir = createFakeDirectory();
    await writeBytes(dir, 'a_1200_v6.tiff', 100);
    expect(await evictSmartPreviews(dir, 100)).toBe(0);
    expect(await listFakeEntries(dir)).toEqual(['a_1200_v6.tiff']);
  });

  it('evicts 2 s after the first write even while more writes keep coming', async () => {
    vi.useFakeTimers();
    const dir = createFakeDirectory();
    await writeBytes(dir, 'a_1200_v6.tiff', 100);
    await writeBytes(dir, 'b_1200_v6.tiff', 100);

    scheduleSmartPreviewEviction(dir, 150);
    await vi.advanceTimersByTimeAsync(1_500);
    scheduleSmartPreviewEviction(dir, 150);
    await vi.advanceTimersByTimeAsync(400);
    expect(await listFakeEntries(dir)).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(async () => expect(await listFakeEntries(dir)).toHaveLength(1));
  });
});

describe('first open of the store in a session (F038)', () => {
  it('drops older versions from both stores and keeps libraw-wasm pixels', async () => {
    const root = createFakeDirectory();
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    const { getDefaultRawPixelsCache } = await import('./RawPixelsOpfsCache');
    const { openSmartPreviewDir } = await import('./smartPreviewMaintenance');

    const pixels = getDefaultRawPixelsCache();
    const sample: RawPixelData = {
      data: new Uint16Array(6), width: 2, height: 1, channels: 3, bits: 16,
      colorMatrix: null, asShotNeutral: null,
    };
    for (const variant of ['1200v5', '1200v6', '1200']) await pixels.put('k', variant, sample);
    const previews = await root.getDirectoryHandle('smart-previews', { create: true });
    await writeBytes(previews, 'k_1200_v5.tiff', 10);
    await writeBytes(previews, 'k_1200_v6.tiff', 10);

    await openSmartPreviewDir();
    await vi.waitFor(async () => expect(await pixels.has('k', '1200v5')).toBe(false));
    expect(await listFakeEntries(previews)).toEqual(['k_1200_v6.tiff']);
    expect(await pixels.has('k', '1200v6')).toBe(true);
    expect(await pixels.has('k', '1200')).toBe(true);
  });
});
