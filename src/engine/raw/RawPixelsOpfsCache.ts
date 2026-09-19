/**
 * OPFS cache for 16-bit RAW pixel buffers (Phase 1.D).
 *
 * Path convention: `pixels/{contentHash}-{shortEdge}.bin`
 *   shortEdge ∈ {'240' | '800' | 'full'}
 *
 * File format (binary, little-endian):
 *   bytes 0–3   : magic "RWPX"
 *   byte  4     : version (currently 1)
 *   bytes 5–8   : width  (uint32)
 *   bytes 9–12  : height (uint32)
 *   byte  13    : channels (3 or 4)
 *   bytes 14–25 : legacy WB gains (3 × float32) — all zeros = null
 *   bytes 26–61 : legacy color matrix (9 × float32) — all zeros = null
 *   bytes 62+   : deflate-compressed Uint16 RGB(A) pixel buffer
 *
 * The calibration slots remain to preserve binary v1 and synthetic-source
 * support. Productive decoders bake camera WB + camera→sRGB and write null;
 * SmartPreviewStrategy also normalizes older cache entries to null on read.
 *
 * Compression: native `CompressionStream('deflate')` — no external dep.
 * Plan-doc calls for LZ4 but deflate is shipped in every browser and
 * yields comparable ratios on 16-bit pixel data. Re-evaluate if compress
 * latency becomes the bottleneck.
 *
 * LRU: maintained in a separate `pixels/_index.json` keyed on
 * `${contentHash}|${shortEdge}` with byte size + lastAccess (epoch ms).
 * Total cap is the constructor's `maxBytes` (default 2 GB per plan).
 */
import type { RawPixelData } from './RawDecoderStrategy';

/** Bucket label. Plan-spec values are '240' | '800' | 'full' for the
 *  3-tier cache; we also accept the smart-preview-size labels ('1200',
 *  '1800', '2540') so the SmartPreviewStrategy can key its post-decode
 *  cache without an extra mapping layer. */
export type ShortEdgeBucket = string;

/** Plan-spec canonical tiers. New code should prefer these over raw
 *  smart-preview-size strings; SmartPreviewStrategy still uses its size
 *  labels for backward-compat with already-written cache entries. */
export const PLAN_BUCKETS = ['240', '800', 'full'] as const;
export type PlanBucket = typeof PLAN_BUCKETS[number];

/** Choose the right plan-bucket for a consumer's intent. */
export function bucketForConsumer(intent: 'thumb' | 'editor-quick-open' | 'full'): PlanBucket {
  switch (intent) {
    case 'thumb':            return '240';
    case 'editor-quick-open':return '800';
    case 'full':             return 'full';
  }
}

const MAGIC = new Uint8Array([0x52, 0x57, 0x50, 0x58]); // 'RWPX'
const VERSION = 1;
const HEADER_BYTES = 62;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** Cap of `smart-previews/` (F087), the same as this store; not configurable yet. */
export const SMART_PREVIEW_MAX_BYTES = 2 * 1024 * 1024 * 1024;
// v2: file names carry an FNV-1a hash of the FULL cache key. v1 names were
// plain 96-char truncations — two long keys sharing a prefix silently mapped
// to the same .bin (wrong pixels served). A missing v2 index wipes the dir.
const INDEX_FILE = '_index.v2.json';
const INDEX_LOCK = 'photolib-rawpixels-index';
/** Index key of a file whose cache key is unknown because the index was
 *  rebuilt from the listing; the hashed name does not give the key back. */
const FILE_KEY_PREFIX = '__file:';

interface IndexEntry {
  bytes: number;
  lastAccess: number;
}

type IndexMap = Record<string, IndexEntry>;

