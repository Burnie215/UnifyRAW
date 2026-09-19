import { describe, expect, it } from 'vitest';
import type { PhotoView } from '../storage/repos';
import { runExifBackfillPass, type ExifPatch } from './exifBackfillPass';

const SOME_FILE = {} as File;

function photo(id: number, overrides: Partial<PhotoView> = {}): PhotoView {
  return {
    id,
    sourceId: 'local-1',
    sourcePhotoId: `folder/${id}.jpg`,
    name: `${id}.jpg`,
    contentHash: null,
    camera: null, lens: null, iso: null, focalLength: null, aperture: null, shutterSpeed: null,
    width: null, height: null, latitude: null, longitude: null, dateTaken: null,
    ...overrides,
  } as PhotoView;
}

interface Recorded {
  /** Photo ids whose file was fetched — one full read of the bytes each. */
  reads: number[];
  /** Photo ids whose bytes were inspected for their encoded precision. */
  probes: number[];
  /** One entry per batch write; each of them bumps the storage revision. */
  batches: Array<Array<{ id: number; patch: ExifPatch }>>;
  marked: number[][];
  keywords: Array<[string, string[]]>;
}

interface Options {
  scanned?: Iterable<number>;
  exif?: (photo: PhotoView) => Partial<PhotoView>;
  file?: (photo: PhotoView) => File | null;
  read?: (photo: PhotoView, signal?: AbortSignal) => Promise<File | null>;
  signal?: AbortSignal;
  owns?: (photo: PhotoView) => boolean;
  /** Turn the pass stale once this many files have been read. */
  staleAfterReads?: number;
  /** Encoded precision the probe reports; null stands for "cannot tell". */
  probe?: (photo: PhotoView) => number | null;
  /** Let the probe throw instead of answering. */
  probeThrows?: boolean;
}

async function pass(photos: PhotoView[], options: Options = {}): Promise<Recorded> {
  const recorded: Recorded = { reads: [], probes: [], batches: [], marked: [], keywords: [] };
  const staleAfter = options.staleAfterReads ?? Number.POSITIVE_INFINITY;
  let reading: PhotoView = photos[0];

  await runExifBackfillPass({
    photos,
    scanned: new Set(options.scanned ?? []),
    owns: options.owns ?? (() => true),
    getFile: async (p, signal) => {
      reading = p;
      recorded.reads.push(p.id);
      if (options.read) return options.read(p, signal);
      return options.file ? options.file(p) : SOME_FILE;
    },
    extractExif: async () => (options.exif ? options.exif(reading) : {}),
    probeSourceBits: async () => {
      recorded.probes.push(reading.id);
      if (options.probeThrows) throw new Error('libheif unavailable');
      return options.probe ? options.probe(reading) : null;
    },
    write: {
      updatePhotos: (updates) => { recorded.batches.push(updates); },
      setKeywords: (contentHash, keywords) => { recorded.keywords.push([contentHash, keywords]); },
      markScanned: (ids) => { recorded.marked.push([...ids]); },
    },
    signal: options.signal,
    stale: () => recorded.reads.length >= staleAfter,
    beforeBatch: async () => true,
    beforePhoto: async () => true,
    now: () => 1_700_000_000_000,
  });

  return recorded;
}

