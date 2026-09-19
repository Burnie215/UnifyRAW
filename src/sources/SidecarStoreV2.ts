/**
 * SidecarStoreV2 — split architecture: index.json + per-subfolder thumb bins.
 *
 * Structure in .photolib/:
 *   index.json              — all metadata (EXIF, edits, blurHash, ratings)
 *   thumbs/
 *     _root.bin             — thumbnails for photos in root directory
 *     _dir_Urlaub%202024.bin — thumbnails for /Urlaub 2024/
 *     _dir_Urlaub%202024%2FStrand.bin — thumbnails for /Urlaub 2024/Strand/
 *
 * Thumb bin format: [jpeg1][jpeg2]...
 *   Offsets tracked in index.json per photo: { t: [binOffset, size] }
 *   Each bin is append-only — no rewrites on new thumbs.
 *
 * Benefits over V1 (.dat):
 *   - index.json is pure JSON — exportable, importable, diffable
 *   - Thumb writes only append to small bin files (not rewrite entire blob)
 *   - No concurrent write conflicts between different subfolders
 *   - Safari can import/export index.json via download/upload
 */

// ─── Types ───

export interface PhotoMeta {
  /** Thumbnail: [offset in bin, size in bytes] */
  t?: [number, number];
  /** Thumbnail bin naming version; absent means the legacy lossy name. */
  tb?: 2;
  /** BlurHash */
  b?: string;
  w?: number;            // width
  h?: number;            // height
  c?: string | null;     // camera
  l?: string | null;     // lens
  i?: number | null;     // iso
  f?: number | null;     // focalLength
  a?: string | null;     // aperture
  s?: string | null;     // shutterSpeed
  d?: number;            // dateTaken
  k?: string[];          // keywords
  la?: number;           // latitude
  lo?: number;           // longitude
  ch?: string;           // contentHash
  e?: string;            // edit sidecar JSON
}

export interface SidecarIndex {
  version: 2;
  entries: Record<string, PhotoMeta>;
}

// ─── Helpers ───

/** Convert a photo path to its collision-free subfolder bin name.
 *  "Urlaub 2024/Strand/IMG.jpg" → "_dir_Urlaub%202024%2FStrand"
 *  "IMG.jpg" (root) → "_root"
 */
function pathToBinName(photoPath: string): string {
  const lastSlash = photoPath.lastIndexOf('/');
  if (lastSlash < 0) return '_root';
  const dir = photoPath.substring(0, lastSlash);
  return `_dir_${encodeURIComponent(dir)}`;
}

function legacyPathToBinName(photoPath: string): string {
  const lastSlash = photoPath.lastIndexOf('/');
  if (lastSlash < 0) return '_root';
  const dir = photoPath.substring(0, lastSlash);
  return dir.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/\//g, '~');
}

// ─── SidecarStoreV2 ───

export class SidecarStoreV2 {
  private dirHandle: FileSystemDirectoryHandle;
  private index: SidecarIndex | null = null;
  private _thumbCount = 0;

  /** Track bin sizes per subfolder (append offset) */
  private binSizes = new Map<string, number>();

  /** Per-bin write lock */
  private binWriting = new Set<string>();
  private binQueues = new Map<string, (() => void)[]>();

  /** Index flush state */
  private indexDirty = false;
  private indexFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private indexWriting = false;

  constructor(dirHandle: FileSystemDirectoryHandle) {
    this.dirHandle = dirHandle;
  }

  // ─── Init ───

  async init(): Promise<void> {
    if (this.index) return;
    try {
      const plDir = await this.dirHandle.getDirectoryHandle('.photolib');
      const handle = await plDir.getFileHandle('index.json');
      const file = await handle.getFile();
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (parsed.version === 2) {
        this.index = parsed as SidecarIndex;
      } else {
        this.index = { version: 2, entries: {} };
      }
    } catch {
      this.index = { version: 2, entries: {} };
    }
    this._thumbCount = Object.values(this.index.entries).filter((e) => !!e.t).length;
  }

  // ─── Index access ───

  async getIndex(): Promise<Record<string, PhotoMeta>> {
    await this.init();
    return this.index!.entries;
  }

  async count(): Promise<number> {
    await this.init();
    return Object.keys(this.index!.entries).length;
  }

  async thumbCount(): Promise<number> {
    await this.init();
    return this._thumbCount;
  }

  get thumbCountSync(): number {
    return this._thumbCount;
  }

  async hasThumb(photoPath: string): Promise<boolean> {
    await this.init();
    return !!this.index!.entries[photoPath]?.t;
  }

  async getMeta(photoPath: string): Promise<PhotoMeta | null> {
    await this.init();
    return this.index!.entries[photoPath] ?? null;
  }

