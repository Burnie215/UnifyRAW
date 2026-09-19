import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawCacheIdentity } from './cacheKey';
import type { RawDecodeResult, RawDecoderStrategy } from './RawDecoderStrategy';

const strategyForSource = vi.hoisted(() => vi.fn());
vi.mock('./index', () => ({ strategyForSource }));

const toResult = vi.hoisted(() => vi.fn());
const putResult = vi.hoisted(() => vi.fn());
vi.mock('./EditorRawMemoryCache', () => ({
  editorRawMemoryCache: { toResult, putResult },
  rawCacheSingleFlight: (_key: string, _size: number, load: () => Promise<RawDecodeResult | null>) => load(),
}));

import { loadRawPixels } from './loadRawPixels';

const IDENTITY: RawCacheIdentity = { sourceId: 'immich', sourcePhotoId: 'a1', sizeBytes: 42, dateModified: 7 };
const HINT = { url: 'https://immich/asset/a1', headers: {} };
const PREPARED = '/api/raw/prepared/a1';

function hit(rung: string): RawDecodeResult {
  return { displayUrl: `blob:${rung}`, width: 4, height: 2, bits: 16, source: 'smart-preview' };
}

interface Rungs { cache?: boolean; prepared?: boolean; url?: boolean; file?: boolean }

let calls: string[];

function strategyWith(rungs: Rungs, onCache?: () => void): RawDecoderStrategy {
  return {
    id: 'smart-preview',
    displayName: 'Smart Preview',
    description: '',
    isAvailable: async () => true,
    decode: vi.fn(async () => { calls.push('file'); return rungs.file ? hit('file') : null; }),
    decodeFromCache: vi.fn(async () => {
      calls.push('cache');
      onCache?.();
      return rungs.cache ? hit('cache') : null;
    }),
    decodeFromPreparedUrl: vi.fn(async () => { calls.push('prepared'); return rungs.prepared ? hit('prepared') : null; }),
    decodeFromUrl: vi.fn(async () => { calls.push('url'); return rungs.url ? hit('url') : null; }),
  };
}

beforeEach(() => {
  calls = [];
  vi.clearAllMocks();
  toResult.mockResolvedValue(null);
  putResult.mockResolvedValue(undefined);
});

