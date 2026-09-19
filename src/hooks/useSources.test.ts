import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhotoRow } from '../storage/repos';
import { PhotoRepository } from '../storage/repos';
import { MemoryStorage } from '../storage/MemoryStorage';
import type { PhotoRef } from '../sources/types';
import { countAlbumsWithoutName, IncompleteListingError } from '../sources/IncompleteListingError';
import { ImmichSource } from '../sources/ImmichSource';
import { ImmichV3Source } from '../sources/ImmichV3Source';
import { hasMoreAfterPage, photosToPrune, planIngest, revivedCount, scanPages, scanSnapshot, walkListing, walkPages } from './useSources';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

function row(id: number, sourcePhotoId: string, deletedAt: number | null = null): PhotoRow {
  return { id, sourcePhotoId, deletedAt } as PhotoRow;
}

describe('photosToPrune', () => {
  const existing = [row(1, 'a'), row(2, 'b'), row(3, 'c')];

  it('drops exactly the rows the source no longer lists', () => {
    expect(photosToPrune(existing, new Set(['a', 'c']), true).map((p) => p.id)).toEqual([2]);
  });

  it('drops nothing when the walk did not finish', () => {
    expect(photosToPrune(existing, new Set(['a']), false)).toEqual([]);
  });

  it('drops nothing when the listing came back empty', () => {
    // A source answering with zero photos is far more likely broken than empty.
    expect(photosToPrune(existing, new Set(), true)).toEqual([]);
  });

  it('does not count a photo the user removed as vanished', () => {
    // The snapshot carries soft-deleted rows so a listing can revive them;
    // a full refresh must not report them as a removal on every run.
    const withRemoved = [row(1, 'a'), row(2, 'b', 1_700_000_000_000)];
    expect(photosToPrune(withRemoved, new Set(['a']), true)).toEqual([]);
  });
});

describe('a full refresh over a generator listing', () => {
  const known = ['a', 'b', 'c', 'd', 'e'].map((id, index) => row(index + 1, id));
  const ref = (sourcePhotoId: string): PhotoRef => ({ sourceId: 's', sourcePhotoId, name: `${sourcePhotoId}.jpg` });

  async function* listing(ids: string[], skippedPart: boolean): AsyncIterable<PhotoRef> {
    for (const id of ids) yield ref(id);
    if (skippedPart) throw new IncompleteListingError('Test', [{ kind: 'other', detail: 'album 2' }]);
  }

  // What refreshSourceFull does with a generator listing.
  async function refresh(source: AsyncIterable<PhotoRef>) {
    const seen = new Set<string>();
    const { complete } = await walkListing(source, (refs) => {
      for (const r of refs) seen.add(r.sourcePhotoId);
    });
    return { seen: [...seen], complete, pruned: photosToPrune(known, seen, complete).map((p) => p.sourcePhotoId) };
  }

  it('prunes nothing when the source skipped a part, and still takes what arrived', async () => {
    await expect(refresh(listing(['a', 'b'], true))).resolves.toEqual({ seen: ['a', 'b'], complete: false, pruned: [] });
  });

  it('prunes the photos a cleanly ended listing no longer returns', async () => {
    await expect(refresh(listing(['a', 'b'], false))).resolves.toEqual({
      seen: ['a', 'b'],
      complete: true,
      pruned: ['c', 'd', 'e'],
    });
  });

  it('hands over full batches on the way', async () => {
    const batches: string[][] = [];
    await walkListing(listing(['a', 'b', 'c'], true), (refs) => batches.push(refs.map((r) => r.sourcePhotoId)), 2);
    expect(batches).toEqual([['a', 'b'], ['c']]);
  });

  it('lets every other error through', async () => {
    async function* broken(): AsyncIterable<PhotoRef> {
      yield ref('a');
      throw new Error('PROPFIND failed for /: 401');
    }
    await expect(walkListing(broken(), () => {})).rejects.toThrow('PROPFIND failed');
  });
});

describe('the hasMore flag after a load-more step', () => {
  it('stores what the page answered', () => {
    expect(hasMoreAfterPage({ s: true }, 's', { hasMore: true })).toEqual({ s: true });
    expect(hasMoreAfterPage({ s: true }, 's', { hasMore: false })).toEqual({ s: false });
  });

  it('clears the flag when there was no page to fetch', () => {
    // A source without listPhotosPage - or one removed meanwhile - answers no
    // page at all. Left armed, its flag keeps a "load more" nothing can serve.
    expect(hasMoreAfterPage({ s: true }, 's', null)).toEqual({ s: false });
  });

  it('leaves the other sources alone', () => {
    expect(hasMoreAfterPage({ a: true, b: true }, 'b', null)).toEqual({ a: true, b: false });
  });
});

