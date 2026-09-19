import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { RawDecoder } from '../engine/RawDecoder';
import { getSmartPreviewSize } from '../engine/raw';
import { loadRawPixels } from '../engine/raw/loadRawPixels';
import { makeRawCacheKey, type RawCacheIdentity } from '../engine/raw/cacheKey';
import type {
  RawPixelData, RawLoadStage, RawFetchHint, RawDecodeMode,
} from '../engine/raw/RawDecoderStrategy';

/**
 * Loads a RAW through `loadRawPixels`, the one loading ladder: decoded pixels
 * in memory, then OPFS, then a prepared server path, then a server-side fetch,
 * and only then the original file. The hook's job is the React side of it —
 * state, abort on photo change, and handing the file over once it arrives.
 */
export interface UseRawImageOptions {
  /** Photo identity; the cache key of every rung is derived from it. */
  identity: RawCacheIdentity;
  /** Long-edge in pixels for the cached preview (default: the user setting). */
  size?: number;
  /** Filename of the photo (e.g. "M5CF1107.RAF"). With it the ladder starts
   *  before `file` exists, so a cached RAW is never re-downloaded. Without it
   *  the hook waits for `file` to learn whether this is a RAW at all. */
  filename?: string;
  /** Server-side fetch descriptor from `SourceProvider.getRemoteFetchHint`. */
  fetchHint?: RawFetchHint | null;
  /** Authenticated backend path that returns an already prepared 16-bit TIFF. */
  rawPreviewHint?: { url: string } | null;
  /** Source-provider type. Browser-owned local sources (`local` and
   *  `local-files`) are always decoded in-browser and never uploaded to the
   *  RAW backend, regardless of the global decoder preference. */
  sourceType?: string;
}

export function useRawImage(file: File | null, options: UseRawImageOptions) {
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [rawPixels, setRawPixels] = useState<RawPixelData | null>(null);
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<RawLoadStage | null>(null);
  const [isRaw, setIsRaw] = useState(false);
  // What the ladder actually delivered. Discarding it is what made the 8-bit
  // fallback invisible (F039); `deriveEditorSourceDepth` turns it into the
  // editor's notice.
  const [decodeSource, setDecodeSource] = useState<RawDecodeMode | null>(null);
  const [bits, setBits] = useState<8 | 16 | null>(null);

  // Stabilize the file reference: callers (PhotoEditor) sometimes re-derive
  // the File from getFile() with the same content but a new object identity
  // on every parent re-render, which would otherwise abort an in-flight
  // decode. Compare by name+size only — `lastModified` is unreliable because
  // `new File([blob], name)` constructions (used by Immich, Lychee, etc.)
  // default lastModified to Date.now() so it changes on every getFile() call
  // even for the same underlying photo.
  const lastFileRef = useRef<File | null>(null);
  const stableFile = useMemo(() => {
    if (!file) { lastFileRef.current = null; return null; }
    const last = lastFileRef.current;
    if (last && last.name === file.name && last.size === file.size) {
      return last;
    }
    lastFileRef.current = file;
    return file;
  }, [file]);

  const identity = options.identity;
  const cacheKey = useMemo(() => makeRawCacheKey(identity), [identity]);
  const filename = options.filename;
  const size = options.size ?? getSmartPreviewSize();
  const fetchHint = options.fetchHint ?? null;
  const rawPreviewHint = options.rawPreviewHint ?? null;
  const sourceType = options.sourceType;
  // Stable JSON representation of the fetch hint so we don't rebuild the
  // effect on every parent re-render (hint objects come from .map() etc.).
  const fetchHintKey = fetchHint ? `${fetchHint.method ?? 'GET'}|${fetchHint.url}` : '';
  const rawPreviewHintKey = rawPreviewHint?.url ?? '';
  const targetName = filename ?? stableFile?.name ?? null;
  const isRawTarget = targetName !== null && RawDecoder.isRawFile(targetName);

  // The file is handed to the ladder through a ref, not a dependency: the load
  // starts before the source file exists, and restarting it the moment the
  // file arrives would abort a decode that was already nearly done. The stamp
  // keeps a file of the previously opened photo from answering this photo's
  // last rung.
  const fileRef = useRef<{ key: string; file: File } | null>(null);
  const fileWaitersRef = useRef<((file: File | null) => void)[]>([]);
  useEffect(() => {
    if (!stableFile) { fileRef.current = null; return; }
    // Re-run from a changed cacheKey alone must not re-stamp the old file.
    if (fileRef.current?.file === stableFile) return;
    fileRef.current = { key: cacheKey, file: stableFile };
    const waiters = fileWaitersRef.current;
    fileWaitersRef.current = [];
    for (const resolve of waiters) resolve(stableFile);
  }, [stableFile, cacheKey]);

  const waitForFile = useCallback((key: string, signal: AbortSignal) => (
    new Promise<File | null>((resolve) => {
      const current = fileRef.current;
      if (current && current.key === key) { resolve(current.file); return; }
      if (signal.aborted) { resolve(null); return; }
      const waiter = (file: File | null) => resolve(file);
      fileWaitersRef.current.push(waiter);
      signal.addEventListener('abort', () => {
        fileWaitersRef.current = fileWaitersRef.current.filter((entry) => entry !== waiter);
        resolve(null);
      }, { once: true });
    })
  ), []);

  useEffect(() => {
    if (!isRawTarget) {
      // Clear all RAW state on transition to non-RAW — otherwise rawPixels
      // from a previously-viewed RAW would leak into useEditorCanvas and
      // route the new (JPEG/HEIF) source through the 16-bit pipeline.
      setIsRaw(false);
      setDisplayUrl(null);
      setRawPixels(null);
      setStage(null);
      setDecodeSource(null);
      setBits(null);
      setLoading(false);
      return;
    }

    setIsRaw(true);
    setLoading(true);
    // A RAW result belongs to one cache identity. Keeping the previous
    // photo's pixels while this load is pending can upload them under the new
    // photo id before the decoder answers.
    setDisplayUrl(null);
    setRawPixels(null);
    setStage(null);
    // A new RAW has not been decoded yet; the previous photo's depth must not
    // answer for it.
    setDecodeSource(null);
    setBits(null);
    const controller = new AbortController();
    const createdUrls: string[] = [];

    void (async () => {
      try {
        const result = await loadRawPixels({
          identity,
          size,
          sourceType,
          file: (fileSignal) => waitForFile(cacheKey, fileSignal ?? controller.signal),
          fetchHint,
          preparedUrl: rawPreviewHint?.url ?? null,
          signal: controller.signal,
          onStage: (s) => { if (!controller.signal.aborted) setStage(s); },
          onPartial: (partial) => {
            if (controller.signal.aborted) return;
            createdUrls.push(partial.displayUrl);
            setDisplayUrl(partial.displayUrl);
          },
        });
        if (controller.signal.aborted || !result) return;
        createdUrls.push(result.displayUrl);
        setDisplayUrl(result.displayUrl);
        setRawPixels(result.rawPixels ?? null);
        setDecodeSource(result.source);
        setBits(result.bits);
      } catch (e) {
        if (!controller.signal.aborted) console.error('RAW decode failed:', e);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
      for (const url of createdUrls) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      }
    };
  // fetchHintKey/rawPreviewHintKey capture the request identity while avoiding
  // effect restarts for freshly allocated but equivalent hint objects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, filename, size, fetchHintKey, rawPreviewHintKey, sourceType, isRawTarget]);

  return { isRaw, displayUrl, rawPixels, loading, stage, decodeSource, bits };
}