export class RawPixelsOpfsCache {
  private readonly rootDir: string;
  private readonly maxBytes: number;
  /** Lazy: resolved on first call to ensureRoot(). */
  private rootHandle: Promise<FileSystemDirectoryHandle> | null = null;
  /** In-memory index mirror; flushed to OPFS on write. */
  private indexCache: IndexMap | null = null;
  /** One disk read for all callers that race the first access. */
  private indexLoad: Promise<IndexMap> | null = null;
  /** Keys deleted locally since the last flush — must not be resurrected
   *  by the disk-merge in flushIndex(). */
  private readonly pendingDeletes = new Set<string>();
  /** Debounce handle for lastAccess-only flushes (get() touches). */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rootDir = 'pixels', maxBytes: number = DEFAULT_MAX_BYTES) {
    this.rootDir = rootDir;
    this.maxBytes = maxBytes;
  }

  // ─── Public API ─────────────────────────────────────────────────

  async get(contentHash: string, shortEdge: ShortEdgeBucket): Promise<RawPixelData | null> {
    const key = entryKey(contentHash, shortEdge);
    const name = fileName(contentHash, shortEdge);
    try {
      const root = await this.ensureRoot();
      const fileHandle = await root.getFileHandle(name);
      const file = await fileHandle.getFile();
      const buffer = await file.arrayBuffer();
      const decoded = await decode(buffer);
      // Touch lastAccess in-memory; flush debounced — a warm-cache read
      // must not pay a full index rewrite.
      const idx = await this.ensureIndex();
      const prev = idx[key] ?? idx[fileKey(name)];
      if (prev) {
        idx[key] = { ...prev, lastAccess: Date.now() };
        this.dropFileKey(idx, name);
        this.scheduleFlush();
      }
      return decoded;
    } catch (e) {
      if ((e as DOMException)?.name === 'NotFoundError') return null;
      console.warn('[RawPixelsOpfsCache] get failed for', name, e);
      return null;
    }
  }

  /** Index lookup only, no file read. */
  async has(contentHash: string, shortEdge: ShortEdgeBucket): Promise<boolean> {
    const idx = await this.ensureIndex();
    return entryKey(contentHash, shortEdge) in idx || fileKey(fileName(contentHash, shortEdge)) in idx;
  }

  async put(contentHash: string, shortEdge: ShortEdgeBucket, data: RawPixelData): Promise<void> {
    if (data.bits !== 16 || !(data.data instanceof Uint16Array)) {
      throw new Error('RawPixelsOpfsCache.put: only 16-bit Uint16Array data supported');
    }
    const key = entryKey(contentHash, shortEdge);
    const name = fileName(contentHash, shortEdge);
    // Load the index first: in a store without one, loading wipes the
    // directory, and would take the file written below with it.
    await this.ensureIndex();
    const buffer = await encode(data);
    const root = await this.ensureRoot();
    const fileHandle = await root.getFileHandle(name, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      // Cast: FileSystemWritableFileStream.write accepts ArrayBuffer/ArrayBufferView
      // at runtime; the lib.dom.d.ts narrowing on ArrayBuffer vs ArrayBufferLike
      // is overly strict for our typed-array path.
      await writable.write(buffer as unknown as BufferSource);
    } finally {
      await writable.close();
    }
    await this.updateIndex((idx) => {
      idx[key] = { bytes: buffer.byteLength, lastAccess: Date.now() };
      this.pendingDeletes.delete(key);
      this.dropFileKey(idx, name);
    });
    await this.evictIfOverCap();
  }

  /**
   * Evict one or all buckets for `contentHash`. When `shortEdge` is omitted
   * the index is scanned for matching entries.
   */
  async evict(contentHash: string, shortEdge?: ShortEdgeBucket): Promise<void> {
    const root = await this.ensureRoot();
    if (shortEdge) {
      const name = fileName(contentHash, shortEdge);
      try { await root.removeEntry(name); } catch { /* */ }
      await this.updateIndex((idx) => {
        delete idx[entryKey(contentHash, shortEdge)];
        this.pendingDeletes.add(entryKey(contentHash, shortEdge));
      });
      return;
    }
    const idx = await this.ensureIndex();
    const prefix = `${contentHash}|`;
    const matching = Object.keys(idx).filter((k) => k.startsWith(prefix));
    for (const key of matching) {
      const bucket = key.slice(prefix.length);
      try { await root.removeEntry(fileName(contentHash, bucket)); } catch { /* */ }
      delete idx[key];
      this.pendingDeletes.add(key);
    }
    await this.flushIndex();
  }

  /** Entries with a known key; files only known from a rebuilt listing are left out. */
  async listEntries(): Promise<Array<{ contentHash: string; shortEdge: ShortEdgeBucket }>> {
    const idx = await this.ensureIndex();
    const entries: Array<{ contentHash: string; shortEdge: ShortEdgeBucket }> = [];
    for (const key of Object.keys(idx)) {
      const parsed = parseEntryKey(key);
      if (parsed) entries.push(parsed);
    }
    return entries;
  }

  /** Evicts every entry with a known key that the predicate selects. */
  async evictWhere(predicate: (contentHash: string, shortEdge: ShortEdgeBucket) => boolean): Promise<number> {
    const idx = await this.ensureIndex();
    const root = await this.ensureRoot();
    let removed = 0;
    for (const key of Object.keys(idx)) {
      const parsed = parseEntryKey(key);
      if (!parsed || !predicate(parsed.contentHash, parsed.shortEdge)) continue;
      try { await root.removeEntry(fileName(parsed.contentHash, parsed.shortEdge)); } catch { /* */ }
      delete idx[key];
      this.pendingDeletes.add(key);
      removed++;
    }
    if (removed > 0) await this.flushIndex();
    return removed;
  }

  /**
   * Moves every bucket of `oldHash` to `newHash` (F087: a photo's cache key
   * changes when its contentHash arrives). A bucket already present under the
   * new key wins; the old copy goes either way unless copying it failed.
   */
  async rename(oldHash: string, newHash: string): Promise<number> {
    if (oldHash === newHash) return 0;
    const idx = await this.ensureIndex();
    const root = await this.ensureRoot();
    const keyPrefix = `${oldHash}|`;
    const placeholderPrefix = fileKey(fileNamePrefix(oldHash));
    const buckets: Array<{ key: string; bucket: ShortEdgeBucket; entry: IndexEntry }> = [];
    for (const [key, entry] of Object.entries(idx)) {
      if (key.startsWith(keyPrefix)) {
        buckets.push({ key, bucket: key.slice(keyPrefix.length), entry });
      } else if (key.startsWith(placeholderPrefix) && key.endsWith('.bin')) {
        buckets.push({ key, bucket: key.slice(placeholderPrefix.length, -'.bin'.length), entry });
      }
    }
    let moved = 0;
    for (const { key, bucket, entry } of buckets) {
      const from = fileName(oldHash, bucket);
      const toKey = entryKey(newHash, bucket);
      if (!(toKey in idx)) {
        try {
          await copyFileWithin(root, from, fileName(newHash, bucket));
          idx[toKey] = { ...entry };
          this.pendingDeletes.delete(toKey);
          moved++;
        } catch (e) {
          if ((e as DOMException)?.name !== 'NotFoundError') {
            console.warn('[RawPixelsOpfsCache] rename failed for', from, e);
            continue;
          }
        }
      }
      try { await root.removeEntry(from); } catch { /* */ }
      delete idx[key];
      this.pendingDeletes.add(key);
    }
    if (buckets.length > 0) await this.flushIndex();
    return moved;
  }

  /**
   * Drops the in-memory index after the files were deleted behind this
   * instance's back ("Cache leeren" empties the directory directly); without
   * it has() kept reporting the deleted buckets as present.
   */
  forgetIndex(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.indexCache = null;
    this.pendingDeletes.clear();
  }

  async totalBytes(): Promise<number> {
    const idx = await this.ensureIndex();
    let sum = 0;
    for (const k in idx) sum += idx[k].bytes;
    return sum;
  }

  /** Evict least-recently-accessed entries until total ≤ targetMax. */
  async lruEvictTo(targetMax: number): Promise<void> {
    const idx = await this.ensureIndex();
    const entries = Object.entries(idx).sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    let total = entries.reduce((s, [, v]) => s + v.bytes, 0);
    const root = await this.ensureRoot();
    for (const [key, entry] of entries) {
      if (total <= targetMax) break;
      const name = fileNameOfKey(key);
      if (name) {
        try { await root.removeEntry(name); } catch { /* */ }
      }
      total -= entry.bytes;
      delete idx[key];
      this.pendingDeletes.add(key);
    }
    await this.flushIndex();
  }

  // ─── Internals ──────────────────────────────────────────────────

  private async ensureRoot(): Promise<FileSystemDirectoryHandle> {
    if (this.rootHandle) return this.rootHandle;
    this.rootHandle = (async () => {
      const opfs = await navigator.storage.getDirectory();
      return opfs.getDirectoryHandle(this.rootDir, { create: true });
    })();
    return this.rootHandle;
  }

  private async ensureIndex(): Promise<IndexMap> {
    if (this.indexCache) return this.indexCache;
    this.indexLoad ??= this.withIndexLock('shared', () => this.loadIndex())
      .finally(() => { this.indexLoad = null; });
    const loaded = await this.indexLoad;
    this.indexCache ??= loaded;
    return this.indexCache;
  }

  /**
   * No v2 index: fresh cache OR a v1 store with collision-prone file names +
   * now-unreachable entries — wipe and let the cache refill. Any other
   * failure (an empty file after a crash, a read racing another tab's write)
   * must not cost the whole store (F123): rebuild from the listing instead.
   */
  private async loadIndex(): Promise<IndexMap> {
    const root = await this.ensureRoot();
    let handle: FileSystemFileHandle;
    try {
      handle = await root.getFileHandle(INDEX_FILE);
    } catch (e) {
      if ((e as DOMException)?.name === 'NotFoundError') {
        await this.wipeDirectory();
        return {};
      }
      return this.rebuildIndexFromDirectory(e);
    }
    try {
      return parseIndex(await (await handle.getFile()).text());
    } catch (e) {
      return this.rebuildIndexFromDirectory(e);
    }
  }

  private async rebuildIndexFromDirectory(cause: unknown): Promise<IndexMap> {
    console.warn('[RawPixelsOpfsCache] index unreadable, rebuilding it from the directory:', cause);
    const idx: IndexMap = {};
    try {
      const root = await this.ensureRoot();
      for await (const [name, handle] of root as unknown as AsyncIterable<[string, FileSystemHandle]>) {
        if (name === INDEX_FILE || handle.kind !== 'file') continue;
        try {
          const file = await (handle as FileSystemFileHandle).getFile();
          idx[fileKey(name)] = { bytes: file.size, lastAccess: file.lastModified };
        } catch { /* unreadable too: left to the next clear */ }
      }
    } catch (e) {
      console.warn('[RawPixelsOpfsCache] listing for the rebuild failed:', e);
    }
    // Writes the repaired index once the load has handed it over.
    this.scheduleFlush();
    return idx;
  }

  private async wipeDirectory(): Promise<void> {
    try {
      const root = await this.ensureRoot();
      const iter = (root as unknown as { keys(): AsyncIterableIterator<string> }).keys();
      const names: string[] = [];
      for await (const name of iter) names.push(name);
      for (const name of names) {
        try { await root.removeEntry(name); } catch { /* best-effort */ }
      }
    } catch { /* best-effort — a failed wipe only means stale orphans */ }
  }

  private dropFileKey(idx: IndexMap, name: string): void {
    const key = fileKey(name);
    if (!(key in idx)) return;
    delete idx[key];
    this.pendingDeletes.add(key);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushIndex().catch((e) => {
        console.warn('[RawPixelsOpfsCache] debounced index flush failed:', e);
      });
    }, 2000);
  }

  private async updateIndex(mutate: (idx: IndexMap) => void): Promise<void> {
    const idx = await this.ensureIndex();
    mutate(idx);
    await this.flushIndex();
  }

  private async withIndexLock<T>(mode: LockMode, run: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return (await navigator.locks.request(INDEX_LOCK, { mode }, run)) as T;
    }
    return run();
  }

  /**
   * Serialized (Web Locks, when available) read-merge-write: another tab's
   * entries survive our flush; our pendingDeletes tombstones keep locally
   * evicted keys from being resurrected by the merge.
   */
  private async flushIndex(): Promise<void> {
    const mem = this.indexCache;
    if (!mem) return;
    const write = async () => {
      const root = await this.ensureRoot();
      let disk: IndexMap = {};
      try {
        const fh = await root.getFileHandle(INDEX_FILE);
        disk = JSON.parse(await (await fh.getFile()).text()) as IndexMap;
      } catch { /* first write */ }
      const merged: IndexMap = { ...disk, ...mem };
      for (const key of this.pendingDeletes) delete merged[key];
      this.pendingDeletes.clear();
      this.indexCache = merged;
      const fh = await root.getFileHandle(INDEX_FILE, { create: true });
      const writable = await fh.createWritable();
      try {
        await writable.write(JSON.stringify(merged));
      } finally {
        await writable.close();
      }
    };
    await this.withIndexLock('exclusive', write);
  }

  private async evictIfOverCap(): Promise<void> {
    const total = await this.totalBytes();
    if (total > this.maxBytes) await this.lruEvictTo(this.maxBytes);
  }
}