describe('planIngest', () => {
  const ref = (sourcePhotoId: string, over: Partial<PhotoRef> = {}): PhotoRef => ({
    sourceId: 'immich-1', sourcePhotoId, name: `${sourcePhotoId}.jpg`, ...over,
  });
  const known = (over: Partial<PhotoRow> = {}): PhotoRow => ({
    id: 7,
    sourceId: 'immich-1',
    sourcePhotoId: 'a',
    contentHash: null,
    name: 'a.jpg',
    mimeType: null,
    sizeBytes: null,
    dateTaken: null,
    dateModified: null,
    sourcePath: null,
    availability: 'online',
    sourceRevision: 0,
    indexedAt: 1_000,
    updatedAt: 1_000,
    deletedAt: null,
    width: null, height: null, sourceBits: null,
    camera: null, lens: null, iso: null, focalLength: null, aperture: null, shutterSpeed: null,
    latitude: null, longitude: null, blurHash: null, stackId: null, stackPosition: null,
    ...over,
  });

  it('inserts a photo the catalog does not know', () => {
    const plan = planIngest('immich-1', [ref('a')], new Map(), 5_000);
    expect(plan.additions.map((p) => p.sourcePhotoId)).toEqual(['a']);
    expect(plan.updates).toEqual([]);
  });

  it('revives a removed photo as an update, never as a second row', () => {
    // Without this the row would be listed as "new", and the insert would hit
    // UNIQUE(sourceId, sourcePhotoId).
    const existing = new Map([['a', known({ deletedAt: 1_700_000_000_000 })]]);

    const plan = planIngest('immich-1', [ref('a')], existing, 5_000);

    expect(plan.additions).toEqual([]);
    expect(plan.updates).toEqual([{ id: 7, patch: { deletedAt: null } }]);
  });

  it('does not write an unchanged removed photo during a background ingest', () => {
    const existing = new Map([['a', known({ deletedAt: 1_700_000_000_000 })]]);

    const plan = planIngest('immich-1', [ref('a')], existing, 5_000, 'preserve-removal');

    expect(plan).toEqual({ additions: [], updates: [] });
  });

  it('updates changed listing fields in the background without reviving the photo', () => {
    const existing = new Map([['a', known({ deletedAt: 1_700_000_000_000 })]]);

    const plan = planIngest(
      'immich-1',
      [ref('a', { name: 'renamed.jpg' })],
      existing,
      5_000,
      'preserve-removal',
    );

    expect(plan).toEqual({ additions: [], updates: [{ id: 7, patch: { name: 'renamed.jpg' } }] });
  });

  it('keeps the id of the revived row, so its collection membership survives', () => {
    const existing = new Map([['a', known({ id: 42, deletedAt: 1 })]]);
    const plan = planIngest('immich-1', [ref('a', { name: 'renamed.jpg' })], existing, 5_000);
    expect(plan.updates).toEqual([{ id: 42, patch: { deletedAt: null, name: 'renamed.jpg' } }]);
  });

  it('leaves a photo that is in the catalog and unchanged alone', () => {
    const existing = new Map([['a', known()]]);
    expect(planIngest('immich-1', [ref('a')], existing, 5_000)).toEqual({ additions: [], updates: [] });
  });

  it('patches only the listing fields that really changed', () => {
    const existing = new Map([['a', known({ sizeBytes: 100 })]]);
    const plan = planIngest('immich-1', [ref('a', { sizeBytes: 200 })], existing, 5_000);
    expect(plan.updates).toEqual([{ id: 7, patch: { sizeBytes: 200 } }]);
  });
});

