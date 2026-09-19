import type { ThumbSize } from './CatalogStorage';

const PREFIX_BYTES = 4;

/** Derive the 256-bucket bin id from the content hash (first hex byte). */
export function binIdForHash(hash: string): string {
  return hash.slice(0, 2).toLowerCase();
}

export interface ThumbBinLocator {
  binId: string;
  offset: number;
  length: number;
}

/** One thumbIndex row of a bin, as compaction reads it. */
export interface ThumbBinEntry {
  hash: string;
  offset: number;
  length: number;
}

export interface CompactBinResult {
  before: number;
  after: number;
  /** The bin had no slack and was left as it is. */
  skipped: boolean;
  /** Index entries that point past the end of the bin; the rewrite leaves them out. */
  dropped: string[];
}

/**
 * Manages append-only thumb-bin files in a folder-backed CatalogStorage.
 *
 * Layout:
 *   thumbs/
 *     small/{00..ff}.bin
 *     large/{00..ff}.bin
 *
 * Record format (repeating):
 *   [uint32 BE length][...length JPEG bytes...]
 *
 * thumbIndex.offset points to the start of the JPEG bytes (after the
 * prefix). thumbIndex.length is the JPEG length. The prefix exists only
 * for recovery (scan to detect torn writes).
 *
 * Concurrency: every write to a bin file, appends and compaction alike, runs
 * in that bin's queue. Two writables on one file each commit their own
 * snapshot, so a write outside the queue would undo the other one. Reads are
 * stateless and can run in parallel.
 */
export class ThumbBinStore {
  private writeQueues = new Map<string, Promise<unknown>>();
  private readonly thumbsDir: FileSystemDirectoryHandle;

  constructor(thumbsDir: FileSystemDirectoryHandle) {
    this.thumbsDir = thumbsDir;
  }

  async read(loc: ThumbBinLocator, size: ThumbSize): Promise<Blob | null> {
    const binHandle = await this.getBinFileHandle(size, loc.binId, false);
    if (!binHandle) return null;
    const file = await binHandle.getFile();
    if (loc.offset + loc.length > file.size) return null;
    // Read the bytes out rather than handing back the slice. A `file.slice`
    // blob is not a copy: it stays bound to the .bin file as it was, and the
    // browser refuses it once the file has moved on - which every append to
    // this bin and every compaction does. Tiles already on screen then failed
    // with ERR_UPLOAD_FILE_CHANGED, measured live on 2026-09-14: the grid went
    // blank while scrolling and came back for a moment after a reload.
    // SidecarStoreV2.readThumb copies its bytes out for the same reason.
    const bytes = await file.slice(loc.offset, loc.offset + loc.length).arrayBuffer();
    return new Blob([bytes], { type: 'image/jpeg' });
  }

  async append(hash: string, size: ThumbSize, blob: Blob): Promise<ThumbBinLocator> {
    const binId = binIdForHash(hash);
    return this.withBinQueue(`${size}/${binId}`, () => this.appendUnlocked(size, binId, blob));
  }

  /**
   * Rewrites one bin with just the records `listEntries()` names, in offset
   * order. Runs in the bin's queue: appends that finished before it are in
   * the index when `listEntries()` is called, appends issued meanwhile wait
   * and then read the new file size. `applyIndex` receives the moved
   * locators before the next write of the bin starts.
   */
  compactBin(
    size: ThumbSize,
    binId: string,
    listEntries: () => ThumbBinEntry[],
    applyIndex: (entries: Array<{ hash: string; loc: ThumbBinLocator }>) => void,
  ): Promise<CompactBinResult> {
    return this.withBinQueue(`${size}/${binId}`, async () => {
      const binHandle = await this.getBinFileHandle(size, binId, false);
      if (!binHandle) throw new Error(`bin ${size}/${binId} not found`);
      const file = await binHandle.getFile();

      // Sort by current offset so we read sequentially.
      const entries = [...listEntries()].sort((a, b) => a.offset - b.offset);
      const moved: Array<{ hash: string; loc: ThumbBinLocator }> = [];
      const dropped: string[] = [];
      const parts: BlobPart[] = [];
      let newOffset = 0;
      for (const e of entries) {
        if (e.offset + e.length > file.size) {
          dropped.push(e.hash);
          continue;
        }
        const prefix = new Uint8Array(PREFIX_BYTES);
        new DataView(prefix.buffer).setUint32(0, e.length, false);
        parts.push(prefix as BlobPart, file.slice(e.offset, e.offset + e.length));
        moved.push({ hash: e.hash, loc: { binId, offset: newOffset + PREFIX_BYTES, length: e.length } });
        newOffset += PREFIX_BYTES + e.length;
      }

      if (newOffset === file.size) return { before: file.size, after: file.size, skipped: true, dropped };

      const writable = await binHandle.createWritable({ keepExistingData: false });
      try {
        await writable.write(new Blob(parts));
        await writable.truncate(newOffset);
      } finally {
        await writable.close();
      }
      applyIndex(moved);
      return { before: file.size, after: newOffset, skipped: false, dropped };
    });
  }

  private withBinQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.writeQueues.get(key) ?? Promise.resolve();
    const next = prev.then(fn);
    this.writeQueues.set(key, next.catch(() => undefined));
    return next;
  }

  private async appendUnlocked(size: ThumbSize, binId: string, blob: Blob): Promise<ThumbBinLocator> {
    const binHandle = await this.getBinFileHandle(size, binId, true);
    if (!binHandle) throw new Error(`failed to open bin ${size}/${binId}`);

    const existing = await binHandle.getFile();
    const existingSize = existing.size;
    const jpegBytes = new Uint8Array(await blob.arrayBuffer());

    const prefix = new Uint8Array(PREFIX_BYTES);
    new DataView(prefix.buffer).setUint32(0, jpegBytes.byteLength, false);

    const writable = await binHandle.createWritable({ keepExistingData: true });
    try {
      await writable.seek(existingSize);
      await writable.write(new Blob([prefix as BlobPart, jpegBytes as BlobPart]));
    } finally {
      await writable.close();
    }

    return {
      binId,
      offset: existingSize + PREFIX_BYTES,
      length: jpegBytes.byteLength,
    };
  }

  private async getBinFileHandle(size: ThumbSize, binId: string, create: boolean): Promise<FileSystemFileHandle | null> {
    try {
      const sizeDir = await this.thumbsDir.getDirectoryHandle(size, { create });
      return await sizeDir.getFileHandle(`${binId}.bin`, { create });
    } catch (e) {
      if (!create && (e as DOMException).name === 'NotFoundError') return null;
      throw e;
    }
  }

  /** Wait for all queued writes to drain. Their failures already reached
   *  the caller that queued them; this only waits. */
  async drain(): Promise<void> {
    await Promise.allSettled(Array.from(this.writeQueues.values()));
  }
}
