import type { SourceProvider } from './types';
import { isKnownSourceType, type SourceType } from './capabilities';
import { LocalSource } from './LocalSource';
import { FileListSource } from './FileListSource';
import { ImmichSource } from './ImmichSource';
import type { ImmichConfig } from './ImmichSource';
import { ImmichV3Source } from './ImmichV3Source';
import type { ImmichV3Config } from './ImmichV3Source';
import { ServerPathSource } from './ServerPathSource';
import type { ServerPathConfig } from './ServerPathSource';
import { WebDAVSource } from './WebDAVSource';
import type { WebDAVConfig } from './WebDAVSource';
import type { S3Config } from './S3Source';
import { DropboxSource } from './DropboxSource';
import type { DropboxConfig } from './DropboxSource';
import { GoogleDriveSource } from './GoogleDriveSource';
import type { GoogleDriveConfig } from './GoogleDriveSource';
import { PhotoprismSource } from './PhotoprismSource';
import type { PhotoprismConfig } from './PhotoprismSource';
import { PiwigoSource } from './PiwigoSource';
import type { PiwigoConfig } from './PiwigoSource';
import { LycheeSource } from './LycheeSource';
import type { LycheeConfig } from './LycheeSource';
import { SynologySource } from './SynologySource';
import type { SynologyConfig } from './SynologySource';
import { LibrePhotosSource } from './LibrePhotosSource';
import type { LibrePhotosConfig } from './LibrePhotosSource';
import { NextcloudPhotosSource } from './NextcloudPhotosSource';
import type { NextcloudPhotosConfig } from './NextcloudPhotosSource';
import { OneDriveSource } from './OneDriveSource';
import type { OneDriveConfig } from './OneDriveSource';
import { GooglePhotosSource } from './GooglePhotosSource';
import type { GooglePhotosConfig } from './GooglePhotosSource';
import { FlickrSource } from './FlickrSource';
import type { FlickrConfig } from './FlickrSource';
import { SmugMugSource } from './SmugMugSource';
import type { SmugMugConfig } from './SmugMugSource';
import { PhotoLibLibrarySource } from './PhotoLibLibrarySource';
import type { PhotoLibLibraryConfig } from './PhotoLibLibrarySource';
import { queryPermission, requestPermission } from '../platform/fs';
import { deleteSourceHandle, loadSourceHandle, saveSourceHandle } from '../storage/handleStore';
import type { Repositories } from '../storage/repos';
import type { CreatePhotoLibraryRequest } from '@photolib/shared';
import {
  createPhotoLibrary,
  deletePhotoLibrary,
  LibraryApiError,
} from '../platform/libraryApi';

type SourceFactory = (id: string, label: string, config: Record<string, unknown>) => SourceProvider;

/**
 * Constructor per source type. Keyed by `SourceType` from the capability
 * table, so a new source cannot be added there without deciding here whether
 * it is constructible — `local`/`local-files` are not: they are built from a
 * directory handle or a file list, not from a persisted config object.
 */
export const SOURCE_FACTORIES: Readonly<Record<SourceType, SourceFactory | null>> = {
  'local': null,
  'local-files': null,
  'immich': (id, l, c) => new ImmichSource(id, l, c as unknown as ImmichConfig),
  'immich-v3': (id, l, c) => new ImmichV3Source(id, l, c as unknown as ImmichV3Config, 'immich-v3'),
  'lychee': (id, l, c) => new LycheeSource(id, l, c as unknown as LycheeConfig),
  'webdav': (id, l, c) => new WebDAVSource(id, l, c as unknown as WebDAVConfig),
  'photoprism': (id, l, c) => new PhotoprismSource(id, l, c as unknown as PhotoprismConfig),
  'piwigo': (id, l, c) => new PiwigoSource(id, l, c as unknown as PiwigoConfig),
  'synology': (id, l, c) => new SynologySource(id, l, c as unknown as SynologyConfig),
  'librephotos': (id, l, c) => new LibrePhotosSource(id, l, c as unknown as LibrePhotosConfig),
  'nextcloud-photos': (id, l, c) => new NextcloudPhotosSource(id, l, c as unknown as NextcloudPhotosConfig),
  // Ente, FTP, SMB, SSH and NFS have no code left (tag
  // attic/pre-deadcode-2026-09). The type stays so old catalog rows keep their
  // name and stay removable; without a factory they are simply not reconnected.
  'ente': null,
  'dropbox': (id, l, c) => new DropboxSource(id, l, c as unknown as DropboxConfig),
  'google-drive': (id, l, c) => new GoogleDriveSource(id, l, c as unknown as GoogleDriveConfig),
  'onedrive': (id, l, c) => new OneDriveSource(id, l, c as unknown as OneDriveConfig),
  'google-photos': (id, l, c) => new GooglePhotosSource(id, l, c as unknown as GooglePhotosConfig),
  'flickr': (id, l, c) => new FlickrSource(id, l, c as unknown as FlickrConfig),
  'smugmug': (id, l, c) => new SmugMugSource(id, l, c as unknown as SmugMugConfig),
  // S3 stays recognizable for old catalog rows, but cannot be constructed
  // until requests use AWS Signature V4 instead of an unsigned credential header.
  's3': null,
  'server-path': (id, l, c) => new ServerPathSource(id, l, c as unknown as ServerPathConfig),
  'ftp': null,
  'smb': null,
  'ssh': null,
  'nfs': null,
  'photolib-library': (id, l, c) => new PhotoLibLibrarySource(id, l, c as unknown as PhotoLibLibraryConfig),
};