describe('a rescan over a photo the user removed from the catalog', () => {
  const listedRow = {
    sourceId: 'immich-1',
    sourcePhotoId: 'Alle Fotos/asset-1',
    contentHash: null,
    name: 'IMG_0001.CR3',
    mimeType: null,
    sizeBytes: null,
    dateTaken: null,
    dateModified: null,
    sourcePath: null,
    availability: 'online' as const,
    sourceRevision: 0,
    indexedAt: 1_000,
    width: null, height: null, sourceBits: null,
    camera: null, lens: null, iso: null, focalLength: null, aperture: null, shutterSpeed: null,
    latitude: null, longitude: null, blurHash: null, stackId: null, stackPosition: null,
  };

  it('takes it back into the library under its old id, without a duplicate row', async () => {
    // The whole path a rescan walks: snapshot, plan, write. Before the fix the
    // removed row was missing from the snapshot, so it was planned as an
    // insert and died on UNIQUE(sourceId, sourcePhotoId).
    const storage = await MemoryStorage.create();
    try {
      const photos = new PhotoRepository(storage, () => {});
      const [id] = photos.bulkAdd([listedRow]);
      photos.bulkSoftDelete([id]);
      expect(photos.listRaw({ sourceId: 'immich-1' })).toEqual([]);

      const snapshot = scanSnapshot(photos, 'immich-1');
      const plan = planIngest(
        'immich-1',
        [{ sourceId: 'immich-1', sourcePhotoId: listedRow.sourcePhotoId, name: listedRow.name }],
        snapshot,
        2_000,
      );
      photos.bulkAdd(plan.additions);
      photos.bulkUpdate(plan.updates);

      expect(plan.additions).toEqual([]);
      expect(photos.listRaw({ sourceId: 'immich-1' }).map((row) => row.id)).toEqual([id]);
      expect(photos.count({ sourceId: 'immich-1' })).toBe(1);
    } finally {
      await storage.close();
    }
  });

  it('counts exactly the rows it took back in, and nothing when it took none', async () => {
    // What the refresh toast reports. The count has to be the number of rows
    // the walk really reactivated: a silent revival undoes the user's removal
    // behind their back, and an inflated one claims a removal that never was.
    const storage = await MemoryStorage.create();
    try {
      const photos = new PhotoRepository(storage, () => {});
      const ids = photos.bulkAdd(['asset-1', 'asset-2', 'asset-3'].map(
        (sourcePhotoId) => ({ ...listedRow, sourcePhotoId }),
      ));
      photos.bulkSoftDelete([ids[0], ids[2]]);

      const listing = ['asset-1', 'asset-2', 'asset-3'].map((sourcePhotoId) => ({
        sourceId: 'immich-1', sourcePhotoId, name: listedRow.name,
      }));
      const snapshot = scanSnapshot(photos, 'immich-1');
      expect(revivedCount(planIngest('immich-1', listing, snapshot, 2_000))).toBe(2);

      // Everything is back; a second walk over the same listing revives none.
      photos.bulkRestore([ids[0], ids[2]]);
      const afterwards = scanSnapshot(photos, 'immich-1');
      expect(revivedCount(planIngest('immich-1', listing, afterwards, 3_000))).toBe(0);
    } finally {
      await storage.close();
    }
  });

  it('hands the removed row to the scan snapshot and hides it from the library', async () => {
    const storage = await MemoryStorage.create();
    try {
      const photos = new PhotoRepository(storage, () => {});
      const [id] = photos.bulkAdd([listedRow]);
      photos.bulkSoftDelete([id]);

      expect([...scanSnapshot(photos, 'immich-1').keys()]).toEqual([listedRow.sourcePhotoId]);
      expect(photos.list({ sourceId: 'immich-1' })).toEqual([]);
    } finally {
      await storage.close();
    }
  });
});

describe('a full refresh over a paginated listing', () => {
  const known = ['Alle Fotos/a0', 'Alle Fotos/b0', 'Alle Fotos/b1'].map((id, index) => row(index + 1, id));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Immich without albums, v2 and v3 alike. Page 1 is short - the server
   * dropped this page's videos behind the `type: 'IMAGE'` filter - but
   * announces a next page.
   * A source that reads a short page as the end of the library hands this walk
   * a complete listing, and complete is what lets the refresh prune.
   */
  function stubAShortFirstPage() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      if (String(input).endsWith('/api/albums')) return json([]);
      const { page } = JSON.parse(String(init?.body)) as { page: number };
      const items = page === 1 ? [{ id: 'a0' }] : [{ id: 'b0' }, { id: 'b1' }];
      return json({ assets: { items, nextPage: page === 1 ? '2' : null } });
    }));
  }

  const config = {
    serverUrl: 'https://photos.example.test',
    apiKey: 'secret',
    transport: 'browser-direct' as const,
  };

  // What refreshSourceFull does with a paginated listing: the same walk, and
  // the same rule for when the listing counts as finished.
  async function refresh(source: ImmichSource) {
    const seen = new Set<string>();
    const walk = await walkPages(
      (page, size) => source.listPhotosPage(page, size),
      (page) => { for (const photo of page.photos) seen.add(photo.sourcePhotoId); },
      200,
      5,
    );
    return { seen: [...seen], pruned: photosToPrune(known, seen, walk.complete).map((p) => p.sourcePhotoId) };
  }

  it.each([
    ['v3', () => new ImmichV3Source('source', 'Immich', config)],
    ['v2', () => new ImmichSource('source', 'Immich', config)],
  ] as const)('%s: prunes nothing behind a short page the source paged past', async (_name, create) => {
    stubAShortFirstPage();
    await expect(refresh(create())).resolves.toEqual({
      seen: ['Alle Fotos/a0', 'Alle Fotos/b0', 'Alle Fotos/b1'],
      pruned: [],
    });
  });
});

