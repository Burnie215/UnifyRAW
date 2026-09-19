import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImmichSource, normalizeImmichBaseUrl } from './ImmichSource';
import { ImmichV3Source } from './ImmichV3Source';
import { countAlbumsWithoutName, IncompleteListingError } from './IncompleteListingError';
import type { PhotoRef } from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Immich base URL normalization', () => {
  it.each([
    ['https://photos.example.test', 'https://photos.example.test'],
    ['https://photos.example.test/', 'https://photos.example.test'],
    ['https://photos.example.test/api', 'https://photos.example.test'],
    ['https://photos.example.test/api///', 'https://photos.example.test'],
    [' https://photos.example.test/immich/api/ ', 'https://photos.example.test/immich'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeImmichBaseUrl(input)).toBe(expected);
  });

  it.each([
    ['Immich v2', (serverUrl: string) => new ImmichSource('source', 'Immich', {
      serverUrl,
      apiKey: 'secret',
      transport: 'browser-direct',
    })],
    ['Immich v3', (serverUrl: string) => new ImmichV3Source('source', 'Immich', {
      serverUrl,
      apiKey: 'secret',
      transport: 'browser-direct',
    })],
  ])('%s appends the API prefix exactly once', async (_name, createSource) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const source = createSource('https://photos.example.test/api/');

    await expect(source.connect()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example.test/api/server/ping',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

describe('Immich thumbnail request deduplication', () => {
  it('shares the response while giving concurrent consumers independent URLs', async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal('fetch', fetchMock);
    const source = new ImmichSource('source', 'Immich', {
      serverUrl: 'https://photos.example.test',
      apiKey: 'secret',
      transport: 'browser-direct',
    });

    const first = source.getThumbnailUrl({ sourceId: 'source', sourcePhotoId: 'asset-1', name: 'one.jpg' });
    const second = source.getThumbnailUrl({ sourceId: 'source', sourcePhotoId: 'asset-1', name: 'one.jpg' });
    release(new Response(new Blob(['thumbnail'], { type: 'image/jpeg' })));

    const urls = await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urls[0]).toMatch(/^blob:/);
    expect(urls[1]).toMatch(/^blob:/);
    expect(urls[0]).not.toBe(urls[1]);
    for (const url of urls) if (url) URL.revokeObjectURL(url);
  });

  it('aborts an owned thumbnail request that is already in flight', async () => {
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
    const source = new ImmichSource('source', 'Immich', {
      serverUrl: 'https://photos.example.test',
      apiKey: 'secret',
      transport: 'browser-direct',
    });
    const controller = new AbortController();

    const result = source.getThumbnailUrl(
      { sourceId: 'source', sourcePhotoId: 'asset-1', name: 'one.jpg' },
      controller.signal,
    );
    await started;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example.test/api/assets/asset-1/thumbnail?size=thumbnail',
      expect.objectContaining({ signal: controller.signal }),
    );
    controller.abort();

    await expect(result).resolves.toBeNull();
  });
});

describe('Immich delete reports the caller ids back', () => {
  const refs = [
    { sourceId: 'source', sourcePhotoId: 'Albums/Urlaub/asset-1', name: 'IMG_1.jpg' },
    { sourceId: 'source', sourcePhotoId: 'Albums/Urlaub/asset-2', name: 'IMG_2.jpg' },
  ];

  const sources = [
    ['Immich v2', () => new ImmichSource('source', 'Immich', {
      serverUrl: 'https://photos.example.test',
      apiKey: 'secret',
      transport: 'browser-direct',
    })],
    ['Immich v3', () => new ImmichV3Source('source', 'Immich', {
      serverUrl: 'https://photos.example.test',
      apiKey: 'secret',
      transport: 'browser-direct',
    })],
  ] as const;

  it.each(sources)('%s: batch delete answers with the full sourcePhotoIds', async (_name, createSource) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createSource().deletePhotos!(refs);

    expect(result.succeededIds).toEqual(['Albums/Urlaub/asset-1', 'Albums/Urlaub/asset-2']);
    expect(result.failed).toEqual([]);
    // The wire still carries the bare Immich asset ids.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.ids).toEqual(['asset-1', 'asset-2']);
  });

  it.each(sources)('%s: per-id fallback maps each answer back to its ref', async (_name, createSource) => {
    // First call is the batch attempt and fails; the per-id retries then decide.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"message":"Bad Request"}', { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response('{"message":"Internal Server Error"}', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await createSource().deletePhotos!(refs);

    expect(result.succeededIds).toEqual(['Albums/Urlaub/asset-1']);
    expect(result.failed.map((f) => f.sourcePhotoId)).toEqual(['Albums/Urlaub/asset-2']);
  });
});