/**
 * Persistence (post-Phase-7):
 *   - sources.config is JSON-safe (in catalog.sqlite via SourceRepository).
 *   - LocalSource folder handles are NOT JSON-safe, so they live in a
 *     side IndexedDB (handleStore.saveSourceHandle/loadSourceHandle).
 *
 * SourceManager is a singleton; StorageContext calls setRepos(repos) once
 * the storage is ready. Calls made before that throw — App.tsx renders a
 * splash until storage opens.
 */

class SourceManagerImpl {
  private providers = new Map<string, SourceProvider>();
  private repos: Repositories | null = null;

  setRepos(repos: Repositories | null): void { this.repos = repos; }

  private requireRepos(): Repositories {
    if (!this.repos) throw new Error('SourceManager: repos not initialized — storage not ready yet');
    return this.repos;
  }

  get(id: string): SourceProvider | undefined {
    return this.providers.get(id);
  }

  getAll(): SourceProvider[] {
    return Array.from(this.providers.values());
  }

  // ─── Add sources ───

  async addLocalSource(): Promise<SourceProvider | null> {
    const repos = this.requireRepos();
    const id = crypto.randomUUID();
    const source = new LocalSource(id, 'Lokaler Ordner');
    const connected = await source.connect();
    if (!connected) return null;

    this.providers.set(id, source);

    const handle = (source as LocalSource).getDirHandle();
    const addedAt = Date.now();

    if (handle) await saveSourceHandle(id, handle);

    repos.sources.put({
      id, type: 'local', label: source.label,
      config: {},
      addedAt,
    });

    return source;
  }

  async addLocalSourceFromHandle(handle: FileSystemDirectoryHandle): Promise<SourceProvider> {
    const repos = this.requireRepos();
    const id = crypto.randomUUID();
    const source = new LocalSource(id, handle.name, handle);
    const addedAt = Date.now();

    this.providers.set(id, source);
    await saveSourceHandle(id, handle);

    repos.sources.put({
      id, type: 'local', label: handle.name,
      config: {},
      addedAt,
    });

    return source;
  }

  async addLocalSourceFromFiles(files: FileList): Promise<SourceProvider> {
    const repos = this.requireRepos();
    const id = crypto.randomUUID();
    const firstPath = files[0]?.webkitRelativePath ?? '';
    const folderName = firstPath.split('/')[0] || 'Ordner';
    const source = new FileListSource(id, folderName, files);

    this.providers.set(id, source);

    // FileList sources are volatile (drag & drop) — record but don't try to reopen.
    repos.sources.put({
      id, type: 'local-files', label: folderName,
      config: {}, addedAt: Date.now(),
    });

    return source;
  }

  async addImmichSource(cfg: ImmichConfig, label?: string): Promise<SourceProvider | null> {
    return this.addSourceByType('immich', cfg as unknown as Record<string, unknown>, label ?? 'Immich v2');
  }
  async addImmichV3Source(cfg: ImmichV3Config, label?: string): Promise<SourceProvider | null> {
    return this.addSourceByType('immich-v3', cfg as unknown as Record<string, unknown>, label ?? 'Immich v3');
  }
  async addServerPathSource(cfg: ServerPathConfig, label?: string): Promise<SourceProvider | null> {
    return this.addSourceByType('server-path', cfg as unknown as Record<string, unknown>, label ?? 'Server');
  }
  async addWebDAVSource(cfg: WebDAVConfig, label?: string): Promise<SourceProvider | null> {
    return this.addSourceByType('webdav', cfg as unknown as Record<string, unknown>, label ?? 'WebDAV');
  }
  async addS3Source(cfg: S3Config, label?: string): Promise<SourceProvider | null> {
    return this.addSourceByType('s3', cfg as unknown as Record<string, unknown>, label ?? `S3 ${cfg.bucket}`);
  }
  async addDropboxSource(cfg: DropboxConfig, label?: string): Promise<SourceProvider | null> {
    return this.addSourceByType('dropbox', cfg as unknown as Record<string, unknown>, label ?? 'Dropbox');
  }
  async addGoogleDriveSource(cfg: GoogleDriveConfig, label?: string): Promise<SourceProvider | null> {
    return this.addSourceByType('google-drive', cfg as unknown as Record<string, unknown>, label ?? 'Google Drive');
  }

  async addPhotoLibLibrarySource(request: CreatePhotoLibraryRequest): Promise<SourceProvider | null> {
    const library = await createPhotoLibrary(request);
    try {
      const source = await this.addSourceByType(
        'photolib-library',
        { libraryId: library.id },
        library.name,
      );
      if (!source) throw new Error('PhotoLib library source could not be connected');
      return source;
    } catch (error) {
      await deletePhotoLibrary(library.id).catch(() => undefined);
      throw error;
    }
  }