/** Copies a file within one directory; a failed write leaves no partial copy. */
export async function copyFileWithin(dir: FileSystemDirectoryHandle, from: string, to: string): Promise<void> {
  const source = await (await dir.getFileHandle(from)).getFile();
  const writable = await (await dir.getFileHandle(to, { create: true })).createWritable();
  try {
    await writable.write(source);
  } catch (e) {
    await writable.abort().catch(() => {});
    await dir.removeEntry(to).catch(() => {});
    throw e;
  }
  await writable.close();
}

// ─── File-format encode / decode ──────────────────────────────────

async function encode(data: RawPixelData): Promise<Uint8Array> {
  const pixels = data.data as Uint16Array;
  const compressed = await compressDeflate(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  const out = new Uint8Array(HEADER_BYTES + compressed.byteLength);
  const view = new DataView(out.buffer);
  out.set(MAGIC, 0);
  view.setUint8(4, VERSION);
  view.setUint32(5, data.width, true);
  view.setUint32(9, data.height, true);
  view.setUint8(13, data.channels);
  if (data.asShotNeutral) {
    view.setFloat32(14, data.asShotNeutral[0], true);
    view.setFloat32(18, data.asShotNeutral[1], true);
    view.setFloat32(22, data.asShotNeutral[2], true);
  }
  if (data.colorMatrix && data.colorMatrix.length >= 9) {
    for (let i = 0; i < 9; i++) view.setFloat32(26 + i * 4, data.colorMatrix[i], true);
  }
  out.set(compressed, HEADER_BYTES);
  return out;
}

async function decode(buffer: ArrayBuffer): Promise<RawPixelData> {
  const view = new DataView(buffer);
  for (let i = 0; i < 4; i++) {
    if (view.getUint8(i) !== MAGIC[i]) throw new Error('RawPixelsOpfsCache.decode: bad magic');
  }
  const version = view.getUint8(4);
  if (version !== VERSION) throw new Error(`RawPixelsOpfsCache.decode: unsupported version ${version}`);
  const width = view.getUint32(5, true);
  const height = view.getUint32(9, true);
  const channels = view.getUint8(13) as 3 | 4;
  const asn0 = view.getFloat32(14, true);
  const asn1 = view.getFloat32(18, true);
  const asn2 = view.getFloat32(22, true);
  const asShotNeutral: [number, number, number] | null =
    (asn0 === 0 && asn1 === 0 && asn2 === 0) ? null : [asn0, asn1, asn2];
  const cm: number[] = [];
  let cmAllZero = true;
  for (let i = 0; i < 9; i++) {
    const v = view.getFloat32(26 + i * 4, true);
    cm.push(v);
    if (v !== 0) cmAllZero = false;
  }
  const colorMatrix = cmAllZero ? null : cm;

  const compressed = new Uint8Array(buffer, HEADER_BYTES);
  const pixelsBytes = await decompressDeflate(compressed);
  // Re-view the bytes as Uint16. Ensure the buffer is properly aligned
  // by copying into a fresh ArrayBuffer if needed.
  const alignedBuffer = pixelsBytes.byteOffset % 2 === 0
    ? pixelsBytes.buffer
    : new Uint8Array(pixelsBytes).buffer;
  const pixels = new Uint16Array(
    alignedBuffer,
    pixelsBytes.byteOffset % 2 === 0 ? pixelsBytes.byteOffset : 0,
    pixelsBytes.byteLength / 2,
  );

  return { data: pixels, width, height, channels, bits: 16, colorMatrix, asShotNeutral };
}

async function compressDeflate(input: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([input as BlobPart]);
  const stream = blob.stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(compressed);
}

async function decompressDeflate(input: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([input as BlobPart]);
  const stream = blob.stream().pipeThrough(new DecompressionStream('deflate'));
  const decompressed = await new Response(stream).arrayBuffer();
  return new Uint8Array(decompressed);
}

// ─── Helpers ──────────────────────────────────────────────────────

function parseIndex(text: string): IndexMap {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('RawPixelsOpfsCache: index is not an object');
  }
  return parsed as IndexMap;
}