describe('Immich listing abort', () => {
  const createSource = () => new ImmichSource('source', 'Immich', {
    serverUrl: 'https://photos.example.test',
    apiKey: 'secret',
    transport: 'browser-direct',
  });

  function json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  function stubImmich(onAlbums: () => void = () => {}) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/albums')) { onAlbums(); return json([{ id: 'album-1', albumName: 'Urlaub' }]); }
      if (url.endsWith('/api/albums/album-1')) return json({ assets: [{ id: 'asset-1' }] });
      return json({ assets: { items: [{ id: 'asset-1', originalFileName: 'IMG_1.jpg' }], total: 1 } });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('hands the listing signal to the request', async () => {
    const fetchMock = stubImmich();
    const controller = new AbortController();

    await createSource().listPhotosPage(2, 10, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example.test/api/search/metadata',
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('does not keep an album map cut short by the abort', async () => {
    const controller = new AbortController();
    stubImmich(() => controller.abort());
    const source = createSource();

    await expect(source.listPhotosPage(1, 10, controller.signal)).resolves.toBeNull();

    stubImmich();
    const page = await source.listPhotosPage(1, 10);
    // Without the reset the empty map stays cached and the photo lands in
    // 'Alle Fotos/' - a different sourcePhotoId for the same asset.
    expect(page?.photos.map((photo) => photo.sourcePhotoId)).toEqual(['Albums/Urlaub/asset-1']);
  });
});

describe('Immich album map after a server failure', () => {
  const createSource = () => new ImmichSource('source', 'Immich', {
    serverUrl: 'https://photos.example.test',
    apiKey: 'secret',
    transport: 'browser-direct',
  });

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  function stubImmich({ list = 200, detail = 200 }: { list?: number; detail?: number } = {}) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/albums')) return json([{ id: 'album-1', albumName: 'Urlaub' }], list);
      if (url.endsWith('/api/albums/album-1')) return json({ assets: [{ id: 'asset-1' }] }, detail);
      return json({ assets: { items: [{ id: 'asset-1', originalFileName: 'IMG_1.jpg' }], total: 1 } });
    }));
  }

  const idsOf = (page: { photos: { sourcePhotoId: string }[] } | null) => page?.photos.map((p) => p.sourcePhotoId);

  it.each([
    ['the album list', { list: 500 }],
    ['an album detail', { detail: 500 }],
  ])('answers no page and caches nothing when %s fails', async (_what, failure) => {
    const source = createSource();
    stubImmich(failure);
    await expect(source.listPhotosPage(1, 10)).resolves.toBeNull();

    stubImmich();
    // Cached as "no albums", the asset would come back as 'Alle Fotos/asset-1':
    // a second catalog row for the same photo.
    expect(idsOf(await source.listPhotosPage(1, 10))).toEqual(['Albums/Urlaub/asset-1']);
  });

  it('skips an album deleted between the list and its detail request', async () => {
    const source = createSource();
    stubImmich({ detail: 404 });
    expect(idsOf(await source.listPhotosPage(1, 10))).toEqual(['Alle Fotos/asset-1']);
  });
});

