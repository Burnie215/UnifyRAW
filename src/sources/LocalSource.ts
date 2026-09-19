import type { SourceProvider, PhotoRef, SourceBrowseItem } from './types';
import { SidecarStoreV2, type PhotoMeta } from './SidecarStoreV2';
import { pickDirectory, requestPermission } from '../platform/fs';
import { ListingFailures } from './IncompleteListingError';

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif',
  // HEIF family (Sony Alpha saves HEIF as .hif)
  'heic', 'heif', 'hif',
  // RAW formats
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng',
  'orf', 'raf', 'rw2', 'rwl', 'pef', 'ptx', 'srw', 'x3f',
]);

const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git', '.svn', '.hg',
  'Library', 'System', 'Applications',
]);

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

function mimeFromExt(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
    tiff: 'image/tiff', tif: 'image/tiff', avif: 'image/avif',
    heic: 'image/heic', heif: 'image/heif', hif: 'image/heif',
  };
  return map[ext] ?? 'image/jpeg';
}

export class LocalSource implements SourceProvider {
  readonly type = 'local';
  private dirHandle: FileSystemDirectoryHandle | null = null;
  private handleCache = new Map<string, FileSystemFileHandle>();
  private _store: SidecarStoreV2 | null = null;
  private _migrated = false;

  readonly id: string;
  label: string;

  constructor(
    id: string,
    label: string,
    dirHandle?: FileSystemDirectoryHandle,
  ) {
    this.id = id;
    this.label = label;
    if (dirHandle) this.dirHandle = dirHandle;
  }

  setDirHandle(handle: FileSystemDirectoryHandle) {
    this.dirHandle = handle;
    this.label = handle.name;
    this._store = null;
  }

  getDirHandle(): FileSystemDirectoryHandle | null {
    return this.dirHandle;
  }

  /** Get the SidecarStoreV2 (.photolib/index.json + thumbs/) for this source */
  get store(): SidecarStoreV2 | null {
    if (!this.dirHandle) return null;
    if (!this._store) {
      this._store = new SidecarStoreV2(this.dirHandle);
    }
    return this._store;
  }

  /** Migrate from V1 .dat if needed (called once after connect) */
  async ensureMigrated(): Promise<void> {
    if (this._migrated || !this.store) return;
    this._migrated = true;
    try {
      await this.store.init();
      // If index.json is empty, check for V1 .dat
      const count = await this.store.count();
      if (count === 0) {
        const migrated = await this.store.migrateFromV1(this.label);
        if (migrated) {
          console.log(`[LocalSource] Migrated V1 .dat to V2 for "${this.label}"`);
        }
      }
    } catch { /* */ }
  }

