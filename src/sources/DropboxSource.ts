import type { SourceProvider, PhotoRef, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';
import { photoDirOf, sidecarPathFor } from './sidecarPath';

export interface DropboxConfig {
  accessToken: string;
  rootPath?: string;
}

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'hif',
  'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'raf', 'rw2',
]);

export class DropboxSource implements SourceProvider {
  readonly type = 'dropbox';
  private token: string;
  private rootPath: string;

  readonly id: string;
  readonly label: string;

  constructor(
    id: string,
    label: string,
    config: DropboxConfig,
  ) {
    this.id = id;
    this.label = label;
    this.token = config.accessToken;
    this.rootPath = config.rootPath ?? '';
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async connect(): Promise<boolean> {
    try {
      const res = await proxyFetch('https://api.dropboxapi.com/2/users/get_current_account', {
        method: 'POST',
        headers: this.headers(),
        body: 'null',
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(): AsyncIterable<PhotoRef> {
    let cursor: string | undefined;
    let hasMore = true;

    // Initial list
    const initRes = await proxyFetch('https://api.dropboxapi.com/2/files/list_folder', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        path: this.rootPath || '',
        recursive: true,
        limit: 500,
      }),
    });

    if (!initRes.ok) return;
    let data = await initRes.json();

    while (true) {
      for (const entry of data.entries ?? []) {
        if (entry['.tag'] !== 'file') continue;
        const name = entry.name as string;
        const ext = name.split('.').pop()?.toLowerCase() ?? '';
        if (!IMAGE_EXTENSIONS.has(ext)) continue;

        const relPath = (entry.path_display as string).replace(/^\//, '');

        yield {
          sourcePhotoId: relPath,
          sourceId: this.id,
          name,
          sizeBytes: entry.size as number | undefined,
          dateModified: entry.server_modified ? new Date(entry.server_modified as string).getTime() : undefined,
        };
      }

      hasMore = data.has_more ?? false;
      cursor = data.cursor;
      if (!hasMore || !cursor) break;

      const contRes = await proxyFetch('https://api.dropboxapi.com/2/files/list_folder/continue', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ cursor }),
      });
      if (!contRes.ok) break;
      data = await contRes.json();
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const res = await proxyFetch('https://api.dropboxapi.com/2/files/get_temporary_link', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ path: '/' + ref.sourcePhotoId }),
    });
    if (!res.ok) throw new Error(`Dropbox link failed: ${res.status}`);
    const data = await res.json();
    // Fetch through proxy to avoid CORS
    const imgRes = await proxyFetch(data.link, {});
    const blob = await imgRes.blob();
    return URL.createObjectURL(blob);
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      const res = await proxyFetch('https://content.dropboxapi.com/2/files/get_thumbnail_v2', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Dropbox-API-Arg': JSON.stringify({
            resource: { '.tag': 'path', path: '/' + ref.sourcePhotoId },
            size: { '.tag': 'w256h256' },
            format: { '.tag': 'jpeg' },
          }),
        },
        signal,
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (signal?.aborted) return null;
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    try {
      const res = await proxyFetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Dropbox-API-Arg': JSON.stringify({ path: '/' + ref.sourcePhotoId }),
        },
        signal,
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (signal?.aborted) return null;
      return new File([blob], ref.name, { type: blob.type });
    } catch {
      return null;
    }
  }

  // ─── Extended capabilities ───

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      const res = await proxyFetch('https://api.dropboxapi.com/2/files/get_metadata', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ path: '/' + ref.sourcePhotoId, include_media_info: true }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const media = data.media_info?.metadata;
      if (!media) return { camera: null, lens: null, iso: null, focalLength: null, aperture: null, shutterSpeed: null, width: null, height: null, latitude: null, longitude: null, keywords: [], rating: null, favorite: false, title: null, description: null };

      return {
        camera: null,
        lens: null,
        iso: null,
        focalLength: null,
        aperture: null,
        shutterSpeed: null,
        width: media.dimensions?.width ?? null,
        height: media.dimensions?.height ?? null,
        latitude: media.location?.latitude ?? null,
        longitude: media.location?.longitude ?? null,
        keywords: [],
        rating: null,
        favorite: false,
        title: null,
        description: null,
      };
    } catch {
      return null;
    }
  }

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    try {
      const res = await proxyFetch('https://api.dropboxapi.com/2/files/list_folder', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ path: this.rootPath || '', recursive: false, limit: 500 }),
      });
      if (!res.ok) return [];
      const data = await res.json() as {
        entries?: Array<{
          '.tag'?: string;
          path_display: string;
          name: string;
        }>;
      };
      return (data.entries ?? [])
        .filter((entry) => entry['.tag'] === 'folder')
        .map((entry) => ({
          id: entry.path_display,
          name: entry.name,
          type: 'folder' as const,
        }));
    } catch {
      return [];
    }
  }

  async writeSidecar(ref: PhotoRef, data: string): Promise<boolean> {
    try {
      const sidecarPath = '/' + sidecarPathFor(photoDirOf(ref.sourcePhotoId), ref.name);
      const res = await proxyFetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Dropbox-API-Arg': JSON.stringify({ path: sidecarPath, mode: 'overwrite' }),
          'Content-Type': 'application/octet-stream',
        },
        body: data,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async readSidecar(ref: PhotoRef): Promise<string | null> {
    try {
      const sidecarPath = '/' + sidecarPathFor(photoDirOf(ref.sourcePhotoId), ref.name);
      const res = await proxyFetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Dropbox-API-Arg': JSON.stringify({ path: sidecarPath }),
        },
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const dirPath = '/' + ref.sourcePhotoId.split('/').slice(0, -1).join('/');
      const editName = `${ref.name.replace(/\.[^.]+$/, '')}_edit.${ref.name.split('.').pop()}`;
      const res = await proxyFetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Dropbox-API-Arg': JSON.stringify({ path: `${dirPath}/${editName}`, mode: 'add' }),
          'Content-Type': 'application/octet-stream',
        },
        body: blob,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createAlbum(name: string): Promise<string | null> {
    try {
      const path = this.rootPath ? `${this.rootPath}/${name}` : `/${name}`;
      const res = await proxyFetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ path }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.metadata?.path_display ?? null;
    } catch {
      return null;
    }
  }
}