describe('the one RAW loading ladder (F025)', () => {
  it('stops at the memory cache and asks no other rung', async () => {
    strategyForSource.mockReturnValue(strategyWith({ cache: true, prepared: true, url: true, file: true }));
    toResult.mockResolvedValue(hit('memory'));

    const result = await loadRawPixels({
      identity: IDENTITY, size: 1200, decodeMode: 'smart-preview',
      preparedUrl: PREPARED, fetchHint: HINT, file: new File(['raw'], 'a.arw'),
    });

    expect(result?.displayUrl).toBe('blob:memory');
    expect(calls).toEqual([]);
    // It came out of the cache; writing it back would re-encode its preview.
    expect(putResult).not.toHaveBeenCalled();
  });

  it('serves from OPFS without touching a server path or the file', async () => {
    const strategy = strategyWith({ cache: true });
    strategyForSource.mockReturnValue(strategy);
    const file = vi.fn(async () => new File(['raw'], 'a.arw'));

    const result = await loadRawPixels({
      identity: IDENTITY, size: 1200, decodeMode: 'smart-preview',
      preparedUrl: PREPARED, fetchHint: HINT, file,
    });

    expect(result?.displayUrl).toBe('blob:cache');
    expect(calls).toEqual(['cache']);
    expect(file).not.toHaveBeenCalled();
    expect(putResult).toHaveBeenCalledWith(expect.any(String), 1200, result);
  });

  it('tries the prepared server path before the fetch hint', async () => {
    strategyForSource.mockReturnValue(strategyWith({ prepared: true, url: true }));

    const result = await loadRawPixels({
      identity: IDENTITY, size: 1200, decodeMode: 'smart-preview',
      preparedUrl: PREPARED, fetchHint: HINT,
    });

    expect(result?.displayUrl).toBe('blob:prepared');
    expect(calls).toEqual(['cache', 'prepared']);
  });

  it('takes the original file last, and asks for it exactly once', async () => {
    strategyForSource.mockReturnValue(strategyWith({ file: true }));
    const file = vi.fn(async () => new File(['raw'], 'a.arw'));

    const result = await loadRawPixels({
      identity: IDENTITY, size: 1200, decodeMode: 'smart-preview',
      preparedUrl: PREPARED, fetchHint: HINT, file,
    });

    expect(result?.displayUrl).toBe('blob:file');
    expect(calls).toEqual(['cache', 'prepared', 'url', 'file']);
    expect(file).toHaveBeenCalledTimes(1);
    expect(putResult).toHaveBeenCalledWith(expect.any(String), 1200, result);
  });

  it('gives the lazy original loader the request signal', async () => {
    const controller = new AbortController();
    strategyForSource.mockReturnValue(strategyWith({ file: true }));
    const file = vi.fn(async () => new File(['raw'], 'a.arw'));

    await loadRawPixels({
      identity: IDENTITY,
      size: 1200,
      decodeMode: 'smart-preview',
      file,
      signal: controller.signal,
    });

    expect(file).toHaveBeenCalledWith(controller.signal);
  });

  it('gives up where the abort happened instead of climbing on', async () => {
    const controller = new AbortController();
    strategyForSource.mockReturnValue(strategyWith({ prepared: true }, () => controller.abort()));
    const file = vi.fn(async () => new File(['raw'], 'a.arw'));

    const result = await loadRawPixels({
      identity: IDENTITY, size: 1200, decodeMode: 'smart-preview',
      preparedUrl: PREPARED, fetchHint: HINT, file, signal: controller.signal,
    });

    expect(result).toBeNull();
    expect(calls).toEqual(['cache']);
    expect(file).not.toHaveBeenCalled();
  });

  it('keeps climbing when a server rung throws, because the file can still deliver', async () => {
    const strategy = strategyWith({ file: true });
    strategy.decodeFromPreparedUrl = vi.fn(async () => {
      calls.push('prepared');
      throw new Error('HTTP 503');
    });
    strategyForSource.mockReturnValue(strategy);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await loadRawPixels({
      identity: IDENTITY, size: 1200, decodeMode: 'smart-preview',
      preparedUrl: PREPARED, fetchHint: HINT, file: new File(['raw'], 'a.arw'),
    });

    expect(result?.displayUrl).toBe('blob:file');
    expect(calls).toEqual(['cache', 'prepared', 'url', 'file']);
  });

  it('skips the rungs a strategy has no transport for', async () => {
    const strategy = strategyWith({ file: true });
    delete strategy.decodeFromCache;
    delete strategy.decodeFromPreparedUrl;
    delete strategy.decodeFromUrl;
    strategyForSource.mockReturnValue(strategy);

    const result = await loadRawPixels({
      identity: IDENTITY, size: 1200, decodeMode: 'libraw-wasm',
      preparedUrl: PREPARED, fetchHint: HINT, file: new File(['raw'], 'a.arw'),
    });

    expect(result?.displayUrl).toBe('blob:file');
    expect(calls).toEqual(['file']);
  });

  it('reports the size and cache key of the request to every rung', async () => {
    const strategy = strategyWith({ cache: true });
    strategyForSource.mockReturnValue(strategy);

    await loadRawPixels({
      identity: IDENTITY, size: 2540, decodeMode: 'smart-preview', wantPreview: false,
    });

    const [key, size, opts] = vi.mocked(strategy.decodeFromCache!).mock.calls[0];
    expect(key).toMatch(/^immich_a1_/);
    expect(size).toBe(2540);
    expect(opts?.wantPreview).toBe(false);
    expect(toResult).toHaveBeenCalledWith(key, 2540, 'smart-preview', false);
  });
});
