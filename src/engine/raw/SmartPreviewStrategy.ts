import type {
  RawDecoderStrategy, RawDecodeResult, RawDecodeOptions, RawPixelData, RawFetchHint,
} from './RawDecoderStrategy';
import { EmbeddedJpegStrategy } from './EmbeddedJpegStrategy';
import { decodeTiff } from './tiff';
import { detectWebGLCaps } from '../webglCaps';
import { getDefaultRawPixelsCache } from './RawPixelsOpfsCache';
import { apiFetch } from '../../platform/api';
import { probeSmartPreviewCache } from './smartPreviewProbe';
import { LibrawWasmStrategy } from './LibrawWasmStrategy';
import { smartPreviewFileName } from '@photolib/shared';
import { previewVariant } from './previewSlots';
import { openSmartPreviewDir, scheduleSmartPreviewEviction } from './smartPreviewMaintenance';

/**
 * Smart Preview strategy.
 *
 * Two paths driven by browser capability:
 *
 * **16-bit path** (WebGL `EXT_color_buffer_half_float` available):
 *   - Fetch 16-bit linear TIFF from `/api/raw/smart-preview` (Phase 1 endpoint)
 *   - Decode via utif → Uint16Array RGB
 *   - Convert to 8-bit JPEG via Canvas for `<img>` preview
 *   - Return both `displayUrl` (JPEG) and `rawPixels` (16-bit) — WebGL uses
 *     the 16-bit data for editing-quality precision
 *   - Cache the TIFF bytes in OPFS (so re-open skips backend round-trip)
 *
 * **8-bit fallback path** (no half-float support):
 *   - Falls through to `/api/raw/decode-binary` returning a baked 8-bit JPEG
 *   - Caches the JPEG in OPFS
 *
 * Cache key: caller passes `${sourceId}_${sourcePhotoId}` (always available).
 */
export class SmartPreviewStrategy implements RawDecoderStrategy {
  readonly id = 'smart-preview' as const;
  readonly displayName = 'Smart Preview';
  readonly description = 'Default-Modus: dekodiert serverseitig via libraw, cached das Ergebnis im Browser (OPFS). Erste Sichtung dauert 3-5s, jedes Re-Open ist <500ms. Auf modernen Browsern wird 16-bit-linear genutzt für echtes RAW-Editing.';

  private fallback = new EmbeddedJpegStrategy();
  private linearFallback = new LibrawWasmStrategy();

  async decode(file: File, opts?: RawDecodeOptions): Promise<RawDecodeResult | null> {
    if (opts?.signal?.aborted) return null;

    const caps = detectWebGLCaps();
    const size = opts?.size ?? 1200;
    const cacheKey = opts?.cacheKey ?? this.cacheKeyFromFile(file);

    if (caps.rgba16fRender) {
      try {
        return await this.decode16(file, cacheKey, size, opts);
      } catch (e) {
        if (opts?.signal?.aborted) return null;
        console.warn('[SmartPreview] 16-bit backend path failed, falling back to browser RAW decode:', e);
      }
    }

    // A RAW remains a RAW regardless of source provider. Keep it on the
    // linear 16-bit path when the backend preview fails instead of silently
    // switching the editor to the additive JPEG adjustment graph.
    if (caps.rgba16fRender) {
      return this.linearFallback.decode(file, opts);
    }

    try {
      return await this.decode8(file, cacheKey, size, opts);
    } catch (e) {
      if (opts?.signal?.aborted) return null;
      console.warn('[SmartPreview] 8-bit backend failed, falling back to embedded JPEG:', e);
      return this.fallback.decode(file, opts);
    }
  }