describe('a full refresh over a library with an album the server named nothing', () => {
  /**
   * The catalog from the last refresh, when al-1 still had the name 'Sommer'.
   * Its rows are exactly the ones a listing without that album cannot see -
   * the rows a walk counted complete would soft-delete.
   */
  const known = ['Alle Fotos/a0', 'Albums/Urlaub/b0', 'Albums/Sommer/c0'].map((id, index) => row(index + 1, id));

  const config = {
    serverUrl: 'https://photos.example.test',
    apiKey: 'secret',
    transport: 'browser-direct' as const,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Two albums: al-1 without a name (it holds a0), 'Urlaub' with one (b0).
   * v2 reads an album's members from its detail, v3 from a filtered search.
   * The nameless album must cost no request at all - if one arrives, the walk
   * answers no page and the expectations below fail loudly.
   */
  function stubOneNamelessAlbum() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      const url = String(input);
      if (url.endsWith('/api/albums')) return json([{ id: 'al-1' }, { id: 'al-2', albumName: 'Urlaub' }]);
      if (url.endsWith('/api/albums/al-1')) throw new Error('the nameless album was requested');
      if (url.endsWith('/api/albums/al-2')) return json({ assets: [{ id: 'b0' }] });
      const { albumIds } = JSON.parse(String(init?.body)) as { albumIds?: string[] };
      if (albumIds) return json({ assets: { items: [{ id: 'b0' }], nextPage: null } });
      return json({ assets: { items: [{ id: 'a0' }, { id: 'b0' }], nextPage: null } });
    }));
  }

  // What refreshSourceFull does: the walk's own answer says whether a page is
  // left over, and only a walk that ALSO skipped nothing may prune.
  async function refresh(source: ImmichSource) {
    const seen = new Set<string>();
    const walk = await walkPages(
      (page, size) => source.listPhotosPage(page, size),
      (page) => { for (const photo of page.photos) seen.add(photo.sourcePhotoId); },
      200,
      5,
    );
    const whole = walk.complete && walk.skipped.length === 0;
    return {
      seen: [...seen],
      complete: whole,
      pruned: photosToPrune(known, seen, whole).map((p) => p.sourcePhotoId),
      namelessAlbums: countAlbumsWithoutName(walk.skipped),
    };
  }

  it.each([
    ['v2', () => new ImmichSource('source', 'Immich', config)],
    ['v3', () => new ImmichV3Source('source', 'Immich', config)],
  ] as const)('%s: lists the named album, gives the nameless one no folder and prunes nothing', async (_name, create) => {
    stubOneNamelessAlbum();

    // One nameless album used to make the whole map unknown: the source listed
    // nothing at all, so 'Albums/Urlaub/b0' lost its row on the next refresh
    // for want of a listing that mentions it.
    await expect(refresh(create())).resolves.toEqual({
      seen: ['Alle Fotos/a0', 'Albums/Urlaub/b0'],
      complete: false,
      pruned: [],
      namelessAlbums: 1,
    });
  });

  it('counts the same album once however many pages carry the gap', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      if (String(input).endsWith('/api/albums')) return json([{ id: 'al-1' }]);
      const { page } = JSON.parse(String(init?.body)) as { page: number };
      return json({ assets: { items: [{ id: `p${page}` }], nextPage: page < 3 ? String(page + 1) : null } });
    }));

    await expect(refresh(new ImmichSource('source', 'Immich', config))).resolves.toMatchObject({
      seen: ['Alle Fotos/p1', 'Alle Fotos/p2', 'Alle Fotos/p3'],
      namelessAlbums: 1,
    });
  });
});