  async connect(): Promise<boolean> {
    try {
      if (this.dirHandle) {
        const perm = await requestPermission(this.dirHandle, 'readwrite');
        if (perm === 'granted') {
          await this.ensureMigrated();
          return true;
        }
      }
      const picked = await pickDirectory('readwrite');
      if (!picked) return false;
      this.dirHandle = picked;
      this.label = picked.name;
      await this.ensureMigrated();
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.handleCache.clear();
    this.dirHandle = null;
    this._store = null;
  }

  async *listPhotos(path?: string, signal?: AbortSignal): AsyncIterable<PhotoRef> {
    if (!this.dirHandle) return;
    const failures = new ListingFailures();
    yield* this.walkDirectory(this.dirHandle, path ?? '', 0, failures.record, signal);
    failures.finish(this.label || 'Local folder', signal);
  }

  private async *walkDirectory(
    dir: FileSystemDirectoryHandle,
    currentPath: string,
    depth: number,
    onFailure: (what: string) => void,
    signal?: AbortSignal,
  ): AsyncIterable<PhotoRef> {
    if (depth > 20 || signal?.aborted) return;

    let entries: FileSystemHandle[];
    try {
      entries = [];
      for await (const entry of dir.values()) {
        entries.push(entry);
      }
    } catch {
      onFailure(currentPath || '/');
      return;
    }

    for (const entry of entries) {
      const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'directory' && SKIP_DIRS.has(entry.name)) continue;

      try {
        if (entry.kind === 'directory') {
          yield* this.walkDirectory(entry as FileSystemDirectoryHandle, entryPath, depth + 1, onFailure, signal);
        } else if (entry.kind === 'file' && isImageFile(entry.name)) {
          const fileHandle = entry as FileSystemFileHandle;
          this.handleCache.set(entryPath, fileHandle);
          const file = await fileHandle.getFile();

          yield {
            sourcePhotoId: entryPath,
            sourceId: this.id,
            name: entry.name,
            mimeType: mimeFromExt(entry.name),
            sizeBytes: file.size,
            dateModified: file.lastModified,
          };
        }
      } catch {
        onFailure(entryPath);
        continue;
      }
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const file = await this.getFile(ref);
    if (!file) throw new Error(`File not accessible: ${ref.sourcePhotoId}`);
    return URL.createObjectURL(file);
  }

  async getThumbnailUrl(): Promise<string | null> {
    return null;
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    const cached = this.handleCache.get(ref.sourcePhotoId);
    if (cached) {
      try {
        const file = await cached.getFile();
        return signal?.aborted ? null : file;
      } catch { /* handle expired */ }
    }
    if (!this.dirHandle || signal?.aborted) return null;
    try {
      const parts = ref.sourcePhotoId.split('/');
      let dir: FileSystemDirectoryHandle = this.dirHandle;
      for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i]);
      }
      if (signal?.aborted) return null;
      const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
      if (signal?.aborted) return null;
      this.handleCache.set(ref.sourcePhotoId, fileHandle);
      const file = await fileHandle.getFile();
      return signal?.aborted ? null : file;
    } catch {
      return null;
    }
  }

  async writeSidecar(ref: PhotoRef, data: string): Promise<boolean> {
    if (!this.store) return false;
    try {
      await this.store.setMeta(ref.sourcePhotoId, { e: data });
      return true;
    } catch {
      return false;
    }
  }

  async readSidecar(ref: PhotoRef): Promise<string | null> {
    if (!this.store) return null;
    try {
      const meta = await this.store.getMeta(ref.sourcePhotoId);
      return meta?.e ?? null;
    } catch {
      return null;
    }
  }

  async readSidecarThumb(ref: PhotoRef): Promise<Blob | null> {
    return this.store?.readThumb(ref.sourcePhotoId) ?? null;
  }

  async writeSidecarThumb(ref: PhotoRef, blob: Blob, meta?: Partial<PhotoMeta>): Promise<boolean> {
    if (!this.store) return false;
    try {
      await this.store.writeThumb(ref.sourcePhotoId, blob, meta);
      return true;
    } catch {
      return false;
    }
  }

  async writeSidecarMeta(ref: PhotoRef, meta: Partial<PhotoMeta>): Promise<void> {
    await this.store?.setMeta(ref.sourcePhotoId, meta);
  }

  async readSidecarMeta(ref: PhotoRef): Promise<PhotoMeta | null> {
    return this.store?.getMeta(ref.sourcePhotoId) ?? null;
  }

  async sidecarThumbCount(): Promise<number> {
    return this.store?.thumbCount() ?? 0;
  }

  get sidecarThumbCountSync(): number {
    return this.store?.thumbCountSync ?? 0;
  }

  async deleteSidecarData(): Promise<void> {
    if (!this.dirHandle) return;
    try {
      const plDir = await this.dirHandle.getDirectoryHandle('.photolib');
      // Remove V2 data
      try { await plDir.removeEntry('index.json'); } catch { /* */ }
      try { await plDir.removeEntry('thumbs', { recursive: true }); } catch { /* */ }
      // Remove V1 .dat if exists
      const datName = this.label.replace(/[^a-zA-Z0-9_-]/g, '_') + '.dat';
      try { await plDir.removeEntry(datName); } catch { /* */ }
      this._store = null;
    } catch { /* .photolib doesn't exist */ }
  }

  // ─── Extended capabilities ───

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    if (!this.dirHandle) return [];
    try {
      return await this.listSubDirs(this.dirHandle, '');
    } catch {
      return [];
    }
  }

  private async listSubDirs(dir: FileSystemDirectoryHandle, path: string): Promise<SourceBrowseItem[]> {
    const items: SourceBrowseItem[] = [];
    for await (const entry of dir.values()) {
      if (entry.kind !== 'directory') continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const subPath = path ? `${path}/${entry.name}` : entry.name;
      const children = await this.listSubDirs(entry as FileSystemDirectoryHandle, subPath);
      items.push({
        id: subPath,
        name: entry.name,
        type: 'folder',
        children: children.length > 0 ? children : undefined,
      });
    }
    return items;
  }

  async createAlbum(name: string): Promise<string | null> {
    if (!this.dirHandle) return null;
    try {
      await this.dirHandle.getDirectoryHandle(name, { create: true });
      return name;
    } catch {
      return null;
    }
  }
}