  /**
   * Cache-fill only — runs the same backend round-trip as `decode()` but
   * skips local TIFF decode + JPEG preview generation. Used by hover-driven
   * pre-fetching where we just want the OPFS slot warmed.
   *
   * Idempotent: returns immediately if the cache slot already exists.
   * Resolves true only when the slot holds a preview afterwards, so a failed
   * fetch - no backend, a 5xx - is never badged on a tile as cached.
   */
  async prefetch(file: File, opts: { cacheKey: string; size?: number; signal?: AbortSignal }): Promise<boolean> {
    if (opts.signal?.aborted) return false;
    const caps = detectWebGLCaps();
    const size = opts.size ?? 1200;
    const ext: 'tiff' | 'jpg' = caps.rgba16fRender ? 'tiff' : 'jpg';
    const endpoint = caps.rgba16fRender ? '/api/raw/smart-preview' : '/api/raw/decode-binary';
    const query: Record<string, string | number> = caps.rgba16fRender ? { size, key: opts.cacheKey } : {};

    // OPFS already has it?
    if (await this.opfsHas(opts.cacheKey, size, ext)) return true;

    // The server may hold it even when this browser does not (F054). Only the
    // 16-bit route has a GET counterpart to ask.
    if (caps.rgba16fRender) {
      const hit = await probeSmartPreviewCache(opts.cacheKey, size, apiFetch, opts.signal);
      if (opts.signal?.aborted) return false;
      if (hit) {
        await this.writeOpfsCache(opts.cacheKey, size, ext, hit);
        return true;
      }
    }

    try {
      const response = await this.backendFetch(endpoint, file, query, opts);
      if (!response.ok) return false;
      const blob = await response.blob();
      if (opts.signal?.aborted) return false;
      await this.writeOpfsCache(opts.cacheKey, size, ext, blob);
      return true;
    } catch (e) {
      if (opts.signal?.aborted) return false;
      console.warn(`[SmartPreview.prefetch] failed for ${opts.cacheKey}:`, e);
      return false;
    }
  }

