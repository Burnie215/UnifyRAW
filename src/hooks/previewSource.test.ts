import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const svc = {
  bindSource: vi.fn(async (_id: string, _source: unknown) => {}),
  unbindSource: vi.fn(async (_id: string) => {}),
};
vi.mock('../engine/graph', () => ({
  getDefaultPipelineService: () => svc,
  KIND_RAW16_SOURCE: '__source.raw16',
}));

interface FakeBitmap { width: number; height: number; close: () => void }
const bitmap = (width: number, height: number): FakeBitmap => ({ width, height, close: vi.fn() });

let fetchImpl: (url: string) => Promise<{ blob: () => Promise<Blob> }>;
const fetchMock = vi.fn((url: string) => fetchImpl(url));
const okFetch = async () => ({ blob: async () => new Blob(['x']) });

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const url = (u: string) => ({ kind: 'imageBitmap' as const, key: u, url: u });

async function load() {
  vi.resetModules();
  return import('./previewSource');
}

beforeEach(() => {
  svc.bindSource.mockClear();
  svc.unbindSource.mockClear();
  fetchMock.mockClear();
  fetchImpl = okFetch;
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('createImageBitmap', vi.fn(async (_src: unknown, opts?: { resizeWidth: number; resizeHeight: number }) =>
    (opts ? bitmap(opts.resizeWidth, opts.resizeHeight) : bitmap(1024, 768))));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('acquirePreviewSource', () => {
  it('shares one fetch, one decode and one binding between two acquirers of a URL', async () => {
    const { acquirePreviewSource } = await load();
    const [a, b] = await Promise.all([acquirePreviewSource(url('blob:one')), acquirePreviewSource(url('blob:one'))]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(svc.bindSource).toHaveBeenCalledTimes(1);
    expect(a.sourceId).toBe(b.sourceId);
    expect(a.dims).toEqual({ width: 512, height: 384 });

    a.release();
    a.release();
    await flush();
    expect(svc.unbindSource).not.toHaveBeenCalled();

    b.release();
    await flush();
    expect(svc.unbindSource).toHaveBeenCalledTimes(1);
    expect(svc.unbindSource).toHaveBeenCalledWith(a.sourceId);
  });

  it('loads a URL afresh, under a new id, once its last lease is gone', async () => {
    const { acquirePreviewSource } = await load();
    const first = await acquirePreviewSource(url('blob:one'));
    first.release();
    await flush();
    const second = await acquirePreviewSource(url('blob:one'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.sourceId).not.toBe(first.sourceId);
    expect(svc.unbindSource.mock.calls).toEqual([[first.sourceId]]);
    second.release();
  });

  it('binds nothing for a failed load and retries on the next acquire', async () => {
    const { acquirePreviewSource } = await load();
    fetchImpl = async () => { throw new Error('revoked'); };
    await expect(acquirePreviewSource(url('blob:gone'))).rejects.toThrow('revoked');
    await flush();
    expect(svc.bindSource).not.toHaveBeenCalled();

    fetchImpl = okFetch;
    const lease = await acquirePreviewSource(url('blob:gone'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(svc.bindSource).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it('keeps a small image at its own size', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap(300, 200)));
    const { acquirePreviewSource } = await load();
    const lease = await acquirePreviewSource(url('blob:small'));
    expect(lease.dims).toEqual({ width: 300, height: 200 });
    lease.release();
  });
});

describe('previewSourceSpecFor', () => {
  const rawGraph = (kind: string) => ({
    nodes: new Map([['s', { id: 's', kind, params: {} }]]),
  }) as never;
  const pixels = (w: number, h: number) => ({
    data: new Uint16Array(w * h * 3), width: w, height: h, channels: 3 as const, bits: 16 as const,
  });

  it('asks for the 16-bit pixels when the graph carries a raw16 source', async () => {
    const { previewSourceSpecFor } = await load();
    const px = pixels(4, 2);
    const spec = previewSourceSpecFor(rawGraph('__source.raw16'), 'blob:jpeg', px);
    expect(spec).toEqual({ kind: 'raw16', key: expect.stringContaining('raw16:'), pixels: px });
  });

  it('refuses the display JPEG for a raw16 graph rather than binding a kind it rejects', async () => {
    const { previewSourceSpecFor } = await load();
    expect(previewSourceSpecFor(rawGraph('__source.raw16'), 'blob:jpeg', null)).toBeNull();
    // An 8-bit decode is not a raw16 source either.
    const eightBit = { ...pixels(4, 2), data: new Uint8Array(24), bits: 8 as const };
    expect(previewSourceSpecFor(rawGraph('__source.raw16'), 'blob:jpeg', eightBit as never)).toBeNull();
  });

  it('keys two photos of one size apart by their buffer', async () => {
    const { previewSourceSpecFor } = await load();
    const a = previewSourceSpecFor(rawGraph('__source.raw16'), null, pixels(4, 2));
    const b = previewSourceSpecFor(rawGraph('__source.raw16'), null, pixels(4, 2));
    expect(a!.key).not.toBe(b!.key);
  });

  it('takes the URL for a graph whose source is an imageBitmap', async () => {
    const { previewSourceSpecFor } = await load();
    const spec = previewSourceSpecFor(rawGraph('__source.imageBitmap'), 'blob:jpeg', pixels(4, 2));
    expect(spec).toEqual({ kind: 'imageBitmap', key: 'blob:jpeg', url: 'blob:jpeg' });
  });
});

describe('acquirePreviewSource (raw16)', () => {
  const raw = (w: number, h: number) => {
    const data = new Uint16Array(w * h * 3);
    for (let i = 0; i < data.length; i++) data[i] = 30_000;
    return { data, width: w, height: h, channels: 3 as const, bits: 16 as const };
  };

  it('binds downscaled 16-bit pixels without fetching anything', async () => {
    const { acquirePreviewSource, previewSourceSpecFor } = await load();
    const px = raw(2048, 1024);
    const spec = previewSourceSpecFor(
      { nodes: new Map([['s', { id: 's', kind: '__source.raw16', params: {} }]]) } as never, null, px,
    )!;
    const [a, b] = await Promise.all([acquirePreviewSource(spec), acquirePreviewSource(spec)]);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(svc.bindSource).toHaveBeenCalledTimes(1);
    expect(a.dims).toEqual({ width: 512, height: 256 });
    const bound = svc.bindSource.mock.calls[0][1] as { pixels: Uint16Array; width: number };
    expect(bound.pixels.length).toBe(512 * 256 * 3);
    // A fresh buffer: bindSource transfers it, and the editor still needs its own.
    expect(bound.pixels).not.toBe(px.data);
    expect(px.data.length).toBe(2048 * 1024 * 3);

    a.release();
    b.release();
    await flush();
    expect(svc.unbindSource).toHaveBeenCalledWith(a.sourceId);
  });
});

describe('createPreviewSourceKeeper', () => {
  it('keeps the source bound between render cycles and lets go on null', async () => {
    const { acquirePreviewSource, createPreviewSourceKeeper } = await load();
    const keeper = createPreviewSourceKeeper();
    keeper.keep(url('blob:one'));
    for (let cycle = 0; cycle < 3; cycle++) {
      keeper.keep(url('blob:one'));
      const lease = await acquirePreviewSource(url('blob:one'));
      lease.release();
      await flush();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(svc.unbindSource).not.toHaveBeenCalled();

    keeper.keep(null);
    await flush();
    expect(svc.unbindSource).toHaveBeenCalledTimes(1);
  });

  it('releases the previous URL when it moves to another one', async () => {
    const { acquirePreviewSource, createPreviewSourceKeeper } = await load();
    const keeper = createPreviewSourceKeeper();
    keeper.keep(url('blob:one'));
    const one = await acquirePreviewSource(url('blob:one'));
    one.release();
    keeper.keep(url('blob:two'));
    await flush();
    expect(svc.unbindSource.mock.calls).toEqual([[one.sourceId]]);
    keeper.keep(null);
    await flush();
    expect(svc.unbindSource).toHaveBeenCalledTimes(2);
  });

  it('unbinds a source whose owner let go before it finished loading', async () => {
    const { createPreviewSourceKeeper } = await load();
    let resolveFetch!: () => void;
    fetchImpl = () => new Promise((resolve) => { resolveFetch = () => resolve({ blob: async () => new Blob(['x']) }); });
    const keeper = createPreviewSourceKeeper();
    keeper.keep(url('blob:slow'));
    keeper.keep(null);
    resolveFetch();
    await flush();
    expect(svc.bindSource).toHaveBeenCalledTimes(1);
    expect(svc.unbindSource).toHaveBeenCalledTimes(1);
    expect(svc.unbindSource.mock.calls[0][0]).toBe(svc.bindSource.mock.calls[0][0]);
  });

  it('unbinds the shared source only after both hooks and the render in flight are done', async () => {
    const { acquirePreviewSource, createPreviewSourceKeeper } = await load();
    const taps = createPreviewSourceKeeper();
    const panel = createPreviewSourceKeeper();
    taps.keep(url('blob:one'));
    panel.keep(url('blob:one'));
    const inFlight = await acquirePreviewSource(url('blob:one'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    taps.keep(null);
    panel.keep(null);
    await flush();
    expect(svc.unbindSource).not.toHaveBeenCalled();

    inFlight.release();
    await flush();
    expect(svc.unbindSource.mock.calls).toEqual([[inFlight.sourceId]]);
  });
});