describe('runExifBackfillPass', () => {
  it('reads a file without capture EXIF once and never again', async () => {
    const photos = [photo(1), photo(2), photo(3)];

    const first = await pass(photos, { exif: () => ({}) });
    expect(first.reads).toEqual([1, 2, 3]);
    expect(first.marked).toEqual([[1, 2, 3]]);
    // The empty result is not written back as six nulls: nothing to write,
    // no revision bump, and the criterion no longer selects the row.
    expect(first.batches).toEqual([]);

    const second = await pass(photos, { exif: () => ({}), scanned: [1, 2, 3] });
    expect(second.reads).toEqual([]);
    expect(second.marked).toEqual([]);
    expect(second.batches).toEqual([]);
  });

  it('writes only the fields the file actually carries', async () => {
    const result = await pass([photo(1, { dateTaken: 5 })], {
      exif: () => ({ width: 800, height: 600, keywords: [] }),
    });

    expect(result.batches).toEqual([[{ id: 1, patch: { width: 800, height: 600 } }]]);
    expect(result.marked).toEqual([[1]]);
  });

  it('writes capture metadata and keywords of a photo that has them', async () => {
    const result = await pass([photo(1, { contentHash: 'hash-1' })], {
      exif: () => ({ camera: 'Fujifilm X-T5', iso: 400, dateTaken: 99, keywords: ['bird'] }),
    });

    expect(result.batches).toEqual([[{ id: 1, patch: { camera: 'Fujifilm X-T5', iso: 400, dateTaken: 99 } }]]);
    expect(result.keywords).toEqual([['hash-1', ['bird']]]);
  });

  it('writes once per batch, not once per photo', async () => {
    const photos = [1, 2, 3, 4, 5, 6].map((id) => photo(id));

    const result = await pass(photos, { exif: () => ({ camera: 'X' }) });

    expect(result.batches.map((batch) => batch.length)).toEqual([5, 1]);
    expect(result.marked).toEqual([[1, 2, 3, 4, 5], [6]]);
  });

  it('leaves a file it could not read unmarked, so the next run retries it', async () => {
    const result = await pass([photo(1)], { file: () => null });

    expect(result.reads).toEqual([1]);
    expect(result.marked).toEqual([]);
    expect(result.batches).toEqual([]);
  });

  it('never reads a photo whose file this device does not own', async () => {
    const result = await pass([photo(1), photo(2)], { owns: (p) => p.id !== 1 });

    expect(result.reads).toEqual([2]);
    expect(result.marked).toEqual([[2]]);
  });

  it('keeps what a stale pass already read', async () => {
    const photos = [1, 2, 3, 4, 5, 6].map((id) => photo(id));

    const result = await pass(photos, { exif: () => ({ camera: 'X' }), staleAfterReads: 2 });

    expect(result.reads).toEqual([1, 2]);
    expect(result.marked).toEqual([[1, 2]]);
    expect(result.batches).toEqual([[
      { id: 1, patch: { camera: 'X' } },
      { id: 2, patch: { camera: 'X' } },
    ]]);
  });

  it('does not start a file read when its run was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await pass([photo(1)], { signal: controller.signal });

    expect(result.reads).toEqual([]);
    expect(result.marked).toEqual([]);
  });

  it('passes the run signal into an active read and drops the result when it aborts', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });

    const resultPromise = pass([photo(1), photo(2)], {
      signal: controller.signal,
      read: async (_photo, signal) => new Promise<File | null>((resolve) => {
        received = signal;
        started();
        signal?.addEventListener('abort', () => resolve(null), { once: true });
      }),
    });

    await readStarted;
    expect(received).toBe(controller.signal);
    controller.abort();
    const result = await resultPromise;
    expect(result.reads).toEqual([1]);
    expect(result.marked).toEqual([]);
    expect(result.batches).toEqual([]);
  });
});

describe('runExifBackfillPass and the encoded source depth', () => {
  const heic = (id: number, overrides: Partial<PhotoView> = {}) =>
    photo(id, { name: `${id}.heic`, sourceBits: null, ...overrides });

  it('probes a HEIC the pass reads and writes the measured depth', async () => {
    const result = await pass([heic(1)], { probe: () => 10 });

    expect(result.probes).toEqual([1]);
    expect(result.batches).toEqual([[{ id: 1, patch: { sourceBits: 10 } }]]);
  });

  it('reads a HEIC that an older version already marked scanned', async () => {
    // The scanned mark says "EXIF was read here", not "the depth is known".
    // A catalog written before the column existed carries the mark and a null.
    const result = await pass([heic(1)], { scanned: [1], probe: () => 12 });

    expect(result.reads).toEqual([1]);
    expect(result.batches).toEqual([[{ id: 1, patch: { sourceBits: 12 } }]]);
  });

  it('records 0 when the probe cannot tell, and then leaves the file alone', async () => {
    const first = await pass([heic(1)], { probe: () => null });
    expect(first.batches).toEqual([[{ id: 1, patch: { sourceBits: 0 } }]]);

    const second = await pass([heic(1, { sourceBits: 0 })], { scanned: [1], probe: () => null });
    expect(second.reads).toEqual([]);
    expect(second.probes).toEqual([]);
  });

  it('treats a throwing probe like one that cannot tell', async () => {
    const result = await pass([heic(1)], { probeThrows: true });

    expect(result.batches).toEqual([[{ id: 1, patch: { sourceBits: 0 } }]]);
    expect(result.marked).toEqual([[1]]);
  });

  it('keeps the EXIF a read found even when the probe throws', async () => {
    const result = await pass([heic(1)], {
      probeThrows: true,
      exif: () => ({ camera: 'Pixel', width: 4032 }),
    });

    expect(result.batches).toEqual([[{
      id: 1, patch: { camera: 'Pixel', width: 4032, sourceBits: 0 },
    }]]);
  });

  it('never probes a file whose container cannot carry more than 8 bits', async () => {
    const result = await pass([photo(1), photo(2, { name: '2.CR3' })], { probe: () => 12 });

    expect(result.reads).toEqual([1, 2]);
    expect(result.probes).toEqual([]);
  });

  it('leaves a remote HEIC alone rather than pulling it down for its depth', async () => {
    const result = await pass([heic(1)], { owns: () => false, probe: () => 12 });

    expect(result.reads).toEqual([]);
    expect(result.probes).toEqual([]);
  });
});
