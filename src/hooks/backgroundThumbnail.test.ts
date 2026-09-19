import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backgroundThumbnailBlob,
  retainAcquiredThumbnail,
  type ThumbnailSource,
} from './backgroundThumbnail';
import type { PhotoRef } from '../sources/types';

const ref: PhotoRef = { sourcePhotoId: 'a1', sourceId: 's1', name: 'IMG_0001.CR3' };

const original = new Blob(['x'.repeat(64)], { type: 'image/x-canon-cr3' }) as unknown as File;
const sourceThumb = new Blob(['thumb'], { type: 'image/jpeg' });
const generated = new Blob(['generated'], { type: 'image/jpeg' });

function fakeSource(type: string, thumbUrl: string | null) {
  const getThumbnailUrl = vi.fn<
    (ref: PhotoRef, signal?: AbortSignal) => Promise<string | null>
  >(async () => thumbUrl);
  const getFile = vi.fn<
    (ref: PhotoRef, signal?: AbortSignal) => Promise<File | null>
  >(async () => original);
  return {
    type,
    getThumbnailUrl,
    getFile,
  } satisfies ThumbnailSource;
}

function ports(blob: Blob | null = sourceThumb) {
  return {
    fetchBlob: vi.fn(async () => blob),
    fromOriginal: vi.fn(async () => generated),
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('backgroundThumbnailBlob', () => {
  it('takes the thumbnail an Immich library offers and never asks for the original', async () => {
    const source = fakeSource('immich', 'https://immich.test/api/assets/a1/thumbnail');
    const p = ports();

    await expect(backgroundThumbnailBlob(source, ref, p)).resolves.toBe(sourceThumb);

    expect(p.fetchBlob.mock.calls).toEqual([[
      'https://immich.test/api/assets/a1/thumbnail',
      undefined,
    ]]);
    expect(source.getFile).toHaveBeenCalledTimes(0);
    expect(p.fromOriginal).toHaveBeenCalledTimes(0);
  });

  it('gives up rather than download the original when the thumbnail endpoint fails', async () => {
    const source = fakeSource('lychee', 'https://lychee.test/thumb/a1');
    const p = ports(null);

    await expect(backgroundThumbnailBlob(source, ref, p)).resolves.toBeNull();

    expect(source.getFile).toHaveBeenCalledTimes(0);
    expect(p.fromOriginal).toHaveBeenCalledTimes(0);
  });

  it('gives up when a remote source has no thumbnail endpoint at all', async () => {
    const source = fakeSource('photoprism', null);
    const p = ports();

    await expect(backgroundThumbnailBlob(source, ref, p)).resolves.toBeNull();

    expect(p.fetchBlob).toHaveBeenCalledTimes(0);
    expect(source.getFile).toHaveBeenCalledTimes(0);
  });

  it('refuses a source type with no row in the capability table', async () => {
    const source = fakeSource('not-a-source', null);
    const p = ports();

    await expect(backgroundThumbnailBlob(source, ref, p)).resolves.toBeNull();

    expect(source.getFile).toHaveBeenCalledTimes(0);
  });

  it('reads the original of a browser-owned folder, whose bytes are already here', async () => {
    const source = fakeSource('local', null);
    const p = ports();

    await expect(backgroundThumbnailBlob(source, ref, p)).resolves.toBe(generated);

    expect(source.getFile).toHaveBeenCalledTimes(1);
    expect(p.fromOriginal.mock.calls).toEqual([[original]]);
  });

  it('cancels an original read owned by a retired background pass', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const source = fakeSource('local', null);
    source.getFile.mockImplementation(async (_ref, signal) => new Promise<File | null>((resolve) => {
      expect(signal).toBe(controller.signal);
      started();
      signal?.addEventListener('abort', () => resolve(null), { once: true });
    }));
    const p = ports();

    const result = backgroundThumbnailBlob(source, ref, p, controller.signal);
    await readStarted;
    controller.abort();

    await expect(result).resolves.toBeNull();
    expect(p.fromOriginal).not.toHaveBeenCalled();
  });

  it('cancels a source thumbnail read owned by a retired background pass', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const source = fakeSource('immich', null);
    source.getThumbnailUrl.mockImplementation(async (_ref, signal) => new Promise<string | null>((resolve) => {
      expect(signal).toBe(controller.signal);
      started();
      signal?.addEventListener('abort', () => resolve(null), { once: true });
    }));
    const p = ports();

    const result = backgroundThumbnailBlob(source, ref, p, controller.signal);
    await readStarted;
    controller.abort();

    await expect(result).resolves.toBeNull();
    expect(p.fetchBlob).not.toHaveBeenCalled();
    expect(source.getFile).not.toHaveBeenCalled();
  });

  it('releases a blob URL acquired just after its background pass was cancelled', async () => {
    const controller = new AbortController();
    let release!: (url: string) => void;
    const source = fakeSource('immich', null);
    source.getThumbnailUrl.mockImplementation(async () => new Promise<string>((resolve) => {
      release = resolve;
    }));
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const p = ports();

    const result = backgroundThumbnailBlob(source, ref, p, controller.signal);
    controller.abort();
    release('blob:http://app/acquired-after-abort');

    await expect(result).resolves.toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:http://app/acquired-after-abort');
    expect(p.fetchBlob).not.toHaveBeenCalled();
  });

  it('releases the blob URL a source made for the read, whether or not it worked', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    await backgroundThumbnailBlob(fakeSource('immich', 'blob:http://app/kept'), ref, ports());
    await backgroundThumbnailBlob(fakeSource('immich', 'blob:http://app/failed'), ref, ports(null));

    expect(revoke.mock.calls).toEqual([['blob:http://app/kept'], ['blob:http://app/failed']]);
  });

  it('leaves a plain http thumbnail URL alone - it belongs to the server', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    await backgroundThumbnailBlob(fakeSource('immich', 'https://immich.test/thumb'), ref, ports());

    expect(revoke).toHaveBeenCalledTimes(0);
  });
});

describe('retainAcquiredThumbnail', () => {
  it('persists every blurHash even after the thumbnail memory cache starts evicting', async () => {
    const cache = new Map<number, Blob>();
    const hashes = new Map<number, string>();
    let current = 0;
    const persistSidecar = vi.fn();

    for (let id = 1; id <= 201; id++) {
      current = id;
      const blob = new Blob([String(id)]);
      await retainAcquiredThumbnail(blob, {
        cache: async (value) => {
          cache.set(current, value);
          if (cache.size > 200) cache.delete(cache.keys().next().value!);
        },
        persistBlob: () => {},
        computeBlurHash: async () => `hash-${current}`,
        persistBlurHash: (hash) => { hashes.set(current, hash); },
        persistSidecar,
      });
    }

    expect(cache.size).toBe(200);
    expect(cache.has(1)).toBe(false);
    expect(hashes.size).toBe(201);
    expect(hashes.get(1)).toBe('hash-1');
    expect(persistSidecar).toHaveBeenCalledTimes(201);
    expect(persistSidecar).toHaveBeenLastCalledWith(expect.any(Blob), 'hash-201');
  });
});