  async setMeta(photoPath: string, meta: Partial<PhotoMeta>): Promise<void> {
    await this.init();
    const existing = this.index!.entries[photoPath] ?? {};
    this.index!.entries[photoPath] = { ...existing, ...meta };
    this.scheduleIndexFlush();
  }

  // ─── Thumbnail read ───

  async readThumb(photoPath: string): Promise<Blob | null> {
    await this.init();
    const entry = this.index!.entries[photoPath];
    if (!entry?.t) return null;

    const [offset, size] = entry.t;
    const binName = entry.tb === 2 ? pathToBinName(photoPath) : legacyPathToBinName(photoPath);

    try {
      const plDir = await this.dirHandle.getDirectoryHandle('.photolib');
      const thumbsDir = await plDir.getDirectoryHandle('thumbs');
      const binHandle = await thumbsDir.getFileHandle(`${binName}.bin`);
      const file = await binHandle.getFile();

      if (offset + size > file.size || size === 0) return null;

      const data = await file.slice(offset, offset + size).arrayBuffer();
      const bytes = new Uint8Array(data);
      if (bytes.length < 2 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;

      return new Blob([data], { type: 'image/jpeg' });
    } catch {
      return null;
    }
  }

  // ─── Thumbnail write ───

  async writeThumb(photoPath: string, blob: Blob, meta?: Partial<PhotoMeta>): Promise<void> {
    await this.init();

    const binName = pathToBinName(photoPath);

    // Per-bin queue — different subfolders don't block each other
    if (this.binWriting.has(binName)) {
      await new Promise<void>((resolve) => {
        const q = this.binQueues.get(binName) ?? [];
        q.push(resolve);
        this.binQueues.set(binName, q);
      });
    }
    this.binWriting.add(binName);

    try {
      const thumbData = new Uint8Array(await blob.arrayBuffer());

      // Get or create bin file
      const plDir = await this.dirHandle.getDirectoryHandle('.photolib', { create: true });
      const thumbsDir = await plDir.getDirectoryHandle('thumbs', { create: true });
      const binHandle = await thumbsDir.getFileHandle(`${binName}.bin`, { create: true });

      // Get current bin size (for append offset)
      let binSize = this.binSizes.get(binName);
      if (binSize === undefined) {
        const file = await binHandle.getFile();
        binSize = file.size;
        this.binSizes.set(binName, binSize);
      }

      // Append thumbnail to bin
      let writable: FileSystemWritableFileStream;
      try {
        writable = await binHandle.createWritable({ keepExistingData: true });
        await writable.seek(binSize);
      } catch {
        // Fallback: read existing data, rewrite entire file
        const existingFile = await binHandle.getFile();
        const existingData = binSize > 0 ? new Uint8Array(await existingFile.arrayBuffer()) : new Uint8Array(0);
        writable = await binHandle.createWritable();
        if (existingData.length > 0) await writable.write(existingData);
      }
      await writable.write(thumbData);
      await writable.close();

      // Update index
      const existing = this.index!.entries[photoPath] ?? {};
      const hadThumb = !!existing.t;
      existing.t = [binSize, thumbData.length];
      existing.tb = 2;
      if (meta) Object.assign(existing, meta);
      this.index!.entries[photoPath] = existing;
      if (!hadThumb) this._thumbCount++;

      this.binSizes.set(binName, binSize + thumbData.length);
      this.scheduleIndexFlush();
    } finally {
      this.binWriting.delete(binName);
      const q = this.binQueues.get(binName);
      if (q && q.length > 0) {
        q.shift()!();
      }
    }
  }

  // ─── Index flush ───

  async flushIndex(): Promise<void> {
    if (!this.indexDirty || !this.index) return;
    if (this.indexWriting) return;
    this.indexWriting = true;
    this.indexDirty = false;

    try {
      const plDir = await this.dirHandle.getDirectoryHandle('.photolib', { create: true });
      const handle = await plDir.getFileHandle('index.json', { create: true });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(this.index, null, 0));
      await writable.close();
    } catch { /* */ } finally {
      this.indexWriting = false;
      if (this.indexDirty) this.scheduleIndexFlush();
    }
  }

  private scheduleIndexFlush() {
    this.indexDirty = true;
    if (this.indexFlushTimer) return;
    this.indexFlushTimer = setTimeout(() => {
      this.indexFlushTimer = null;
      this.flushIndex();
    }, 3000);
  }

  // ─── Export / Import (Safari fallback) ───

