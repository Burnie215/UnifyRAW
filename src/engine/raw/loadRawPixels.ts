import { makeRawCacheKey, type RawCacheIdentity } from './cacheKey';
import { editorRawMemoryCache, rawCacheSingleFlight } from './EditorRawMemoryCache';
import { strategyForSource } from './index';
import {
  getRawDecodeMode,
  type RawDecodeMode,
  type RawDecodeOptions,
  type RawDecodeResult,
  type RawFetchHint,
  type RawLoadStage,
} from './RawDecoderStrategy';

export interface RawLoadRequest {
  /** Photo identity; the cache key of every rung is derived from it. */
  identity: RawCacheIdentity;
  /** Long edge of the preview to load. The whole ladder is keyed by it, so a
   *  caller that needs a size-bounded RAW (print, export of a contact sheet)
   *  asks for its own size instead of the native pixels. */
  size: number;
  sourceType?: string | null;
  decodeMode?: RawDecodeMode;
  /** The original file, or a loader for it. A function is called only if
   *  every cheaper rung missed — that is what keeps a cached RAW from
   *  downloading 20-50 MB again. */
  file?: File | null | ((signal?: AbortSignal) => Promise<File | null>);
  fetchHint?: RawFetchHint | null;
  /** Backend path that already resolves to a prepared preview. */
  preparedUrl?: string | null;
  /** false skips the JPEG preview encode; `displayUrl` is then empty. */
  wantPreview?: boolean;
  signal?: AbortSignal;
  onStage?: (stage: RawLoadStage) => void;
  onPartial?: (result: RawDecodeResult) => void;
}

/**
 * The one RAW loading ladder.
 *
 * Memory → OPFS (decoded pixels, then the cached preview slot) → prepared
 * server path → server-side fetch → the original file, in exactly this order,
 * cheapest rung first. Four consumers used to carry their own ladder in four
 * different orders (F025): the editor hook, the local prefetcher, batch
 * auto-optimize and the thumbnail renderer. A rung a caller cannot use — no
 * file, no hints, a strategy without that transport — is skipped, so the same
 * call works for a cache-only probe and for a full cold open.
 *
 * Rungs 1 to 3 are optimizations: if one throws (backend down, 5xx), the
 * ladder logs and continues, because the file rung can still deliver.
 */
export async function loadRawPixels(req: RawLoadRequest): Promise<RawDecodeResult | null> {
  const { size, signal } = req;
  const cacheKey = makeRawCacheKey(req.identity);
  const strategy = strategyForSource(req.sourceType, req.decodeMode ?? getRawDecodeMode());
  const opts: RawDecodeOptions = {
    cacheKey,
    size,
    signal,
    wantPreview: req.wantPreview,
    onStage: req.onStage,
    onPartial: req.onPartial,
  };
  const aborted = () => signal?.aborted === true;

  async function keep(result: RawDecodeResult): Promise<RawDecodeResult> {
    await editorRawMemoryCache.putResult(cacheKey, size, result);
    return result;
  }

  function tolerate(rung: string, e: unknown): void {
    if (!aborted()) console.warn(`[loadRawPixels] ${rung} failed:`, e);
  }

  if (aborted()) return null;

  // 0) Decoded pixels (and their preview blob) still in RAM. Already the
  //    cache's own entry, so it is not written back.
  const inMemory = await editorRawMemoryCache.toResult(cacheKey, size, strategy.id, req.wantPreview);
  if (aborted()) return null;
  if (inMemory) return inMemory;

  // 1) OPFS, deduplicated per slot so two surfaces asking at once read once.
  if (strategy.decodeFromCache) {
    try {
      const cached = await rawCacheSingleFlight(
        cacheKey, size, () => strategy.decodeFromCache!(cacheKey, size, opts),
      );
      if (aborted()) return null;
      if (cached) return await keep(cached);
    } catch (e) {
      tolerate('cache', e);
    }
  }

  // 2) A path the backend can resolve in its own source storage.
  if (req.preparedUrl && strategy.decodeFromPreparedUrl) {
    try {
      const prepared = await strategy.decodeFromPreparedUrl(req.preparedUrl, cacheKey, size, opts);
      if (aborted()) return null;
      if (prepared) return await keep(prepared);
    } catch (e) {
      tolerate('prepared url', e);
    }
  }

  // 3) Backend fetches the original itself — saves the RAW a trip through
  //    the user's network.
  if (req.fetchHint && strategy.decodeFromUrl) {
    try {
      const fetched = await strategy.decodeFromUrl(req.fetchHint, cacheKey, size, opts);
      if (aborted()) return null;
      if (fetched) return await keep(fetched);
    } catch (e) {
      tolerate('fetch hint', e);
    }
  }

  // 4) The original file — the only rung that may cost a full download.
  const file = typeof req.file === 'function' ? await req.file(signal) : req.file ?? null;
  if (aborted() || !file) return null;
  const decoded = await strategy.decode(file, opts);
  if (aborted() || !decoded) return null;
  return keep(decoded);
}