describe('Immich listing with a failing request', () => {
  const config = { serverUrl: 'https://photos.example.test', apiKey: 'secret', transport: 'browser-direct' as const };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  const assets = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, type: 'IMAGE', originalFileName: `${prefix}${i}.jpg` }));

  /** No albums; the metadata search answers `pages[page - 1]`, which may be an HTTP status. */
  function stubSearch(pages: Array<unknown[] | number>, onPage: (page: number) => void = () => {}) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/albums')) return json([]);
      const { page } = JSON.parse(String(init?.body)) as { page: number };
      onPage(page);
      // Like fetch itself: an aborted request rejects.
      init?.signal?.throwIfAborted();
      const answer = pages[page - 1] ?? [];
      return typeof answer === 'number' ? json({}, answer) : json({ assets: { items: answer } });
    }));
  }

  async function list(listing: AsyncIterable<PhotoRef>) {
    const ids: string[] = [];
    let error: unknown = null;
    try {
      for await (const ref of listing) ids.push(ref.sourcePhotoId);
    } catch (e) {
      error = e;
    }
    return { ids, error };
  }

  it('ends a healthy paged listing without complaint', async () => {
    stubSearch([assets('a', 200), assets('b', 3)]);
    const { ids, error } = await list(new ImmichSource('source', 'Immich', config).listPhotos());
    expect(ids).toHaveLength(203);
    expect(error).toBeNull();
  });

  it('keeps the pages before a failed one and then reports the listing incomplete', async () => {
    stubSearch([assets('a', 200), 500, assets('c', 3)]);
    const { ids, error } = await list(new ImmichSource('source', 'Immich', config).listPhotos());
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('Alle Fotos/a0');
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).reasons).toEqual(['page 2']);
  });

  it('ends an aborted listing quietly, as before', async () => {
    const controller = new AbortController();
    stubSearch([assets('a', 200), assets('b', 3)], (page) => {
      if (page === 2) controller.abort();
    });
    const { ids, error } = await list(new ImmichSource('source', 'Immich', config).listPhotos(undefined, controller.signal));
    expect(ids).toHaveLength(200);
    expect(error).toBeNull();
  });

  it('v2 album filter: lists the albums that answer and reports the one that did not', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/albums/al-1')) return json({ message: 'boom' }, 500);
      if (url.endsWith('/api/albums/al-2')) return json({ albumName: 'Trip', assets: assets('t', 2) });
      throw new Error(`unexpected request ${url}`);
    }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const source = new ImmichSource('source', 'Immich', { ...config, albumIds: ['al-1', 'al-2'] });
    const { ids, error } = await list(source.listPhotos());
    log.mockRestore();
    expect(ids).toEqual(['Albums/Trip/t0', 'Albums/Trip/t1']);
    expect(error).toBeInstanceOf(IncompleteListingError);
  });

  it('v3 album filter: skips an album whose name did not answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/albums/al-1')) return json({ message: 'boom' }, 500);
      if (url.endsWith('/api/albums/al-2')) return json({ albumName: 'Trip' });
      const { albumIds } = JSON.parse(String(init?.body)) as { albumIds: string[] };
      return json({ assets: { items: assets(albumIds[0] === 'al-1' ? 'x' : 't', 2), nextPage: null } });
    }));
    const source = new ImmichV3Source('source', 'Immich', { ...config, albumIds: ['al-1', 'al-2'] });
    const { ids, error } = await list(source.listPhotos());
    // Under the placeholder name the al-1 photos arrived as 'Albums/Album/x0':
    // second rows for photos the catalog already holds under their real album.
    expect(ids).toEqual(['Albums/Trip/t0', 'Albums/Trip/t1']);
    expect(error).toBeInstanceOf(IncompleteListingError);
  });

  it('v3 album filter: keeps the pages before a failed album search and reports it', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/albums/al-1')) return json({ albumName: 'Trip' });
      const { page } = JSON.parse(String(init?.body)) as { page: number };
      if (page === 1) return json({ assets: { items: assets('t', 2), nextPage: '2' } });
      return json({}, 502);
    }));
    const source = new ImmichV3Source('source', 'Immich', { ...config, albumIds: ['al-1'] });
    const { ids, error } = await list(source.listPhotos());
    expect(ids).toEqual(['Albums/Trip/t0', 'Albums/Trip/t1']);
    expect(error).toBeInstanceOf(IncompleteListingError);
  });
});