  async addSourceByType(type: string, config: Record<string, unknown>, label: string): Promise<SourceProvider | null> {
    const repos = this.requireRepos();
    const factory = this.getFactory(type);
    if (!factory) return null;

    const id = crypto.randomUUID();
    const source = factory(id, label, config);
    const connected = await source.connect();
    if (!connected) {
      const connectionError = source.getConnectionError?.();
      if (connectionError) throw connectionError;
      return null;
    }

    this.providers.set(id, source);
    const addedAt = Date.now();

    repos.sources.put({ id, type, label, config, addedAt });

    return source;
  }

  // ─── Remove ───

  async removeSource(id: string): Promise<void> {
    const repos = this.requireRepos();
    const row = repos.sources.get(id);
    const provider = this.providers.get(id);
    if (row?.type === 'photolib-library') {
      const libraryId = typeof row.config.libraryId === 'string' ? row.config.libraryId : null;
      if (libraryId) {
        try {
          await deletePhotoLibrary(libraryId);
        } catch (error) {
          // Removing a locally persisted source remains possible if the server
          // registry entry was already removed out-of-band.
          if (!(error instanceof LibraryApiError && error.status === 404)) throw error;
        }
      }
    }
    if (provider) {
      await provider.disconnect();
      this.providers.delete(id);
    }

    repos.sources.softDelete(id);
    await deleteSourceHandle(id).catch(() => undefined);
  }

  // ─── Reconnect ───

  async getDisconnectedSources(): Promise<string[]> {
    const repos = this.requireRepos();
    const saved = repos.sources.list();
    return saved.filter((s) => !this.providers.has(s.id)).map((s) => s.id);
  }

  async reconnectSource(id: string): Promise<boolean> {
    const repos = this.requireRepos();
    const s = repos.sources.get(id);
    if (!s) return false;
    if (this.providers.has(id)) return true;

    if (s.type === 'local') {
      const handle = await loadSourceHandle(id);
      const source = new LocalSource(s.id, s.label, handle ?? undefined);
      if (handle) {
        const perm = await requestPermission(handle, 'read');
        if (perm === 'granted') {
          this.providers.set(s.id, source);
          return true;
        }
      }
      const connected = await source.connect();
      if (connected) {
        const newHandle = source.getDirHandle();
        if (newHandle) await saveSourceHandle(s.id, newHandle);
        this.providers.set(s.id, source);
        return true;
      }
      return false;
    }

    const factory = this.getFactory(s.type);
    if (factory) {
      const source = factory(s.id, s.label, s.config);
      const connected = await source.connect();
      if (connected) {
        this.providers.set(s.id, source);
        return true;
      }
    }
    return false;
  }

  async reconnectAll(): Promise<void> {
    const repos = this.requireRepos();
    const saved = repos.sources.list();

    for (const s of saved) {
      if (s.type === 'local') {
        const handle = await loadSourceHandle(s.id);
        if (handle) {
          const perm = await queryPermission(handle, 'read');
          if (perm === 'granted') {
            this.providers.set(s.id, new LocalSource(s.id, s.label, handle));
            continue;
          }
        }
        // Disconnected — waits for user gesture
      } else if (s.type !== 'local-files') {
        const factory = this.getFactory(s.type);
        if (factory) {
          const source = factory(s.id, s.label, s.config);
          const connected = await source.connect();
          if (connected) this.providers.set(s.id, source);
        }
      }
    }
  }

  // ─── Per-source preferences (stored inside the source's config object) ───

  /** Whether the source should auto-import new photos from the upstream side. Default: true. */
  getAutoRefresh(id: string): boolean {
    const row = this.requireRepos().sources.get(id);
    if (!row) return false;
    const v = (row.config as Record<string, unknown>).autoRefresh;
    return v === undefined ? true : v === true;
  }

  setAutoRefresh(id: string, enabled: boolean): void {
    const repos = this.requireRepos();
    const row = repos.sources.get(id);
    if (!row) return;
    const newConfig = { ...row.config, autoRefresh: enabled };
    repos.sources.update(id, { config: newConfig });
  }

  async tryListAlbums(
    type: string,
    config: Record<string, unknown>,
    sourceName = type,
  ): Promise<import('./types').SourceBrowseItem[]> {
    const factory = this.getFactory(type);
    if (!factory) return [];
    const tempSource = factory('_temp', sourceName, config);
    try {
      const connected = await tempSource.connect();
      if (!connected) {
        const connectionError = tempSource.getConnectionError?.();
        if (connectionError) throw connectionError;
        return [];
      }
      return await tempSource.listAlbumsOrFolders?.() ?? [];
    } finally {
      try { await tempSource.disconnect(); } catch { /* best-effort */ }
    }
  }

  private getFactory(type: string): SourceFactory | null {
    return isKnownSourceType(type) ? SOURCE_FACTORIES[type] : null;
  }
}

export const sourceManager = new SourceManagerImpl();
