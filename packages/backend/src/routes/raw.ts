import { Router, json as expressJson } from 'express';
import type { Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { existsSync, statfsSync } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { sendError } from '../util/errors.js';
import { DecodeQueueFullError, runQueued } from '../services/decodeQueue.js';
import { SMART_PREVIEW_DIR, isStalePreviewFile, smartPreviewPath } from '../services/smartPreviewPaths.js';
import { SMART_PREVIEW_HALF_SIZE_MAX_PX, SMART_PREVIEW_MAX_PX } from '@photolib/shared';
import {
  NetworkResponseTooLargeError,
  NetworkTargetError,
  parsePrivateHostAllowlist,
} from '../security/network-target.js';
import { isForwardableUpstreamHeader } from '../security/upstream-headers.js';
import { requestNetworkBufferForClient } from './client-network.js';

const execFileAsync = promisify(execFile);

const SMART_PREVIEW_QUOTA_BYTES =
  positiveNumber(process.env.SMART_PREVIEW_QUOTA_GB, 10) * 1024 * 1024 * 1024;
const RAW_MAX_UPLOAD_BYTES = positiveNumber(process.env.RAW_MAX_UPLOAD_MB, 128) * 1024 * 1024;
const RAW_MAX_REMOTE_BYTES = positiveNumber(process.env.RAW_MAX_REMOTE_MB, 256) * 1024 * 1024;
const RAW_FETCH_TIMEOUT_MS = positiveNumber(process.env.RAW_FETCH_TIMEOUT_MS, 120_000);
const RAW_MAX_DECODE_PIXELS = positiveNumber(process.env.RAW_MAX_DECODE_MEGAPIXELS, 120) * 1_000_000;
const RAW_FETCH_POLICY = {
  allowPrivate: process.env.RAW_ALLOW_PRIVATE_FETCH === 'true',
  allowedPrivateHosts: parsePrivateHostAllowlist(process.env.RAW_ALLOWED_PRIVATE_HOSTS),
};

/** The production image installs libraw-tools, whose RAW decoder is dcraw_emu. */
export const RAW_DECODE_TOOLS = ['dcraw_emu'] as const;

/** Camera white balance baked into an sRGB decode on every dcraw_emu path. */
export const DCRAW_EMU_COLOR = ['-w', '-o', '1'] as const;

async function purgeSmartPreviewCache(): Promise<void> {
  try { await fs.mkdir(SMART_PREVIEW_DIR, { recursive: true }); } catch { /* */ }
  // One-time purge: before atomic-write hardening (commit 9880475), partial
  // writes from the /dev/shm-truncation bug could leave bad TIFFs in the
  // cache forever. Probe each existing entry with sharp.metadata and delete
  // anything that doesn't parse. Also drops any leftover .tmp staging files.
  try {
    const entries = await fs.readdir(SMART_PREVIEW_DIR);
    let bad = 0;
    let stale = 0;
    let outdated = 0;
    for (const name of entries) {
      const p = path.join(SMART_PREVIEW_DIR, name);
      if (name.endsWith('.tmp')) {
        await fs.unlink(p).catch(() => {});
        stale++;
        continue;
      }
      if (!name.endsWith('.tiff') && !name.endsWith('.jpg')) continue;
      if (isStalePreviewFile(name)) {
        await fs.unlink(p).catch(() => {});
        outdated++;
        continue;
      }
      try {
        const meta = await sharp(p, { failOn: 'none' }).metadata();
        if (!meta.width || !meta.height) throw new Error('zero dims');
      } catch {
        await fs.unlink(p).catch(() => {});
        bad++;
      }
    }
    if (bad > 0 || stale > 0 || outdated > 0) {
      console.log(`[smart-preview.purge] removed ${bad} corrupt + ${stale} stale staging + ${outdated} outdated-version files at boot`);
    }
  } catch { /* dir gone or unreadable — nothing to clean */ }
}

/**
 * Temp directory for short-lived RAW decode artifacts.
 *
 * Prefers /dev/shm (RAM-backed tmpfs) for speed — but Docker's default
 * /dev/shm is 64 MB, which silently truncates the >70 MB PPMs that
 * dcraw_emu writes for 24+ MP sensors. We need at least ~256 MB head-
 * room (RAF input + PPM output + dcraw_emu working set). If /dev/shm
 * is too small, fall back to os.tmpdir() (host filesystem; slower but
 * unconstrained).
 */
function pickRawTmpdir(): string {
  if (existsSync('/dev/shm')) {
    try {
      const stats = statfsSync('/dev/shm');
      const totalMB = (stats.bsize * stats.blocks) / 1024 / 1024;
      if (totalMB >= 256) return '/dev/shm';
      console.log(`[raw] /dev/shm only ${Math.round(totalMB)} MB, falling back to ${os.tmpdir()}`);
    } catch { /* fall through */ }
  }
  return os.tmpdir();
}
const RAW_TMPDIR = pickRawTmpdir();

const RAW_TMP_PREFIX = 'photolib-raw-';

/**
 * Remove orphaned raw decode artifacts. Runs once at boot (cleans previous
 * crash leftovers) and every 5 min (sweeps anything that crashed since).
 * Files newer than 60s are spared — they may be live decodes in progress.
 */
async function gcOrphans(maxAgeMs: number, dir = RAW_TMPDIR): Promise<{ removed: number; bytes: number }> {
  let removed = 0;
  let bytes = 0;
  try {
    const entries = await fs.readdir(dir);
    const now = Date.now();
    for (const name of entries) {
      if (!name.startsWith(RAW_TMP_PREFIX)) continue;
      const p = path.join(dir, name);
      try {
        const stat = await fs.stat(p);
        if (now - stat.mtimeMs < maxAgeMs) continue;
        bytes += stat.size;
        await fs.unlink(p);
        removed++;
      } catch { /* race or perm — skip */ }
    }
  } catch { /* tmpdir gone? — skip */ }
  return { removed, bytes };
}

/**
 * The server's housekeeping for RAW decoding: the smart-preview cache purge,
 * a sweep of every orphaned decode file, and a sweep every 5 min of files
 * older than 60 s. Called once by the server when it mounts the RAW routes,
 * never on import: importing this module (a test, the sync hub) used to
 * delete every photolib-raw-* file in the shared temp directory, including
 * the in-flight decodes of a backend running on the same host.
 */
export function startRawMaintenance(options: { tmpDir?: string } = {}): () => void {
  const dir = options.tmpDir ?? RAW_TMPDIR;
  void purgeSmartPreviewCache();
  gcOrphans(0, dir).then(({ removed, bytes }) => {
    if (removed > 0) console.log(`[raw.gc] startup: removed ${removed} orphan files (${Math.round(bytes / 1024 / 1024)} MB) from ${dir}`);
  }).catch(() => {});
  const timer = setInterval(() => {
    gcOrphans(60_000, dir).then(({ removed, bytes }) => {
      if (removed > 0) console.log(`[raw.gc] periodic: removed ${removed} orphan files (${Math.round(bytes / 1024 / 1024)} MB)`);
    }).catch(() => {});
  }, 5 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

export const rawRouter = Router();

/**
 * POST /api/raw/decode-binary
 * Body: RAW file binary
 * Returns: image/jpeg binary with X-Image-Width / X-Image-Height / X-Image-Bits /
 *          X-Image-Decoder response headers.
 *
 * Uses libraw-tools (dcraw_emu), the decoder installed in the production
 * image, with camera white balance and sRGB output baked into the pixels.
 */
rawRouter.post('/decode-binary', async (req: Request, res: Response) => {
  const tmpFile = createRawTempPath('decode-binary');

  try {
    const buffer = await readRequestBody(req, RAW_MAX_UPLOAD_BYTES);
    if (buffer.length === 0) {
      res.status(400).json({ error: 'empty body' });
      return;
    }
    await fs.writeFile(tmpFile, buffer);

    const { ppm, decoder } = await runQueued(() => decodeRaw(tmpFile));
    const { width, height, maxval, body } = parsePpm(ppm);
    if (maxval > 255) {
      throw new Error(`Expected 8-bit PPM (maxval=255), got maxval=${maxval}. dcraw flags likely include -4 or -6.`);
    }
    const expected = width * height * 3;
    if (body.length !== expected) {
      throw new Error(`PPM body size mismatch: expected ${expected} bytes (${width}x${height}x3), got ${body.length}`);
    }

    const jpeg = await sharp(body, {
      raw: { width, height, channels: 3 },
    }).jpeg({ quality: 95 }).toBuffer();

    res.set('Content-Type', 'image/jpeg');
    res.set('X-Image-Width', String(width));
    res.set('X-Image-Height', String(height));
    res.set('X-Image-Bits', '8');
    res.set('X-Image-Decoder', decoder);
    res.send(jpeg);
  } catch (e) {
    sendRawError(res, 'raw.decode-binary', 'RAW decode failed', e);
  } finally {
    await fs.unlink(tmpFile).catch(() => {});
  }
});

// ─── Helpers ───

/**
 * Arguments for the one 8-bit decoder path. Kept pure and exported so the
 * installed-tool and colour-output contract can be tested without a camera.
 */
export function dcrawEmuDecodeArgs(tmpFile: string): string[] {
  return ['-q', '3', ...DCRAW_EMU_COLOR, tmpFile];
}

/**
 * Decode RAW → PPM (P6 8-bit RGB) with libraw-tools. dcraw_emu writes the
 * output next to the input file; the production image has no `dcraw` binary.
 */
async function decodeRaw(tmpFile: string): Promise<{ ppm: Buffer; decoder: string }> {
  const decoder = RAW_DECODE_TOOLS[0];
  const outPath = tmpFile + '.ppm';
  try {
    await execFileAsync(decoder, dcrawEmuDecodeArgs(tmpFile), {
      encoding: 'buffer' as BufferEncoding,
      maxBuffer: Math.ceil(RAW_MAX_DECODE_PIXELS * 3 + 1024 * 1024),
      timeout: 90_000,
      killSignal: 'SIGKILL',
    });
    const ppm = await fs.readFile(outPath);
    if (ppm.length === 0) throw new Error('dcraw_emu returned an empty PPM');
    return { ppm, decoder };
  } catch (cause) {
    throw new Error('RAW decoding unavailable: dcraw_emu from libraw-tools failed', { cause });
  } finally {
    await fs.unlink(outPath).catch(() => {});
  }
}

/**
 * Parse PPM (P6) header → { width, height, body }.
 * The body is raw 8-bit RGB pixel bytes that sharp can ingest via
 * `sharp(body, { raw: { width, height, channels: 3 } })`.
 */
function parsePpm(buf: Buffer): { width: number; height: number; maxval: number; body: Buffer } {
  // PPM/PGM header is exactly 4 whitespace-separated tokens followed by ONE
  // whitespace byte, then binary pixel data. Tokens may have "# comment"
  // lines BETWEEN them. Crucially, the comment-skip rule only applies
  // inside the textual header — the previous implementation kept skipping
  // through binary data if a pixel byte happened to equal '\n' followed by
  // '#', dropping kilobytes of valid pixels and tripping sharp's
  // memory-area-too-small check.

  const isSpace = (b: number) => b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D;
  let i = 0;
  const tokens: string[] = [];
  while (tokens.length < 4 && i < buf.length) {
    // Skip whitespace
    while (i < buf.length && isSpace(buf[i])) i++;
    // Skip a comment line "# ... \n"
    if (i < buf.length && buf[i] === 0x23) {
      while (i < buf.length && buf[i] !== 0x0A) i++;
      continue;
    }
    // Read a token until next whitespace
    const start = i;
    while (i < buf.length && !isSpace(buf[i]) && buf[i] !== 0x23) i++;
    if (i > start) tokens.push(buf.subarray(start, i).toString('ascii'));
  }

  // After the maxval token there is EXACTLY ONE whitespace byte before the
  // binary block starts. (Per netpbm spec.)
  if (i < buf.length && isSpace(buf[i])) i++;

  const magic = tokens[0];
  const width = parseInt(tokens[1], 10);
  const height = parseInt(tokens[2], 10);
  const maxval = parseInt(tokens[3], 10);
  if (magic !== 'P6' || !Number.isFinite(width) || !Number.isFinite(height)
      || width <= 0 || height <= 0 || !Number.isFinite(maxval) || maxval <= 0) {
    throw new Error(`PPM parse failed: tokens=${JSON.stringify(tokens)}`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > RAW_MAX_DECODE_PIXELS) {
    throw new Error(`Decoded image exceeds the ${RAW_MAX_DECODE_PIXELS} pixel limit`);
  }
  return { width, height, maxval, body: buf.subarray(i) };
}

// ─── Smart Preview (16-bit linear TIFF) ───

/**
 * Sanitize a cache-key — letters, digits, dash, underscore only. Prevents
 * path traversal via `key=../../etc/passwd`.
 */
function safeKey(raw: string): string | null {
  if (!raw || raw.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  return raw;
}

/**
 * Above this long edge the half-size demosaic (`-h`) caps the output below the
 * requested size, and sharp never enlarges; the export asks for 8000 and got
 * half the sensor. Larger requests therefore decode at full size.
 */
export const HALF_SIZE_MAX_PX = SMART_PREVIEW_HALF_SIZE_MAX_PX;

/** Its cache version follows from the size (`smartPreviewVersion` in @photolib/shared). */
export function dcrawEmuArgs(size: number): string[] {
  return ['-T', ...(size <= HALF_SIZE_MAX_PX ? ['-h'] : []), '-6', '-g', '1', '1', ...DCRAW_EMU_COLOR];
}

/** Descriptive capture metadata retained in the developed Smart Preview. */
export const EXIFTOOL_COPY_TAGS = [
  '-Make', '-Model', '-ISO', '-FocalLength', '-Orientation',
] as const;

/**
 * LRU eviction when total cache size exceeds quota. Removes oldest-accessed
 * files until under the cap.
 */
async function evictIfNeeded(): Promise<void> {
  try {
    const entries = await fs.readdir(SMART_PREVIEW_DIR);
    const stats = await Promise.all(
      entries.map(async (name) => {
        // Skip in-flight staging files — they're not part of the cache yet.
        if (name.endsWith('.tmp')) return null;
        try {
          const p = path.join(SMART_PREVIEW_DIR, name);
          const s = await fs.stat(p);
          return { path: p, atime: s.atimeMs, size: s.size };
        } catch { return null; }
      }),
    );
    const valid = stats.filter((s): s is { path: string; atime: number; size: number } => !!s);
    const total = valid.reduce((sum, s) => sum + s.size, 0);
    if (total <= SMART_PREVIEW_QUOTA_BYTES) return;

    valid.sort((a, b) => a.atime - b.atime);
    let evicted = 0;
    let bytesFreed = 0;
    let remaining = total;
    for (const f of valid) {
      if (remaining <= SMART_PREVIEW_QUOTA_BYTES) break;
      await fs.unlink(f.path).catch(() => {});
      remaining -= f.size;
      bytesFreed += f.size;
      evicted++;
    }
    if (evicted > 0) {
      console.log(`[smart-preview.lru] evicted ${evicted} files (${Math.round(bytesFreed / 1024 / 1024)} MB)`);
    }
  } catch (e) {
    console.warn('[smart-preview.lru] eviction failed:', e);
  }
}

/**
 * Core Smart Preview generation pipeline. Given the path of a freshly
 * written RAW on disk, runs dcraw_emu → sharp resize → exiftool → atomic
 * rename into the persistent cache, and returns the final TIFF bytes +
 * dimensions. Shared by both /smart-preview (binary upload) and
 * /smart-preview-from-url (server-side fetch).
 */
async function generateSmartPreview(tmpRaw: string, key: string, size: number, rawInSize: number): Promise<{ bytes: Buffer; width: number; height: number; tmpTiff: string }> {
  const cachedPath = smartPreviewPath(key, size);
  let tmpTiff = '';
  const tQueue = Date.now();
  const result = await runQueued(async () => {
    const tStart = Date.now();
    await execFileAsync('dcraw_emu', [...dcrawEmuArgs(size), tmpRaw],
      { maxBuffer: 16 * 1024 * 1024, timeout: 90_000, killSignal: 'SIGKILL' });
    const tDcraw = Date.now() - tStart;
    tmpTiff = tmpRaw + '.tiff';

    const tSharp0 = Date.now();
    const resized = await sharp(tmpTiff, {
      failOn: 'none',
      limitInputPixels: RAW_MAX_DECODE_PIXELS,
    })
      .pipelineColorspace('rgb16')
      .resize(size, size, { fit: 'inside', kernel: sharp.kernel.lanczos3, withoutEnlargement: true })
      .toColorspace('rgb16')
      .tiff({ compression: 'lzw', predictor: 'horizontal' })
      .toBuffer();
    const tSharp = Date.now() - tSharp0;

    const stagingPath = cachedPath + '.tmp';
    try {
      await fs.mkdir(path.dirname(stagingPath), { recursive: true });
      await fs.writeFile(stagingPath, resized);
      try {
        await execFileAsync('exiftool', [
          '-overwrite_original', '-TagsFromFile', tmpRaw,
          ...EXIFTOOL_COPY_TAGS,
          stagingPath,
        ], { timeout: 30_000, killSignal: 'SIGKILL' });
      } catch (e) {
        console.warn('[smart-preview] exiftool tag copy failed (non-fatal):', e);
      }

      const final = await fs.readFile(stagingPath);
      const meta = await sharp(final, {
        failOn: 'none',
        limitInputPixels: RAW_MAX_DECODE_PIXELS,
      }).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width <= 0 || height <= 0) {
        throw new Error(`smart-preview validation failed: width=${width} height=${height} size=${final.length}`);
      }

      await fs.rename(stagingPath, cachedPath);
      const tTotal = Date.now() - tStart;
      const tWait = tStart - tQueue;
      console.log(`[smart-preview] ${key.slice(0, 24)}… size=${size} dcraw=${tDcraw}ms sharp=${tSharp}ms total=${tTotal}ms (queue-wait=${tWait}ms, raw-in=${rawInSize}B, tiff-out=${final.length}B)`);
      return { bytes: final, width, height };
    } catch (e) {
      await fs.unlink(stagingPath).catch(() => {});
      throw e;
    }
  });
  return { ...result, tmpTiff };
}

export async function getOrCreateSmartPreviewFromFile(
  sourcePath: string,
  key: string,
  size: number,
): Promise<{ bytes: Buffer; width: number; height: number; cacheHit: boolean }> {
  const cachedPath = smartPreviewPath(key, size);
  try {
    const bytes = await fs.readFile(cachedPath);
    fs.utimes(cachedPath, new Date(), new Date()).catch(() => {});
    return { bytes, width: 0, height: 0, cacheHit: true };
  } catch { /* cache miss */ }

  const sourceStat = await fs.stat(sourcePath);
  const tmpRaw = createRawTempPath('library');
  let tmpTiff = '';
  try {
    await fs.copyFile(sourcePath, tmpRaw);
    const generated = await generateSmartPreview(tmpRaw, key, size, sourceStat.size);
    tmpTiff = generated.tmpTiff;
    evictIfNeeded().catch(() => {});
    return {
      bytes: generated.bytes,
      width: generated.width,
      height: generated.height,
      cacheHit: false,
    };
  } finally {
    await fs.unlink(tmpRaw).catch(() => {});
    if (tmpTiff) await fs.unlink(tmpTiff).catch(() => {});
  }
}

/**
 * POST /api/raw/smart-preview?size=1200&key=<safe-key>
 * Body: RAW file binary
 *
 * Generates a 16-bit linear TIFF (LZW-compressed) with embedded camera
 * metadata. Used for sources where the file lives client-side (LocalSource,
 * FileList) or whose access depends on browser SDK state. For
 * server-fetchable sources (Immich, Lychee, …) prefer the from-url
 * variant below — it saves the 2x 25-50 MB round-trip through the
 * user's network.
 *
 * Clients ask `GET /smart-preview/:key` first (F054), so a warm cache never
 * costs an upload; the cache-hit branch here stays for the case that two tabs
 * open the same RAW at once and both miss that probe.
 */
rawRouter.post('/smart-preview', async (req: Request, res: Response) => {
  const size = parsePreviewSize(req.query.size);
  const key = safeKey(String(req.query.key ?? ''));
  if (!key) {
    res.status(400).json({ error: 'invalid or missing key (alphanumeric/dash/underscore, max 200 chars)' });
    return;
  }

  const cachedPath = smartPreviewPath(key, size);

  // Cache-hit path
  try {
    const buf = await fs.readFile(cachedPath);
    fs.utimes(cachedPath, new Date(), new Date()).catch(() => {});
    res.set('Content-Type', 'image/tiff');
    res.set('X-Cache-Key', key);
    res.set('X-Cache-Hit', '1');
    res.send(buf);
    return;
  } catch { /* not cached → generate */ }

  // Buffer the upload first; we need both the bytes and a tmp file path
  // (dcraw_emu requires a file argument).
  const tmpRaw = createRawTempPath('smart-preview');
  let tmpTiff = '';
  try {
    const buffer = await readRequestBody(req, RAW_MAX_UPLOAD_BYTES);
    if (buffer.length === 0) {
      res.status(400).json({ error: 'empty body' });
      return;
    }
    await fs.writeFile(tmpRaw, buffer);

    const generated = await generateSmartPreview(tmpRaw, key, size, buffer.length);
    tmpTiff = generated.tmpTiff;

    evictIfNeeded().catch(() => {});

    res.set('Content-Type', 'image/tiff');
    res.set('X-Cache-Key', key);
    res.set('X-Cache-Hit', '0');
    res.set('X-Image-Width', String(generated.width));
    res.set('X-Image-Height', String(generated.height));
    res.send(generated.bytes);
  } catch (e) {
    sendRawError(res, 'raw.smart-preview', 'Smart preview generation failed', e);
  } finally {
    await fs.unlink(tmpRaw).catch(() => {});
    if (tmpTiff) await fs.unlink(tmpTiff).catch(() => {});
  }
});

/**
 * POST /api/raw/smart-preview-from-url
 * Body (JSON): { url: string; headers?: Record<string,string>; method?: 'GET'|'POST'; size?: number; key: string }
 *
 * Server-side fetch path. The backend pulls the RAW from the given URL
 * (typically the source provider's "original" endpoint) using the
 * supplied headers, then runs the same dcraw_emu→sharp→exiftool
 * pipeline as /smart-preview and returns the resized TIFF.
 *
 * Massive perf win on remote sources: the RAW never travels through the
 * user's network. Only the final 5-7 MB TIFF reaches the browser.
 *
 * Backend → source is server-to-server: for self-host where
 * PhotoLib lives next to Immich on the same docker host this is
 * instant; for SaaS over a remote Immich it's still much faster than
 * routing through the user's home upstream.
 */
rawRouter.post('/smart-preview-from-url', expressJson({ limit: '8kb' }), async (req: Request, res: Response) => {
  const size = parsePreviewSize(req.query.size ?? req.body?.size);
  const key = safeKey(String(req.query.key ?? req.body?.key ?? ''));
  if (!key) {
    res.status(400).json({ error: 'invalid or missing key (alphanumeric/dash/underscore, max 200 chars)' });
    return;
  }
  const body = req.body as { url?: unknown; headers?: unknown; method?: unknown };
  if (typeof body?.url !== 'string') {
    res.status(400).json({ error: 'missing url' });
    return;
  }

  const cachedPath = smartPreviewPath(key, size);
  try {
    const buf = await fs.readFile(cachedPath);
    fs.utimes(cachedPath, new Date(), new Date()).catch(() => {});
    res.set('Content-Type', 'image/tiff');
    res.set('X-Cache-Key', key);
    res.set('X-Cache-Hit', '1');
    res.send(buf);
    return;
  } catch { /* not cached → fetch + generate */ }

  const method = (typeof body.method === 'string' ? body.method.toUpperCase() : 'GET');
  if (method !== 'GET' && method !== 'POST') {
    res.status(400).json({ error: 'method must be GET or POST' });
    return;
  }
  const headerObj: Record<string, string> = {};
  if (body.headers && typeof body.headers === 'object') {
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      if (typeof v === 'string' && isForwardableUpstreamHeader(k, v)) headerObj[k] = v;
    }
  }

  const tmpRaw = createRawTempPath('url');
  let tmpTiff = '';
  try {
    const tFetch0 = Date.now();
    const upstream = await requestNetworkBufferForClient(req, res, body.url, {
      method,
      headers: headerObj,
      timeoutMs: RAW_FETCH_TIMEOUT_MS,
      maxResponseBytes: RAW_MAX_REMOTE_BYTES,
      policy: RAW_FETCH_POLICY,
    });
    if (upstream.status < 200 || upstream.status >= 300) {
      res.status(502).json({ error: `Upstream ${upstream.status} fetching source` });
      return;
    }
    const upstreamBuf = upstream.body;
    const tFetch = Date.now() - tFetch0;
    if (upstreamBuf.length === 0) {
      res.status(502).json({ error: 'Upstream returned empty body' });
      return;
    }
    await fs.writeFile(tmpRaw, upstreamBuf);
    console.log(`[smart-preview-from-url] fetched ${upstreamBuf.length}B in ${tFetch}ms`);

    const generated = await generateSmartPreview(tmpRaw, key, size, upstreamBuf.length);
    tmpTiff = generated.tmpTiff;

    evictIfNeeded().catch(() => {});

    res.set('Content-Type', 'image/tiff');
    res.set('X-Cache-Key', key);
    res.set('X-Cache-Hit', '0');
    res.set('X-Image-Width', String(generated.width));
    res.set('X-Image-Height', String(generated.height));
    res.send(generated.bytes);
  } catch (e) {
    sendRawError(res, 'raw.smart-preview-from-url', 'Smart preview generation failed', e);
  } finally {
    await fs.unlink(tmpRaw).catch(() => {});
    if (tmpTiff) await fs.unlink(tmpTiff).catch(() => {});
  }
});

/**
 * GET /api/raw/smart-preview/:key?size=1200
 * Returns the cached TIFF or 404 if not generated yet.
 */
rawRouter.get('/smart-preview/:key', async (req: Request, res: Response) => {
  const size = parsePreviewSize(req.query.size);
  const rawKey = req.params.key;
  const key = safeKey(typeof rawKey === 'string' ? rawKey : Array.isArray(rawKey) ? rawKey[0] ?? '' : '');
  if (!key) {
    res.status(400).json({ error: 'invalid key' });
    return;
  }
  const p = smartPreviewPath(key, size);
  try {
    const buf = await fs.readFile(p);
    fs.utimes(p, new Date(), new Date()).catch(() => {});
    res.set('Content-Type', 'image/tiff');
    res.set('X-Cache-Key', key);
    res.set('X-Cache-Hit', '1');
    res.send(buf);
  } catch {
    res.status(404).json({ error: 'not cached', hint: 'POST /api/raw/smart-preview with body=RAW first' });
  }
});

class RawBodyTooLargeError extends Error {}

async function readRequestBody(req: Request, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(req.header('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    req.resume();
    throw new RawBodyTooLargeError(`RAW body exceeds ${maxBytes} bytes`);
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    received += buffer.length;
    if (received > maxBytes) {
      req.resume();
      throw new RawBodyTooLargeError(`RAW body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, received);
}

function createRawTempPath(label: string): string {
  return path.join(RAW_TMPDIR, `${RAW_TMP_PREFIX}${label}-${randomUUID()}.raw`);
}

export function parsePreviewSize(value: unknown): number {
  const parsed = Number(value ?? 1200);
  if (!Number.isFinite(parsed)) return 1200;
  return Math.max(200, Math.min(SMART_PREVIEW_MAX_PX, Math.round(parsed)));
}

function sendRawError(res: Response, scope: string, message: string, error: unknown): void {
  if (res.destroyed) return;
  if (error instanceof RawBodyTooLargeError) {
    res.status(413).json({ error: 'RAW upload is too large' });
    return;
  }
  if (error instanceof DecodeQueueFullError) {
    res.set('Retry-After', '5');
    res.status(503).json({ error: 'RAW decode queue is full' });
    return;
  }
  if (error instanceof NetworkTargetError) {
    res.status(403).json({ error: error.message });
    return;
  }
  if (error instanceof NetworkResponseTooLargeError) {
    res.status(502).json({ error: 'Remote RAW file is too large' });
    return;
  }
  sendError(res, scope, 500, message, error);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