describe('Immich v3 album map after a failed member search', () => {
  const config = { serverUrl: 'https://photos.example.test', apiKey: 'secret', transport: 'browser-direct' as const };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * One album 'Urlaub' holding a0. `members` answers the album's member
   * search per page; the unfiltered search always returns a0 itself.
   */
  function stubImmichV3(members: (page: number) => Response) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/albums')) return json([{ id: 'al-1', albumName: 'Urlaub' }]);
      const body = JSON.parse(String(init?.body)) as { albumIds?: string[]; page: number };
      if (body.albumIds) return members(body.page);
      return json({ assets: { items: [{ id: 'a0', originalFileName: 'a0.jpg' }], nextPage: null } });
    }));
  }

  const truncated = (page: number) => (page === 1
    ? json({ assets: { items: [{ id: 'a0' }], nextPage: '2' } })
    : json({}, 502));
  const complete = () => json({ assets: { items: [{ id: 'a0' }], nextPage: null } });

  it('getAlbums throws instead of reporting a shorter album', async () => {
    stubImmichV3(truncated);
    await expect(new ImmichV3Source('source', 'Immich', config).getAlbums()).rejects.toThrow('al-1');
  });

  it('answers no page and caches nothing, so the asset keeps its album id', async () => {
    const source = new ImmichV3Source('source', 'Immich', config);
    stubImmichV3(truncated);
    await expect(source.listPhotosPage(1, 10)).resolves.toBeNull();

    stubImmichV3(complete);
    // With the truncated album cached, a0 would come back as 'Alle Fotos/a0':
    // a second catalog row for the same photo.
    const page = await source.listPhotosPage(1, 10);
    expect(page?.photos.map((photo) => photo.sourcePhotoId)).toEqual(['Albums/Urlaub/a0']);
  });
});

describe('Immich v3 paging a library the server filtered', () => {
  const config = { serverUrl: 'https://photos.example.test', apiKey: 'secret', transport: 'browser-direct' as const };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * No albums. Page 1 is SHORT - the server dropped this page's videos behind
   * the `type: 'IMAGE'` filter - but announces a next page; page 2 ends the
   * walk. A page length is therefore no end-of-list signal here.
   */
  function stubShortFirstPage() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/albums')) return json([]);
      const { page } = JSON.parse(String(init?.body)) as { page: number };
      const items = page === 1
        ? [{ id: 'a0', originalFileName: 'a0.jpg' }]
        : [{ id: 'b0', originalFileName: 'b0.jpg' }, { id: 'b1', originalFileName: 'b1.jpg' }];
      return json({ assets: { items, nextPage: page === 1 ? '2' : null, total: 3 } });
    }));
  }

  it('reports more pages when the server announced one', async () => {
    stubShortFirstPage();
    const page = await new ImmichV3Source('source', 'Immich', config).listPhotosPage(1, 200);
    expect(page?.photos.map((photo) => photo.sourcePhotoId)).toEqual(['Alle Fotos/a0']);
    expect(page?.hasMore).toBe(true);
  });

  it('walks past the short page instead of ending the listing there', async () => {
    stubShortFirstPage();
    const ids: string[] = [];
    for await (const ref of new ImmichV3Source('source', 'Immich', config).listPhotos()) {
      ids.push(ref.sourcePhotoId);
    }
    expect(ids).toEqual(['Alle Fotos/a0', 'Alle Fotos/b0', 'Alle Fotos/b1']);
  });
});