  /** Export index.json as downloadable file */
  exportIndex(): void {
    if (!this.index) return;
    const json = JSON.stringify(this.index, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'index.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Import index.json from file (restores metadata, edits, blurHash — not thumbs) */
  async importIndex(file: File): Promise<void> {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (parsed.version === 2) {
      this.index = parsed as SidecarIndex;
    } else {
      // Try to interpret as V1 format
      this.index = { version: 2, entries: parsed as Record<string, PhotoMeta> };
    }
    this._thumbCount = Object.values(this.index.entries).filter((e) => !!e.t).length;
    this.scheduleIndexFlush();
  }

  /** Export a single subfolder's thumb bin as downloadable file */
  async exportThumbBin(binName: string): Promise<void> {
    try {
      const plDir = await this.dirHandle.getDirectoryHandle('.photolib');
      const thumbsDir = await plDir.getDirectoryHandle('thumbs');
      const binHandle = await thumbsDir.getFileHandle(`${binName}.bin`);
      const file = await binHandle.getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${binName}.bin`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* */ }
  }

  /** Get list of all thumb bin names that exist */
  async listThumbBins(): Promise<string[]> {
    try {
      const plDir = await this.dirHandle.getDirectoryHandle('.photolib');
      const thumbsDir = await plDir.getDirectoryHandle('thumbs');
      const bins: string[] = [];
      for await (const entry of thumbsDir.values()) {
        if (entry.kind === 'file' && entry.name.endsWith('.bin')) {
          bins.push(entry.name.replace('.bin', ''));
        }
      }
      return bins;
    } catch {
      return [];
    }
  }

  // ─── Migration from V1 ───

  /** Migrate from V1 .dat format. Reads index + all thumb blobs, writes to V2 structure. */
  async migrateFromV1(sourceLabel: string): Promise<boolean> {
    try {
      const plDir = await this.dirHandle.getDirectoryHandle('.photolib');
      const fileName = sourceLabel.replace(/[^a-zA-Z0-9_-]/g, '_') + '.dat';
      const datHandle = await plDir.getFileHandle(fileName);
      const datFile = await datHandle.getFile();

      if (datFile.size < 4) return false;

      // Read V1 index
      const header = await datFile.slice(0, 4).arrayBuffer();
      const indexLen = new DataView(header).getUint32(0, true);
      if (indexLen === 0 || 4 + indexLen > datFile.size) return false;

      const indexText = await datFile.slice(4, 4 + indexLen).text();
      const v1Index = JSON.parse(indexText) as Record<string, PhotoMeta>;
      const blobStart = 4 + indexLen;

      // Build V2 index and extract thumbs into subfolder bins
      this.index = { version: 2, entries: {} };
      const thumbsDir = await plDir.getDirectoryHandle('thumbs', { create: true });

      // Group entries by bin name
      const binGroups = new Map<string, { path: string; meta: PhotoMeta }[]>();
      for (const [path, meta] of Object.entries(v1Index)) {
        const binName = pathToBinName(path);
        const group = binGroups.get(binName) ?? [];
        group.push({ path, meta });
        binGroups.set(binName, group);
      }

      // Write each bin
      for (const [binName, entries] of binGroups) {
        const binHandle = await thumbsDir.getFileHandle(`${binName}.bin`, { create: true });
        const writable = await binHandle.createWritable();
        let offset = 0;

        for (const { path, meta } of entries) {
          const v2Meta: PhotoMeta = { ...meta };

          if (meta.t) {
            const [relOffset, size] = meta.t;
            const absOffset = blobStart + relOffset;
            if (absOffset + size <= datFile.size && size > 0) {
              const thumbData = await datFile.slice(absOffset, absOffset + size).arrayBuffer();
              await writable.write(new Uint8Array(thumbData));
              v2Meta.t = [offset, size];
              v2Meta.tb = 2;
              offset += size;
            } else {
              delete v2Meta.t;
              delete v2Meta.tb;
            }
          }

          this.index.entries[path] = v2Meta;
        }

        await writable.close();
        this.binSizes.set(binName, offset);
      }

      // Also add entries without thumbs
      for (const [path, meta] of Object.entries(v1Index)) {
        if (!this.index.entries[path]) {
          this.index.entries[path] = { ...meta };
          delete this.index.entries[path].t;
          delete this.index.entries[path].tb;
        }
      }

      this._thumbCount = Object.values(this.index.entries).filter((e) => !!e.t).length;

      // Write index.json
      this.indexDirty = true;
      await this.flushIndex();

      // Rename old .dat to .dat.bak
      try {
        // File System Access API doesn't have rename — copy approach not worth it.
        // Just leave the .dat file; it won't be used anymore since index.json exists.
      } catch { /* */ }

      return true;
    } catch {
      return false;
    }
  }
}