describe('the page walk of a scan', () => {
  /**
   * A source that pages by number and size, the way Immich does: page N of
   * size S starts at item (N - 1) * S.
   */
  function library(total: number) {
    const requests: { page: number; size: number }[] = [];
    const listPage = async (page: number, size: number) => {
      requests.push({ page, size });
      const start = (page - 1) * size;
      const count = Math.max(0, Math.min(size, total - start));
      const photos: PhotoRef[] = Array.from({ length: count }, (_, i) => ({
        sourceId: 'source',
        sourcePhotoId: `p${start + i}`,
        name: `${start + i}.jpg`,
      }));
      return { photos, hasMore: start + count < total };
    };
    return { listPage, requests };
  }

  function collector() {
    const taken: string[] = [];
    return {
      taken,
      take: (page: { photos: PhotoRef[] }) => { taken.push(...page.photos.map((photo) => photo.sourcePhotoId)); },
    };
  }

  const items = (count: number, from = 0) => Array.from({ length: count }, (_, i) => `p${from + i}`);

  it('leaves no item between the first glance and the walk', async () => {
    const { listPage, requests } = library(5000);
    const { taken, take } = collector();

    const walk = await scanPages(listPage, take);

    // The glance re-lists its 200 items inside the walk, and that is the price:
    // asking page 1 at size 200 and then page 2 at size 1000 started at item
    // 1000 and left p200..p999 out of the scan entirely.
    expect([...new Set(taken)]).toEqual(items(1000));
    expect(requests).toEqual([{ page: 1, size: 200 }, { page: 1, size: 1000 }]);
    expect(walk).toEqual({ paginated: true, next: { page: 2, size: 1000 }, complete: false, skipped: [] });
  });

  it('continues where the scan stopped, at the size the scan walked with', async () => {
    const { listPage, requests } = library(5000);
    const { taken, take } = collector();
    const scan = await scanPages(listPage, take);

    // What loadMore does with the recorded walk.
    take(await listPage(scan.next!.page, scan.next!.size));

    expect([...new Set(taken)]).toEqual(items(2000));
    expect(requests.at(-1)).toEqual({ page: 2, size: 1000 });
  });

  it('ends the scan where the source says the library ends', async () => {
    const { listPage } = library(150);
    const { taken, take } = collector();

    await expect(scanPages(listPage, take)).resolves.toEqual({ paginated: true, next: null, complete: true, skipped: [] });
    expect([...new Set(taken)]).toEqual(items(150));
  });

  it('leaves the generator listing to a source that cannot page at all', async () => {
    const { taken, take } = collector();
    await expect(scanPages(async () => null, take)).resolves.toEqual({ paginated: false, next: null, complete: false, skipped: [] });
    expect(taken).toEqual([]);
  });

  it('retries the page that did not answer instead of paging past it', async () => {
    const { listPage } = library(5000);
    const { take } = collector();
    const glanceOnly = async (page: number, size: number) => (size === 200 ? listPage(page, size) : null);

    await expect(scanPages(glanceOnly, take)).resolves.toEqual({ paginated: true, next: { page: 1, size: 1000 }, complete: false, skipped: [] });
  });

  it('a walk stopped by the page cap is not a finished listing', async () => {
    const { listPage, requests } = library(5000);
    const { taken, take } = collector();

    const walk = await walkPages(listPage, take, 500, 3);

    expect(walk).toEqual({ paginated: true, next: { page: 4, size: 500 }, complete: false, skipped: [] });
    expect(taken).toEqual(items(1500));
    expect(requests.every((request) => request.size === 500)).toBe(true);
  });

  // The page cap and a page that failed both end the walk unfinished, and the
  // user is told which: only a walk that skipped nothing may blame its length.
  it('names the page that did not answer, and blames nothing when the cap ends the walk', async () => {
    const { listPage } = library(5000);
    const { take } = collector();
    const failsOnPage3 = async (page: number, size: number) => (page === 3 ? null : listPage(page, size));

    const failed = await walkPages(failsOnPage3, take, 500, 10);
    expect(failed.skipped).toEqual([{ kind: 'other', detail: 'page 3' }]);
    expect(failed.complete).toBe(false);

    const capped = await walkPages(listPage, take, 500, 3);
    expect(capped.skipped).toEqual([]);
  });

  it('leaves a source that cannot page at all nothing to report', async () => {
    const { take } = collector();

    await expect(walkPages(async () => null, take, 500, 3))
      .resolves.toEqual({ paginated: false, next: null, complete: false, skipped: [] });
  });
});