describe('Immich album filter with a nameless answer', () => {
  const config = { serverUrl: 'https://photos.example.test', apiKey: 'secret', transport: 'browser-direct' as const };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  const assets = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i}`, type: 'IMAGE', originalFileName: `${prefix}${i}.jpg` }));

  async function list(listing: AsyncIterable<PhotoRef>) {
    const ids: string[] = [];
    let error: unknown = null;
    try {
      for await (const ref of listing) ids.push(ref.sourcePhotoId);
    } catch (e) {
      error = e;
    }
    return { ids, error };
  }

  // Under the 'Album' placeholder these photos arrived as 'Albums/Album/<id>':
  // second rows next to the ones the catalog holds under the real album name,
  // and every nameless album shared that one folder.
  it('v2: skips the albums whose answer carried no usable name', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/albums/al-1')) return json({ assets: assets('x', 2) });
      if (url.endsWith('/api/albums/al-2')) return json({ albumName: '', assets: assets('e', 1) });
      if (url.endsWith('/api/albums/al-3')) return json({ albumName: 'Trip', assets: assets('t', 2) });
      throw new Error(`unexpected request ${url}`);
    }));
    const source = new ImmichSource('source', 'Immich', { ...config, albumIds: ['al-1', 'al-2', 'al-3'] });

    const { ids, error } = await list(source.listPhotos());

    expect(ids).toEqual(['Albums/Trip/t0', 'Albums/Trip/t1']);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).reasons).toEqual(['album al-1: no name', 'album al-2: no name']);
    // The same count the unfiltered path reports, so both paths say the same
    // thing to the user about the same server.
    expect(countAlbumsWithoutName((error as IncompleteListingError).skips)).toBe(2);
  });

  it('v3: skips the album whose answer carried no name and never searches it', async () => {
    const searched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/albums/al-1')) return json({ id: 'al-1' });
      if (url.endsWith('/api/albums/al-2')) return json({ albumName: 'Trip' });
      const { albumIds } = JSON.parse(String(init?.body)) as { albumIds: string[] };
      searched.push(albumIds[0]);
      return json({ assets: { items: assets('t', 2), nextPage: null } });
    }));
    const source = new ImmichV3Source('source', 'Immich', { ...config, albumIds: ['al-1', 'al-2'] });

    const { ids, error } = await list(source.listPhotos());

    expect(ids).toEqual(['Albums/Trip/t0', 'Albums/Trip/t1']);
    expect(searched).toEqual(['al-2']);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).reasons).toEqual(['album al-1: no name']);
    expect(countAlbumsWithoutName((error as IncompleteListingError).skips)).toBe(1);
  });
});

describe('Immich v2 paging a library the server filtered', () => {
  const config = { serverUrl: 'https://photos.example.test', apiKey: 'secret', transport: 'browser-direct' as const };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * No albums. Page 1 is SHORT - the server dropped this page's videos behind
   * the `type: 'IMAGE'` filter - but announces a next page; page 2 ends the
   * walk. v2 sends that same server-side filter, so a page length is no
   * end-of-list signal here either.
   */
  function stubShortFirstPage() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/albums')) return json([]);
      const { page } = JSON.parse(String(init?.body)) as { page: number };
      const items = page === 1
        ? [{ id: 'a0', originalFileName: 'a0.jpg' }]
        : [{ id: 'b0', originalFileName: 'b0.jpg' }, { id: 'b1', originalFileName: 'b1.jpg' }];
      return json({ assets: { items, nextPage: page === 1 ? '2' : null, total: 3 } });
    }));
  }

  it('reports more pages when the server announced one', async () => {
    stubShortFirstPage();
    const page = await new ImmichSource('source', 'Immich', config).listPhotosPage(1, 200);
    expect(page?.photos.map((photo) => photo.sourcePhotoId)).toEqual(['Alle Fotos/a0']);
    expect(page?.hasMore).toBe(true);
  });

  it('walks past the short page instead of ending the listing there', async () => {
    stubShortFirstPage();
    const ids: string[] = [];
    for await (const ref of new ImmichSource('source', 'Immich', config).listPhotos()) {
      ids.push(ref.sourcePhotoId);
    }
    expect(ids).toEqual(['Alle Fotos/a0', 'Alle Fotos/b0', 'Alle Fotos/b1']);
  });

  it('keeps the page length as the signal when the server reports no nextPage', async () => {
    // Not every 2.x deployment answers with the field. Reading its absence as
    // "no next page" would end the walk after page 1 - complete, and a full
    // refresh would prune the rest of the library.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/api/albums')) return json([]);
      const { page } = JSON.parse(String(init?.body)) as { page: number };
      return json({ assets: { items: page === 1 ? [{ id: 'a0' }, { id: 'a1' }] : [{ id: 'b0' }] } });
    }));
    const source = new ImmichSource('source', 'Immich', config);

    expect((await source.listPhotosPage(1, 2))?.hasMore).toBe(true);
    expect((await source.listPhotosPage(2, 2))?.hasMore).toBe(false);
  });
});

describe('Immich album map with a nameless album', () => {
  const config = { serverUrl: 'https://photos.example.test', apiKey: 'secret', transport: 'browser-direct' as const };

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  async function list(listing: AsyncIterable<PhotoRef>) {
    const ids: string[] = [];
    let error: unknown = null;
    try {
      for await (const ref of listing) ids.push(ref.sourcePhotoId);
    } catch (e) {
      error = e;
    }
    return { ids, error };
  }

  /**
   * GET /api/albums answers with one album that carries no name (holding a0)
   * and one that does (holding b0). The unfiltered search knows both assets.
   */
  function stubV2(requested: string[] = []) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/api/albums')) return json([{ id: 'al-1' }, { id: 'al-2', albumName: 'Urlaub' }]);
      if (url.endsWith('/api/albums/al-1')) return json({ assets: [{ id: 'a0' }] });
      if (url.endsWith('/api/albums/al-2')) return json({ assets: [{ id: 'b0' }] });
      return json({ assets: { items: [{ id: 'a0' }, { id: 'b0' }], nextPage: null } });
    }));
  }

  it('v2: getAlbums skips the album the server named nothing and reports it back', async () => {
    const requested: string[] = [];
    stubV2(requested);

    const answer = await new ImmichSource('source', 'Immich', config).getAlbums();

    expect(answer.albums.map((album) => album.name)).toEqual(['Urlaub']);
    expect(answer.namelessIds).toEqual(['al-1']);
    // No folder to build, so the detail request is not worth spending either.
    expect(requested.some((url) => url.endsWith('/api/albums/al-1'))).toBe(false);
  });

  it('v2: lists the whole library, files the nameless album under no folder, and stays incomplete', async () => {
    stubV2();
    const source = new ImmichSource('source', 'Immich', config);

    // Before, one album without a name answered NO page at all: the source
    // listed nothing, and the fabricated 'Albums/undefined/a0' it replaced was
    // no better. a0 now arrives with no album folder of its own.
    const page = await source.listPhotosPage(1, 200);
    expect(page?.photos.map((photo) => photo.sourcePhotoId)).toEqual(['Alle Fotos/a0', 'Albums/Urlaub/b0']);
    expect(page?.skipped).toEqual([{ kind: 'album-without-name', detail: 'album al-1: no name' }]);

    const { ids, error } = await list(source.listPhotos());
    expect(ids).toEqual(['Alle Fotos/a0', 'Albums/Urlaub/b0']);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect(countAlbumsWithoutName((error as IncompleteListingError).skips)).toBe(1);
  });

  /** The v3 shape: album members come from a filtered search, not from a detail. */
  function stubV3(searched: string[] = []) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/albums')) return json([{ id: 'al-1' }, { id: 'al-2', albumName: 'Urlaub' }]);
      const { albumIds } = JSON.parse(String(init?.body)) as { albumIds?: string[] };
      if (albumIds) {
        searched.push(albumIds[0]);
        return json({ assets: { items: [{ id: 'b0' }], nextPage: null } });
      }
      return json({ assets: { items: [{ id: 'a0' }, { id: 'b0' }], nextPage: null } });
    }));
  }

  it('v3: skips the nameless album before spending a member search on it', async () => {
    const searched: string[] = [];
    stubV3(searched);

    const answer = await new ImmichV3Source('source', 'Immich', config).getAlbums();

    expect(answer.albums.map((album) => album.id)).toEqual(['al-2']);
    expect(answer.namelessIds).toEqual(['al-1']);
    expect(searched).toEqual(['al-2']);
  });

  it('v3: lists the whole library, files the nameless album under no folder, and stays incomplete', async () => {
    stubV3();
    const source = new ImmichV3Source('source', 'Immich', config);

    const { ids, error } = await list(source.listPhotos());

    expect(ids).toEqual(['Alle Fotos/a0', 'Albums/Urlaub/b0']);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect(countAlbumsWithoutName((error as IncompleteListingError).skips)).toBe(1);
  });
});

describe('Immich export uses the verbs the server documents', () => {
  const config = { serverUrl: 'https://photos.example.test', apiKey: 'secret', transport: 'browser-direct' as const };

  const sources = [
    ['Immich v2', () => new ImmichSource('source', 'Immich', config)],
    ['Immich v3', () => new ImmichV3Source('source', 'Immich', config)],
  ] as const;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }

  /** Upload answers with a fresh asset; v3's filename pre-check finds nothing. */
  function stubUpload() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/search/metadata')) return json({ assets: { items: [], nextPage: null } });
      if (url.endsWith('/api/assets')) return json({ id: 'new', status: 'created' });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const input = {
    original: { sourceId: 'source', sourcePhotoId: 'Alle Fotos/asset-1', name: 'IMG_1.jpg' },
    renderedBlob: new Blob(['bytes'], { type: 'image/jpeg' }),
    format: 'jpg' as const,
    filename: 'IMG_1_edit.jpg',
    editStackHash: 'a'.repeat(64),
  };

  it.each(sources)('%s: returns a classified upload error', async (_name, createSource) => {
    vi.stubGlobal('fetch', vi.fn(async (input2: RequestInfo | URL) => {
      const url = String(input2);
      if (url.endsWith('/api/search/metadata')) return json({ assets: { items: [], nextPage: null } });
      if (url.endsWith('/api/assets')) return new Response('too large', { status: 413 });
      throw new Error(`unexpected request ${url}`);
    }));

    await expect(createSource().exportAsset(input)).rejects.toMatchObject({
      name: 'ExportError',
      code: 'too-large',
      status: 413,
    });
  });

  it.each(sources)('%s: returns a network error when the upload cannot be sent', async (_name, createSource) => {
    vi.stubGlobal('fetch', vi.fn(async (input2: RequestInfo | URL) => {
      if (String(input2).endsWith('/api/search/metadata')) return json({ assets: { items: [], nextPage: null } });
      throw new TypeError('connection lost');
    }));

    await expect(createSource().exportAsset(input)).rejects.toMatchObject({
      name: 'ExportError',
      code: 'network',
    });
  });

  it.each(sources)('%s: stacks the export under the original via POST /stacks', async (_name, createSource) => {
    const fetchMock = stubUpload();

    await expect(createSource().exportAsset(input)).resolves.toMatchObject({ assetId: 'new' });

    // 2.7.5's AssetBulkUpdateDto carries no stack-parent field and PUT /assets
    // answers 204 regardless, so the old call looked fine and stacked nothing.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example.test/api/stacks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ assetIds: ['asset-1', 'new'] }),
      }),
    );
  });

  it.each(sources)('%s: adds assets to an album via PUT', async (_name, createSource) => {
    const fetchMock = vi.fn(async () => json([{ id: 'asset-1', success: true }]));
    vi.stubGlobal('fetch', fetchMock);

    const refs: PhotoRef[] = [{ sourceId: 'source', sourcePhotoId: 'Albums/Urlaub/asset-1', name: 'IMG_1.jpg' }];
    await expect(createSource().addToAlbum('al-1', refs)).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example.test/api/albums/al-1/assets',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ ids: ['asset-1'] }) }),
    );
  });

  it.each(sources)('%s: reports a refused stack instead of passing it off as done', async (_name, createSource) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (input2: RequestInfo | URL) => {
      const url = String(input2);
      if (url.endsWith('/api/search/metadata')) return json({ assets: { items: [], nextPage: null } });
      if (url.endsWith('/api/stacks')) return json({ message: 'Not found' }, 404);
      return json({ id: 'new', status: 'created' });
    }));

    // The upload itself still counts: the asset is on the server either way.
    await expect(createSource().exportAsset(input)).resolves.toMatchObject({ assetId: 'new' });
    expect(warn).toHaveBeenCalledWith('[Immich] stack failed: HTTP 404');
    warn.mockRestore();
  });

  it.each(sources)('%s: does not stack a duplicate upload', async (_name, createSource) => {
    const fetchMock = vi.fn(async (input2: RequestInfo | URL) => {
      const url = String(input2);
      if (url.endsWith('/api/search/metadata')) return json({ assets: { items: [], nextPage: null } });
      return json({ id: 'asset-1', status: 'duplicate' });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSource().exportAsset(input)).resolves.toMatchObject({ alreadyExisted: true });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain('https://photos.example.test/api/stacks');
  });

  it.each(sources)('%s: places the export in the original asset\'s first album', async (_name, createSource) => {
    const fetchMock = vi.fn(async (input2: RequestInfo | URL) => {
      const url = String(input2);
      if (url.endsWith('/api/search/metadata')) return json({ assets: { items: [], nextPage: null } });
      if (url.endsWith('/api/assets')) return json({ id: 'new', status: 'created' });
      if (url.endsWith('/api/albums?assetId=asset-1')) return json([{ id: 'album-original' }, { id: 'album-other' }]);
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSource().exportAsset(input)).resolves.toMatchObject({ assetId: 'new' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example.test/api/albums?assetId=asset-1',
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example.test/api/albums/album-original/assets',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ ids: ['new'] }) }),
    );
  });

  it.each(sources)('%s: keeps an export successful when the original has no album', async (_name, createSource) => {
    const fetchMock = vi.fn(async (input2: RequestInfo | URL) => {
      const url = String(input2);
      if (url.endsWith('/api/search/metadata')) return json({ assets: { items: [], nextPage: null } });
      if (url.endsWith('/api/assets')) return json({ id: 'new', status: 'created' });
      if (url.endsWith('/api/albums?assetId=asset-1')) return json([]);
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(createSource().exportAsset(input)).resolves.toMatchObject({ assetId: 'new' });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      'https://photos.example.test/api/albums/undefined/assets',
    );
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/albums/'))).toHaveLength(0);
  });

  it.each(sources)('%s: honors an explicit target album without looking up the original', async (_name, createSource) => {
    const fetchMock = stubUpload();

    await expect(createSource().exportAsset({ ...input, targetAlbumId: 'album-chosen' }))
      .resolves.toMatchObject({ assetId: 'new' });

    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      'https://photos.example.test/api/albums?assetId=asset-1',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example.test/api/albums/album-chosen/assets',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ ids: ['new'] }) }),
    );
  });

  it.each(sources)('%s: logs a refused album placement but keeps the upload successful', async (_name, createSource) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (input2: RequestInfo | URL) => {
      const url = String(input2);
      if (url.endsWith('/api/search/metadata')) return json({ assets: { items: [], nextPage: null } });
      if (url.endsWith('/api/assets')) return json({ id: 'new', status: 'created' });
      if (url.endsWith('/api/albums?assetId=asset-1')) return json([{ id: 'album-original' }]);
      if (url.endsWith('/api/albums/album-original/assets')) return json({ message: 'Forbidden' }, 403);
      return json({});
    }));

    await expect(createSource().exportAsset(input)).resolves.toMatchObject({ assetId: 'new' });
    expect(warn).toHaveBeenCalledWith('[Immich] album placement failed: album-original');
    warn.mockRestore();
  });
});

describe('the albums the picker offers', () => {
  const config = {
    serverUrl: 'https://photos.example.test',
    apiKey: 'secret',
    transport: 'browser-direct' as const,
  };

  // The picker sees the same server condition the listing sees, so it must not
  // paper over it: no name from the server means no name in the row, and the
  // row says "without a name" rather than showing the word 'undefined'.
  it.each([
    ['v2', () => new ImmichSource('source', 'Immich', config)],
    ['v3', () => new ImmichV3Source('source', 'Immich', config)],
  ] as const)('%s: gives an album the server named nothing an empty name', async (_name, create) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { id: 'al-1', assetCount: 4 },
      { id: 'al-2', albumName: '', assetCount: 1 },
      { id: 'al-3', albumName: 'Urlaub', assetCount: 2 },
    ]), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    await expect(create().listAlbumsOrFolders()).resolves.toEqual([
      { id: 'al-1', name: '', type: 'album', photoCount: 4 },
      { id: 'al-2', name: '', type: 'album', photoCount: 1 },
      { id: 'al-3', name: 'Urlaub', type: 'album', photoCount: 2 },
    ]);
  });
});