function fileNamePrefix(contentHash: string): string {
  // Sanitize + truncate for filesystem safety; the FNV-1a hash of the FULL
  // hash keeps distinct long keys distinct (truncation alone collided).
  const safe = contentHash.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `${safe}-${fnv1a32(contentHash)}-`;
}

function fileName(contentHash: string, shortEdge: ShortEdgeBucket): string {
  return `${fileNamePrefix(contentHash)}${shortEdge}.bin`;
}

function fnv1a32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function entryKey(contentHash: string, shortEdge: ShortEdgeBucket): string {
  return `${contentHash}|${shortEdge}`;
}

function fileKey(name: string): string {
  return `${FILE_KEY_PREFIX}${name}`;
}

function parseEntryKey(key: string): { contentHash: string; shortEdge: ShortEdgeBucket } | null {
  if (key.startsWith(FILE_KEY_PREFIX)) return null;
  const bar = key.lastIndexOf('|');
  if (bar < 0) return null;
  return { contentHash: key.slice(0, bar), shortEdge: key.slice(bar + 1) };
}

function fileNameOfKey(key: string): string | null {
  if (key.startsWith(FILE_KEY_PREFIX)) return key.slice(FILE_KEY_PREFIX.length);
  const parsed = parseEntryKey(key);
  return parsed ? fileName(parsed.contentHash, parsed.shortEdge) : null;
}

// ─── Lazy default singleton ───────────────────────────────────────

let _defaultCache: RawPixelsOpfsCache | null = null;

export function getDefaultRawPixelsCache(): RawPixelsOpfsCache {
  if (_defaultCache) return _defaultCache;
  _defaultCache = new RawPixelsOpfsCache();
  return _defaultCache;
}
