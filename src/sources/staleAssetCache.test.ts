import { afterEach, describe, expect, it, vi } from 'vitest';
import { dedupeFetch, dedupeObjectUrlFetch } from './staleAssetCache';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dedupeObjectUrlFetch', () => {
  it('shares the fetch while giving concurrent consumers independent URLs', async () => {
    let release!: (blob: Blob) => void;
    const fetched = new Promise<Blob>((resolve) => { release = resolve; });
    const fetcher = vi.fn(() => fetched);
    const created = vi.spyOn(URL, 'createObjectURL');

    const first = dedupeObjectUrlFetch('source', 'photo', 'thumb', fetcher);
    const second = dedupeObjectUrlFetch('source', 'photo', 'thumb', fetcher);
    release(new Blob(['thumbnail'], { type: 'image/jpeg' }));

    const urls = await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledTimes(2);
    expect(urls[0]).not.toBe(urls[1]);

    for (const url of urls) if (url) URL.revokeObjectURL(url);
  });

  it('does not attach a signalled read to an unowned shared request', async () => {
    const fetcher = vi.fn(async () => new Blob(['thumbnail']));
    const controller = new AbortController();

    const urls = await Promise.all([
      dedupeObjectUrlFetch('source', 'photo', 'thumb', fetcher),
      dedupeObjectUrlFetch('source', 'photo', 'thumb', fetcher, controller.signal),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const url of urls) if (url) URL.revokeObjectURL(url);
  });
});

describe('dedupeFetch cancellation ownership', () => {
  it('does not attach a signalled read to an unowned shared request', async () => {
    const fetcher = vi.fn(async () => new Blob(['original']));
    const controller = new AbortController();

    await Promise.all([
      dedupeFetch('source', 'photo', 'file', fetcher),
      dedupeFetch('source', 'photo', 'file', fetcher, controller.signal),
    ]);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
