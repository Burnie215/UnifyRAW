import { afterEach, describe, expect, it, vi } from 'vitest';
import { LycheeSource } from './LycheeSource';
import { IncompleteListingError } from './IncompleteListingError';
import { clearDetectedAssets, clearStaleCache, detectedStaleAssets } from './staleAssetCache';

const BASE = 'https://lychee.example.test';
const THUMB = `${BASE}/uploads/thumb/p1.jpg`;
const ORIGINAL = `${BASE}/uploads/original/p1.jpg`;
const ref = { sourceId: 'lychee', sourcePhotoId: 'p1', name: 'IMG_1.jpg' };

afterEach(() => {
  vi.unstubAllGlobals();
  clearStaleCache();
  clearDetectedAssets();
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** A Lychee whose one photo is still listed but whose files answer `variantStatus`. */
function stubLychee(variantStatus: number) {
  const variantCalls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/api/v2/Albums')) return json({ albums: [] });
    if (url.includes('Album::photos')) {
      return json({
        photos: [{ id: 'p1', title: 'IMG_1.jpg', size_variants: { thumb: { url: THUMB }, original: { url: ORIGINAL } } }],
        current_page: 1,
        last_page: 1,
      });
    }
    variantCalls.push(url);
    return new Response('missing', { status: variantStatus });
  }));
  return variantCalls;
}

const createSource = () => new LycheeSource('lychee', 'Lychee', {
  serverUrl: BASE,
  apiToken: 'token',
  transport: 'browser-direct',
});

describe('Lychee negative cache', () => {
  it('gives concurrent thumbnail consumers independently revocable URLs', async () => {
    const variantCalls = stubLychee(200);
    const source = createSource();

    const [first, second] = await Promise.all([
      source.getThumbnailUrl(ref),
      source.getThumbnailUrl(ref),
    ]);

    expect(variantCalls).toEqual([THUMB]);
    expect(first).toMatch(/^blob:/);
    expect(second).toMatch(/^blob:/);
    expect(first).not.toBe(second);
    if (first) URL.revokeObjectURL(first);
    if (second) URL.revokeObjectURL(second);
  });

  it('aborts an owned thumbnail request that is already in flight', async () => {
    stubLychee(200);
    const source = createSource();
    for await (const photo of source.listPhotos()) void photo;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        requestStarted();
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        }, { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    const result = source.getThumbnailUrl(ref, controller.signal);
    await started;
    expect(fetchMock).toHaveBeenCalledWith(
      THUMB,
      expect.objectContaining({ signal: controller.signal }),
    );
    controller.abort();

    await expect(result).resolves.toBeNull();
  });

  it('stops asking for a photo Lychee answered 404 for, across all three kinds of request', async () => {
    const variantCalls = stubLychee(404);
    const source = createSource();

    await expect(source.getThumbnailUrl(ref)).resolves.toBeNull();
    await expect(source.getThumbnailUrl(ref)).resolves.toBeNull();
    await expect(source.getFile(ref)).resolves.toBeNull();
    await expect(source.getDisplayUrl(ref)).rejects.toThrow('previously reported missing');

    expect(variantCalls).toEqual([THUMB]);
    expect(detectedStaleAssets()).toEqual([{ sourceId: 'lychee', sourcePhotoId: 'p1' }]);
  });

  it('keeps asking after a server error, which is not a deleted photo', async () => {
    const variantCalls = stubLychee(500);
    const source = createSource();

    await expect(source.getThumbnailUrl(ref)).resolves.toBeNull();
    await expect(source.getThumbnailUrl(ref)).resolves.toBeNull();

    expect(variantCalls).toEqual([THUMB, THUMB]);
    expect(detectedStaleAssets()).toEqual([]);
  });
});

describe('Lychee listing with a failing request', () => {
  const photo = (id: string) => ({ id, title: `${id}.jpg` });
  const page = (photos: unknown[], current: number, last: number) => json({ photos, current_page: current, last_page: last });

  /** Two albums; A1 spans two pages. `failing` answers 500 for URLs that contain it. */
  function stubAlbums(failing?: string) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (failing && url.includes(failing)) return new Response('error', { status: 500 });
      if (url.endsWith('/api/v2/Albums')) return json({ albums: [{ id: 'A1', title: 'A' }, { id: 'A2', title: 'B' }] });
      if (url.includes('Album::albums')) return json({ data: [], current_page: 1, last_page: 1 });
      if (url.includes('album_id=A1&page=1')) return page([photo('p1')], 1, 2);
      if (url.includes('album_id=A1&page=2')) return page([photo('p2')], 2, 2);
      if (url.includes('album_id=A2&page=1')) return page([photo('p3')], 1, 1);
      if (url.includes('album_id=unsorted&page=1')) return page([photo('p4')], 1, 1);
      throw new Error(`unexpected request ${url}`);
    }));
  }

  async function list() {
    const ids: string[] = [];
    let error: unknown = null;
    try {
      for await (const ref of createSource().listPhotos()) ids.push(ref.sourcePhotoId);
    } catch (e) {
      error = e;
    }
    return { ids, error };
  }

  it('lists every album of a healthy server without complaint', async () => {
    stubAlbums();
    await expect(list()).resolves.toEqual({ ids: ['p1', 'p2', 'p3', 'p4'], error: null });
  });

  it('keeps listing past a failed page and then reports the listing incomplete', async () => {
    stubAlbums('album_id=A1&page=2');
    const { ids, error } = await list();
    expect(ids).toEqual(['p1', 'p3', 'p4']);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).reasons).toEqual([expect.stringContaining('album_id=A1&page=2')]);
  });

  it('reports a failed album tree, which otherwise looks like a library without albums', async () => {
    stubAlbums('/api/v2/Albums');
    const { ids, error } = await list();
    expect(ids).toEqual(['p4']);
    expect(error).toBeInstanceOf(IncompleteListingError);
  });
});

describe('Lychee export errors', () => {
  const exportInput = {
    original: ref,
    renderedBlob: new Blob(['bytes'], { type: 'image/jpeg' }),
    format: 'jpg' as const,
    filename: 'IMG_1_edit.jpg',
    editStackHash: 'a'.repeat(64),
  };

  function stubExport(upload: () => Promise<Response>) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/v2/Albums')) return json({ albums: [] });
      if (url.includes('Album::photos')) {
        return json({
          photos: [{ id: 'p1', title: 'IMG_1.jpg', album_id: null }],
          current_page: 1,
          last_page: 1,
        });
      }
      if (url.endsWith('/api/v2/Photo')) return upload();
      throw new Error(`unexpected request ${url}`);
    }));
  }

  it('returns a classified upload error', async () => {
    stubExport(async () => new Response('quota', { status: 507 }));
    await expect(createSource().exportAsset(exportInput)).rejects.toMatchObject({
      name: 'ExportError',
      code: 'quota',
      status: 507,
    });
  });

  it('returns a network error when the upload cannot be sent', async () => {
    stubExport(async () => { throw new TypeError('connection lost'); });
    await expect(createSource().exportAsset(exportInput)).rejects.toMatchObject({
      name: 'ExportError',
      code: 'network',
    });
  });
});
