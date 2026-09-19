import type { SourceProvider, PhotoRef, PhotoPage, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';

export interface SmugMugConfig {
  apiKey: string;
  accessToken: string;
  username: string;
}

const API_BASE = 'https://api.smugmug.com/api/v2';

interface SmugMugImageSizes {
  ThumbImageUrl?: string;
  SmallImageUrl?: string;
  LargeImageUrl?: string;
  X2LargeImageUrl?: string;
  OriginalImageUrl?: string;
}

interface SmugMugImage {
  ImageKey: string;
  FileName?: string;
  Title?: string;
  Format?: string;
  DateTimeOriginal?: string;
  ISO?: string | number;
  FocalLength?: string;
  Aperture?: string;
  OriginalWidth?: number;
  OriginalHeight?: number;
  Latitude?: string;
  Longitude?: string;
  Keywords?: string;
  Caption?: string;
}

export class SmugMugSource implements SourceProvider {
  readonly type = 'smugmug';
  readonly id: string;
  readonly label: string;

  private accessToken: string;
  private username: string;

  constructor(id: string, label: string, config: SmugMugConfig) {
    this.id = id;
    this.label = label;
    this.accessToken = config.accessToken;
    this.username = config.username;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'Accept': 'application/json',
    };
  }

  async connect(): Promise<boolean> {
    try {
      const res = await proxyFetch(`${API_BASE}/user/${this.username}`, {
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(): AsyncIterable<PhotoRef> {
    // Navigate folder tree → albums → images
    yield* this.listFolder(`/api/v2/folder/user/${this.username}`, '');
  }

  private async *listFolder(folderUri: string, path: string): AsyncIterable<PhotoRef> {
    try {
      // Get subfolders
      const foldersRes = await proxyFetch(`https://api.smugmug.com${folderUri}!folders`, {
        headers: this.headers(),
      });
      if (foldersRes.ok) {
        const foldersData = await foldersRes.json();
        for (const folder of foldersData.Response?.Folder ?? []) {
          const subPath = path ? `${path}/${folder.Name}` : folder.Name;
          yield* this.listFolder(folder.Uri, subPath);
        }
      }

      // Get albums in this folder
      const albumsRes = await proxyFetch(`https://api.smugmug.com${folderUri}!albums`, {
        headers: this.headers(),
      });
      if (albumsRes.ok) {
        const albumsData = await albumsRes.json();
        for (const album of albumsData.Response?.Album ?? []) {
          yield* this.listAlbumImages(album.AlbumKey, path ? `${path}/${album.Name}` : album.Name);
        }
      }
    } catch { /* */ }
  }

  private async *listAlbumImages(albumKey: string, _albumPath: string): AsyncIterable<PhotoRef> {
    let url: string | null = `${API_BASE}/album/${albumKey}!images?_expand=ImageSizes&count=200`;

    while (url) {
      try {
        const res = await proxyFetch(url, { headers: this.headers() });
        if (!res.ok) break;
        const data = await res.json();

        for (const img of data.Response?.AlbumImage ?? []) {
          yield {
            sourcePhotoId: `${albumKey}/${img.ImageKey}`,
            sourceId: this.id,
            name: img.FileName ?? img.Title ?? img.ImageKey,
            mimeType: `image/${(img.Format ?? 'jpeg').toLowerCase()}`,
            dateTaken: img.DateTimeOriginal ? new Date(img.DateTimeOriginal).getTime() : undefined,
          };
        }

        // Pagination
        const pages = data.Response?.Pages;
        url = pages?.NextPage ? `https://api.smugmug.com${pages.NextPage}` : null;
      } catch {
        break;
      }
    }
  }

  async listPhotosPage(): Promise<PhotoPage | null> {
    return null; // Tree-based navigation, no global pagination
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const sizes = await this.getImageSizes(ref.sourcePhotoId);
    const url = sizes?.LargeImageUrl ?? sizes?.X2LargeImageUrl;
    if (!url) throw new Error('No display URL');
    const res = await proxyFetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      const sizes = await this.getImageSizes(ref.sourcePhotoId, signal);
      const url = sizes?.SmallImageUrl ?? sizes?.ThumbImageUrl;
      if (!url) return null;
      const res = await proxyFetch(url, { headers: this.headers(), signal });
      if (!res.ok) return null;
      const blob = await res.blob();
      return signal?.aborted ? null : URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    try {
      const sizes = await this.getImageSizes(ref.sourcePhotoId, signal);
      const url = sizes?.OriginalImageUrl;
      if (!url) return null;
      const res = await proxyFetch(url, { headers: this.headers(), signal });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (signal?.aborted) return null;
      return new File([blob], ref.name, { type: blob.type });
    } catch {
      return null;
    }
  }

  private imageSizesCache = new Map<string, SmugMugImageSizes>();

  private async getImageSizes(
    sourcePhotoId: string,
    signal?: AbortSignal,
  ): Promise<SmugMugImageSizes | null> {
    if (this.imageSizesCache.has(sourcePhotoId)) {
      return this.imageSizesCache.get(sourcePhotoId) ?? null;
    }
    const [albumKey, imageKey] = sourcePhotoId.split('/');
    try {
      const res = await proxyFetch(
        `${API_BASE}/album/${albumKey}/image/${imageKey}!sizes`,
        { headers: this.headers(), signal },
      );
      if (!res.ok) return null;
      const data = await res.json() as { Response?: { ImageSizes?: SmugMugImageSizes } };
      if (signal?.aborted) return null;
      const sizes = data.Response?.ImageSizes;
      if (sizes) this.imageSizesCache.set(sourcePhotoId, sizes);
      return sizes ?? null;
    } catch {
      return null;
    }
  }

  private async getImageDetail(sourcePhotoId: string): Promise<SmugMugImage | null> {
    const [albumKey, imageKey] = sourcePhotoId.split('/');
    try {
      const res = await proxyFetch(
        `${API_BASE}/album/${albumKey}/image/${imageKey}`,
        { headers: this.headers() },
      );
      if (!res.ok) return null;
      const data = await res.json() as { Response?: { Image?: SmugMugImage } };
      return data.Response?.Image ?? null;
    } catch {
      return null;
    }
  }

  // ─── Extended capabilities ───

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      const img = await this.getImageDetail(ref.sourcePhotoId);
      if (!img) return null;
      return {
        camera: null,
        lens: null,
        iso: img.ISO ? Number(img.ISO) : null,
        focalLength: img.FocalLength ? parseFloat(img.FocalLength) : null,
        aperture: img.Aperture ? parseFloat(img.Aperture) : null,
        shutterSpeed: null,
        width: img.OriginalWidth ?? null,
        height: img.OriginalHeight ?? null,
        latitude: img.Latitude ? parseFloat(img.Latitude) : null,
        longitude: img.Longitude ? parseFloat(img.Longitude) : null,
        keywords: img.Keywords ? img.Keywords.split(';').map((k: string) => k.trim()).filter(Boolean) : [],
        rating: null,
        favorite: false,
        title: img.Title ?? null,
        description: img.Caption ?? null,
      };
    } catch {
      return null;
    }
  }

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    try {
      return await this.browseFolder(`/api/v2/folder/user/${this.username}`, '');
    } catch {
      return [];
    }
  }

  private async browseFolder(folderUri: string, path: string): Promise<SourceBrowseItem[]> {
    const items: SourceBrowseItem[] = [];

    // Subfolders
    try {
      const fRes = await proxyFetch(`https://api.smugmug.com${folderUri}!folders`, {
        headers: this.headers(),
      });
      if (fRes.ok) {
        const fData = await fRes.json();
        for (const folder of fData.Response?.Folder ?? []) {
          const children = await this.browseFolder(folder.Uri, path ? `${path}/${folder.Name}` : folder.Name);
          items.push({
            id: folder.Uri,
            name: folder.Name,
            type: 'folder',
            children,
          });
        }
      }
    } catch { /* */ }

    // Albums in folder
    try {
      const aRes = await proxyFetch(`https://api.smugmug.com${folderUri}!albums`, {
        headers: this.headers(),
      });
      if (aRes.ok) {
        const aData = await aRes.json();
        for (const album of aData.Response?.Album ?? []) {
          items.push({
            id: album.AlbumKey,
            name: album.Name,
            type: 'album',
            photoCount: album.ImageCount,
          });
        }
      }
    } catch { /* */ }

    return items;
  }

  async setTitle(ref: PhotoRef, title: string, description?: string): Promise<boolean> {
    try {
      const [albumKey, imageKey] = ref.sourcePhotoId.split('/');
      const body: Record<string, string> = { Title: title };
      if (description !== undefined) body.Caption = description;
      const res = await proxyFetch(
        `${API_BASE}/album/${albumKey}/image/${imageKey}`,
        {
          method: 'PATCH',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async setTags(ref: PhotoRef, tags: string[]): Promise<boolean> {
    try {
      const [albumKey, imageKey] = ref.sourcePhotoId.split('/');
      const res = await proxyFetch(
        `${API_BASE}/album/${albumKey}/image/${imageKey}`,
        {
          method: 'PATCH',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ Keywords: tags.join('; ') }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const [albumKey] = ref.sourcePhotoId.split('/');
      const res = await proxyFetch('https://upload.smugmug.com/', {
        method: 'POST',
        headers: {
          ...this.headers(),
          'X-Smug-AlbumUri': `/api/v2/album/${albumKey}`,
          'X-Smug-FileName': ref.name,
          'Content-Type': blob.type || 'application/octet-stream',
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
      const urlName = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const res = await proxyFetch(
        `https://api.smugmug.com/api/v2/folder/user/${this.username}!albums`,
        {
          method: 'POST',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ Name: name, UrlName: urlName }),
        },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.Response?.Album?.AlbumKey ?? null;
    } catch {
      return null;
    }
  }
}