  private async opfsHas(cacheKey: string, size: number, ext: 'tiff' | 'jpg'): Promise<boolean> {
    // A TIFF opened twice lives on in the pixel cache alone (F087).
    if (ext === 'tiff' && await getDefaultRawPixelsCache().has(cacheKey, previewVariant(size)).catch(() => false)) {
      return true;
    }
    try {
      const dir = await this.getCacheDir();
      const fileHandle = await dir.getFileHandle(this.filename(cacheKey, size, ext));
      const file = await fileHandle.getFile();
      return file.size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Cache-only decode: skip the network roundtrip to the source provider
   * (Immich, Lychee, …) entirely when a Smart Preview is already in OPFS.
   * Returns null if the cache slot doesn't exist. Lets the editor re-open
   * a RAW in <500 ms instead of 2-5 s for re-downloading the 20-50 MB RAW.
   */
  async decodeFromCache(cacheKey: string, size: number, opts?: RawDecodeOptions): Promise<RawDecodeResult | null> {
    return this.cachedResult(cacheKey, size, opts);
  }

  async isAvailable(): Promise<boolean> {
    try {
      const r = await apiFetch('/api/health', { method: 'GET' });
      return r.ok;
    } catch {
      return false;
    }
  }

  /**
   * Server-side fetch fast path: backend pulls the RAW from the given
   * URL itself, runs the smart-preview pipeline, returns a TIFF. Caller
   * uses this when the source provides `getRemoteFetchHint` — avoids
   * the 25-50 MB round-trip through the user's network.
   */
  async decodeFromUrl(
    hint: RawFetchHint,
    cacheKey: string,
    size: number,
    opts?: RawDecodeOptions,
  ): Promise<RawDecodeResult | null> {
    const cached = await this.cachedOrProbed(cacheKey, size, opts);
    if (cached) return cached;
    const buf = await this.fetchTiff({ kind: 'url', hint }, cacheKey, size, opts);
    if (!buf) return null;
    return this.resultFromTiff(buf, cacheKey, size, opts);
  }

  /**
   * Fast path for sources already owned by the PhotoLib backend. The endpoint
   * resolves the original in its source storage and returns only the prepared
   * TIFF, so the original RAW never makes a browser round-trip.
   */
  async decodeFromPreparedUrl(
    url: string,
    cacheKey: string,
    size: number,
    opts?: RawDecodeOptions,
  ): Promise<RawDecodeResult | null> {
    const cached = await this.cachedOrProbed(cacheKey, size, opts);
    if (cached) return cached;
    const buf = await this.fetchTiff({ kind: 'prepared', url }, cacheKey, size, opts);
    if (!buf) return null;
    return this.resultFromTiff(buf, cacheKey, size, opts);
  }

  // ─── The one cache ladder and the one TIFF → result conversion ───

  /**
   * Everything this strategy has cached locally, cheapest first: decoded
   * pixels, then the TIFF slot, then a legacy 8-bit slot. Every transport
   * asks this before it reaches for the network — `decodeFromUrl` used to
   * skip the pixel cache and `decodeFromPreparedUrl` checked nothing at all,
   * so the same RAW was fetched again on every open (F025).
   */
  private async cachedResult(
    cacheKey: string,
    size: number,
    opts?: RawDecodeOptions,
  ): Promise<RawDecodeResult | null> {
    if (opts?.signal?.aborted) return null;
    opts?.onStage?.({ kind: 'cache-check', label: 'Cache prüfen', next: 'RAW aufbereiten' });

    // Phase 1.D: post-decode RawPixels OPFS cache. Skips the TIFF decode
    // entirely on warm cache (saves ~10–50 ms per open).
    try {
      const cached = await getDefaultRawPixelsCache().get(cacheKey, previewVariant(size));
      if (cached) return await this.resultFromCachedPixels(cached, opts);
    } catch (e) {
      console.warn('[SmartPreview] rawPixels cache probe failed:', e);
    }
    if (opts?.signal?.aborted) return null;

    const tiffBytes = await this.readOpfsCache(cacheKey, size, 'tiff');
    if (tiffBytes) {
      try {
        const tiffBuf = await tiffBytes.arrayBuffer();
        if (opts?.signal?.aborted) return null;
        return await this.resultFromTiff(tiffBuf, cacheKey, size, opts, true);
      } catch (e) {
        // Cached TIFF didn't decode cleanly; resultFromTiff evicted it. Fall
        // through so a transport can re-fetch a fresh one.
        console.warn('[SmartPreview] cached TIFF failed to decode, evicting:', e);
      }
    }

    // Legacy 8-bit cache entries must not silently route a RAW through the
    // JPEG adjustment graph on HDR-capable browsers. Evict and regenerate a
    // linear TIFF/browser preview instead.
    const jpegBytes = await this.readOpfsCache(cacheKey, size, 'jpg');
    if (jpegBytes) {
      if (detectWebGLCaps().rgba16fRender) {
        this.deleteOpfsCache(cacheKey, size, 'jpg').catch(() => {});
      } else {
        opts?.onStage?.({ kind: 'done', label: 'Fertig' });
        return this.jpegResult(jpegBytes);
      }
    }

    return null;
  }

  /**
   * The one TIFF → `RawDecodeResult` conversion. Four copies of this block
   * used to drift apart (F025), which is why cache format, stage labels and
   * calibration semantics had to be nachgezogen in five places.
   *
   * `promote` is set when the bytes came out of the OPFS TIFF slot: the
   * pixels then move into the pixel cache and the TIFF is dropped, so one RAW
   * never occupies two slots (F087). Freshly fetched bytes are not promoted —
   * their TIFF write is still in flight, and deleting a slot underneath it
   * would leave the file behind for good.
   */
  private async resultFromTiff(
    buf: ArrayBuffer,
    cacheKey: string,
    size: number,
    opts?: RawDecodeOptions,
    promote = false,
  ): Promise<RawDecodeResult | null> {
    opts?.onStage?.({ kind: 'decode', label: 'TIFF dekodieren', next: 'Vorschau bauen' });
    let decoded: ReturnType<typeof decodeTiff>;
    try {
      decoded = decodeTiff(buf);
    } catch (e) {
      // utif choked on the buffer — almost always a corrupt cache file from
      // earlier truncation. Evict so the next attempt re-fetches.
      this.deleteOpfsCache(cacheKey, size, 'tiff').catch(() => {});
      throw e;
    }
    // This is the calibration boundary: the backend baked camera WB and the
    // camera→sRGB conversion into these pixels (`dcraw_emu -w -o 1`). DNG
    // AsShotNeutral stores neutral values rather than WB-applying gains, and
    // applying copied DNG calibration again here would double-develop them.
    const rawPixels: RawPixelData = {
      data: decoded.data,
      width: decoded.width,
      height: decoded.height,
      channels: decoded.channels,
      bits: decoded.bits,
      colorMatrix: null,
      asShotNeutral: null,
    };
    const displayUrl = await this.previewUrl(decoded, opts);
    if (opts?.signal?.aborted) return null;
    if (promote && rawPixels.bits === 16 && rawPixels.data instanceof Uint16Array) {
      getDefaultRawPixelsCache()
        .put(cacheKey, previewVariant(size), rawPixels)
        .then(() => this.deleteOpfsCache(cacheKey, size, 'tiff'))
        .catch((err: unknown) => console.warn('[SmartPreview] rawPixels cache write failed:', err));
    }
    opts?.onStage?.({ kind: 'done', label: 'Fertig' });
    return {
      displayUrl,
      width: decoded.width,
      height: decoded.height,
      bits: decoded.bits,
      source: this.id,
      rawPixels,
    };
  }

  /**
   * The three ways a smart-preview TIFF reaches the browser. All of them
   * write the result into the OPFS slot and hand back the same bytes, so the
   * caller has one decode path regardless of who fetched.
   */
  /**
   * The local ladder plus the server's own cache.
   *
   * Deliberately NOT part of `cachedResult`: that one backs `decodeFromCache`,
   * the loadRawPixels ladder's local rung, which must stay off the network.
   * Every path that is about to push the whole RAW up the wire asks the server
   * first instead - a hit costs a few hundred bytes rather than the file (F054).
   */
  private async cachedOrProbed(
    cacheKey: string,
    size: number,
    opts?: RawDecodeOptions,
  ): Promise<RawDecodeResult | null> {
    const cached = await this.cachedResult(cacheKey, size, opts);
    if (cached) return cached;
    const hit = await probeSmartPreviewCache(cacheKey, size, apiFetch, opts?.signal);
    if (opts?.signal?.aborted || !hit) return null;
    this.writeOpfsCache(cacheKey, size, 'tiff', hit).catch((e) => {
      console.warn('[SmartPreview] OPFS TIFF cache write failed:', e);
    });
    return this.resultFromTiff(await hit.arrayBuffer(), cacheKey, size, opts);
  }

  private async fetchTiff(
    transport:
      | { kind: 'file'; file: File }
      | { kind: 'url'; hint: RawFetchHint }
      | { kind: 'prepared'; url: string },
    cacheKey: string,
    size: number,
    opts?: RawDecodeOptions,
  ): Promise<ArrayBuffer | null> {
    opts?.onStage?.({ kind: 'fetch', label: 'RAW aufbereiten', next: 'TIFF dekodieren' });

    let response: Response;
    if (transport.kind === 'file') {
      response = await this.backendFetch(
        '/api/raw/smart-preview', transport.file, { size, key: cacheKey }, opts,
      );
    } else if (transport.kind === 'url') {
      const { hint } = transport;
      const timeout = withTimeout(180_000, opts?.signal);
      try {
        response = await apiFetch(
          `/api/raw/smart-preview-from-url?size=${size}&key=${encodeURIComponent(cacheKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: hint.url, headers: hint.headers, method: hint.method, size, key: cacheKey }),
            signal: timeout.signal,
          },
        );
      } finally {
        timeout.done();
      }
    } else {
      const separator = transport.url.includes('?') ? '&' : '?';
      response = await apiFetch(`${transport.url}${separator}size=${size}`, {
        method: 'POST',
        signal: opts?.signal,
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const buf = await response.arrayBuffer();
    if (opts?.signal?.aborted) return null;
    this.writeOpfsCache(cacheKey, size, 'tiff', new Blob([buf], { type: 'image/tiff' })).catch((e) => {
      console.warn('[SmartPreview] OPFS TIFF cache write failed:', e);
    });
    return buf;
  }

  /** Phase 1.D: post-decode RawPixels OPFS cache, no TIFF decode at all. */
  private async resultFromCachedPixels(cached: RawPixelData, opts?: RawDecodeOptions): Promise<RawDecodeResult | null> {
    if (opts?.signal?.aborted) return null;
    // Binary cache v1 retains its calibration fields for compatibility, but
    // every productive Smart Preview is already WB-corrected sRGB. Normalize
    // older entries at the same boundary as freshly decoded TIFFs.
    const rawPixels: RawPixelData = {
      ...cached,
      colorMatrix: null,
      asShotNeutral: null,
    };
    const displayUrl = await this.previewUrl({
      data: rawPixels.data as Uint16Array,
      width: rawPixels.width,
      height: rawPixels.height,
      channels: rawPixels.channels,
      bits: 16,
    }, opts);
    if (opts?.signal?.aborted) return null;
    opts?.onStage?.({ kind: 'done', label: 'Fertig' });
    return {
      displayUrl,
      width: rawPixels.width, height: rawPixels.height, bits: 16,
      source: this.id, rawPixels,
    };
  }

  /** A caller that only wants the pixels pays for no JPEG encode. */
  private async previewUrl(decoded: ReturnType<typeof decodeTiff>, opts?: RawDecodeOptions): Promise<string> {
    if (opts?.wantPreview === false) return '';
    opts?.onStage?.({ kind: 'preview', label: 'Vorschau bauen', next: 'An Pipeline übergeben' });
    return URL.createObjectURL(await this.tiffToPreviewJpeg(decoded));
  }

  // ─── 16-bit path: TIFF endpoint + utif decode ───

  private async decode16(
    file: File,
    cacheKey: string,
    size: number,
    opts?: RawDecodeOptions,
  ): Promise<RawDecodeResult | null> {
    const cached = await this.cachedOrProbed(cacheKey, size, opts);
    if (cached) return cached;
    const buf = await this.fetchTiff({ kind: 'file', file }, cacheKey, size, opts);
    if (!buf) return null;
    return this.resultFromTiff(buf, cacheKey, size, opts);
  }

  // ─── 8-bit fallback path: legacy JPEG endpoint ───

  private async decode8(
    file: File,
    cacheKey: string,
    size: number,
    opts?: RawDecodeOptions,
  ): Promise<RawDecodeResult | null> {
    opts?.onStage?.({ kind: 'cache-check', label: 'Cache prüfen', next: 'RAW aufbereiten' });
    const cached = await this.readOpfsCache(cacheKey, size, 'jpg');
    if (cached) {
      opts?.onStage?.({ kind: 'done', label: 'Fertig' });
      return this.jpegResult(cached);
    }

    opts?.onStage?.({ kind: 'fetch', label: 'RAW aufbereiten', next: 'An Pipeline übergeben' });
    const response = await this.backendFetch('/api/raw/decode-binary', file, {}, opts);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    const blob = await response.blob();
    if (opts?.signal?.aborted) return null;

    this.writeOpfsCache(cacheKey, size, 'jpg', blob).catch((e) => {
      console.warn('[SmartPreview] OPFS JPEG cache write failed:', e);
    });

    opts?.onStage?.({ kind: 'done', label: 'Fertig' });
    return this.jpegResult(blob);
  }

  private jpegResult(blob: Blob): RawDecodeResult {
    return {
      displayUrl: URL.createObjectURL(blob),
      width: 0,
      height: 0,
      bits: 8,
      source: this.id,
    };
  }

  // ─── Helpers ───

  private async tiffToPreviewJpeg(decoded: ReturnType<typeof decodeTiff>): Promise<Blob> {
    const { data, width, height, channels, bits } = decoded;
    // Downsample 16-bit → 8-bit (high-byte) for preview. This is a rough
    // gamma-2.2-like approximation; not display-quality, but the WebGL
    // pipeline will produce the real output once the 16-bit source is up.
    const pxCount = width * height;
    const rgba = new Uint8ClampedArray(pxCount * 4);

    if (bits === 16) {
      const src = data as Uint16Array;
      for (let p = 0; p < pxCount; p++) {
        const si = p * channels;
        const di = p * 4;
        // Take the high byte (>> 8) which represents 0-255 of 0-65535.
        // Apply approximate gamma 2.2 via lookup for somewhat sensible preview.
        rgba[di] = gammaLut[src[si] >> 8];
        rgba[di + 1] = gammaLut[src[si + 1] >> 8];
        rgba[di + 2] = gammaLut[src[si + 2] >> 8];
        rgba[di + 3] = 255;
      }
    } else {
      const src = data as Uint8Array;
      for (let p = 0; p < pxCount; p++) {
        const si = p * channels;
        const di = p * 4;
        rgba[di] = src[si];
        rgba[di + 1] = src[si + 1];
        rgba[di + 2] = src[si + 2];
        rgba[di + 3] = 255;
      }
    }

    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, width, height), 0, 0);
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  }

  private async backendFetch(
    endpoint: string,
    file: File,
    query: Record<string, string | number>,
    opts?: RawDecodeOptions,
  ): Promise<Response> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) params.set(k, String(v));
    const url = params.toString() ? `${endpoint}?${params}` : endpoint;

    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };

    const timeout = withTimeout(120_000, opts?.signal);
    try {
      return await apiFetch(url, {
        method: 'POST',
        headers,
        body: file,
        signal: timeout.signal,
      });
    } finally {
      timeout.done();
    }
  }

  private cacheKeyFromFile(file: File): string {
    return `file_${file.name.replace(/[^A-Za-z0-9_-]/g, '_')}_${file.size}`;
  }

  // ─── OPFS cache ───

  private async readOpfsCache(cacheKey: string, size: number, ext: 'tiff' | 'jpg'): Promise<Blob | null> {
    try {
      const dir = await this.getCacheDir();
      const fileHandle = await dir.getFileHandle(this.filename(cacheKey, size, ext));
      const file = await fileHandle.getFile();
      if (file.size === 0) return null;
      // Sanity-check: a real 1200 px Smart Preview TIFF is ~3-7 MB (16-bit
      // LZW) and the JPEG path is ~200-800 KB. Anything <50 KB is almost
      // certainly a leftover from the /dev/shm-truncation regression — its
      // utif decode would stall mid-way ('decoding 50%' hang reported
      // 2026-05-18). Treat as miss and delete so the next pass re-fetches.
      const MIN_PLAUSIBLE = 50 * 1024;
      if (file.size < MIN_PLAUSIBLE) {
        this.deleteOpfsCache(cacheKey, size, ext).catch(() => {});
        return null;
      }
      return file;
    } catch {
      return null;
    }
  }

  /** Delete a cache slot — used when a read returned suspect bytes or a
   *  decode failed, so the next request re-fetches a clean copy. */
  private async deleteOpfsCache(cacheKey: string, size: number, ext: 'tiff' | 'jpg'): Promise<void> {
    try {
      const dir = await this.getCacheDir();
      await dir.removeEntry(this.filename(cacheKey, size, ext));
    } catch { /* already gone */ }
  }

  private async writeOpfsCache(cacheKey: string, size: number, ext: 'tiff' | 'jpg', blob: Blob): Promise<void> {
    const dir = await this.getCacheDir();
    const fileHandle = await dir.getFileHandle(this.filename(cacheKey, size, ext), { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    scheduleSmartPreviewEviction(dir);
  }

  private async getCacheDir(): Promise<FileSystemDirectoryHandle> {
    return openSmartPreviewDir();
  }

  private filename(cacheKey: string, size: number, ext: 'tiff' | 'jpg'): string {
    return smartPreviewFileName(cacheKey, size, ext);
  }

}

/**
 * Caller signal plus a hard ceiling. Even on a slow network the response has
 * to arrive inside the backend's own timeout; otherwise something is wedged
 * and aborting beats leaving the overlay at "RAW aufbereiten" forever.
 */
function withTimeout(ms: number, signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  const signals: AbortSignal[] = [controller.signal];
  if (signal) signals.push(signal);
  const combined = 'any' in AbortSignal
    ? (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any(signals)
    : controller.signal;
  return { signal: combined, done: () => clearTimeout(id) };
}

// Approximate sRGB gamma curve LUT for preview-JPEG generation.
const gammaLut: Uint8Array = (() => {
  const a = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const linear = i / 255;
    const gamma = linear <= 0.0031308
      ? linear * 12.92
      : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    a[i] = Math.round(Math.max(0, Math.min(1, gamma)) * 255);
  }
  return a;
})();

// Color-matrix helpers (dngToCamToSrgbMatrix, mul3x3, invert3x3) were
// removed when the backend switched to `-o 1` (libraw applies the camera→
// sRGB conversion natively). Re-add if a future strategy needs them.
