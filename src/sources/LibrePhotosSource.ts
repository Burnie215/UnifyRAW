import type { SourceProvider, PhotoRef, PhotoPage, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';

export interface LibrePhotosConfig {
  serverUrl: string;
  username: string;
  password: string;
}

interface LibrePhotosPhoto {
  id: string | number;
  image_hash?: string;
  original_filename?: string;
  exif_timestamp?: string;
}

interface LibrePhotosPage {
  results?: LibrePhotosPhoto[];
  next?: string | null;
  count?: number;
}

export class LibrePhotosSource implements SourceProvider {
  readonly type = 'librephotos';
  readonly id: string;
  readonly label: string;

  private baseUrl: string;
  private username: string;
  private password: string;
  private accessToken: string | null = null;

  constructor(id: string, label: string, config: LibrePhotosConfig) {
    this.id = id;
    this.label = label;
    this.baseUrl = config.serverUrl.replace(/\/+$/, '');
    this.username = config.username;
    this.password = config.password;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.accessToken) h['Authorization'] = `Bearer ${this.accessToken}`;
    return h;
  }

  async connect(): Promise<boolean> {
    try {
      const res = await proxyFetch(`${this.baseUrl}/api/auth/token/obtain/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      this.accessToken = data.access;
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.accessToken = null;
  }

  async *listPhotos(): AsyncIterable<PhotoRef> {
    let page = 1;
    while (true) {
      const result = await this.listPhotosPage(page, 200);
      if (!result || result.photos.length === 0) break;
      for (const photo of result.photos) yield photo;
      if (!result.hasMore) break;
      page++;
    }
  }

  async listPhotosPage(page: number, pageSize: number): Promise<PhotoPage | null> {
    try {
      const res = await proxyFetch(
        `${this.baseUrl}/api/photos/?page=${page}&page_size=${pageSize}`,
        { headers: this.headers() },
      );
      if (!res.ok) return null;
      const data = await res.json() as LibrePhotosPage;
      const results = data.results ?? [];

      return {
        photos: results.map((p) => ({
          sourcePhotoId: p.image_hash ?? String(p.id),
          sourceId: this.id,
          name: p.original_filename ?? p.image_hash ?? `${p.id}`,
          mimeType: 'image/jpeg',
          dateTaken: p.exif_timestamp ? new Date(p.exif_timestamp).getTime() : undefined,
        })),
        hasMore: !!data.next,
        total: data.count,
      };
    } catch {
      return null;
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const url = `${this.baseUrl}/media/photos/${ref.sourcePhotoId}`;
    const res = await proxyFetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      const url = `${this.baseUrl}/media/thumbnails_big/${ref.sourcePhotoId}`;
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
      const url = `${this.baseUrl}/media/photos/${ref.sourcePhotoId}`;
      const res = await proxyFetch(url, { headers: this.headers(), signal });
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
      const res = await proxyFetch(
        `${this.baseUrl}/api/photos/${ref.sourcePhotoId}/metadata`,
        { headers: this.headers() },
      );
      if (!res.ok) return null;
      const data = await res.json();
      return {
        camera: data.camera ?? null,
        lens: data.lens ?? null,
        iso: data.iso ?? null,
        focalLength: data.focal_length ? parseFloat(data.focal_length) : null,
        aperture: data.aperture ? parseFloat(data.aperture) : null,
        shutterSpeed: data.exposure_time ?? null,
        width: data.width ?? null,
        height: data.height ?? null,
        latitude: data.latitude ? parseFloat(data.latitude) : null,
        longitude: data.longitude ? parseFloat(data.longitude) : null,
        keywords: [],
        rating: null,
        favorite: data.favorited ?? false,
        title: null,
        description: data.captions_json ?? null,
      };
    } catch {
      return null;
    }
  }

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    const items: SourceBrowseItem[] = [];
    try {
      // User albums
      const userRes = await proxyFetch(`${this.baseUrl}/api/albums/user/list/`, {
        headers: this.headers(),
      });
      if (userRes.ok) {
        const data = await userRes.json();
        for (const album of data.results ?? []) {
          items.push({
            id: `user:${album.id}`,
            name: album.title ?? `Album ${album.id}`,
            type: 'album',
            photoCount: album.photo_count,
          });
        }
      }
    } catch { /* */ }

    try {
      // Auto albums (places, things, dates)
      const autoRes = await proxyFetch(`${this.baseUrl}/api/albums/auto/list/`, {
        headers: this.headers(),
      });
      if (autoRes.ok) {
        const data = await autoRes.json();
        for (const album of data.results ?? []) {
          items.push({
            id: `auto:${album.id}`,
            name: `🤖 ${album.title ?? album.id}`,
            type: 'album',
            photoCount: album.photo_count,
          });
        }
      }
    } catch { /* */ }

    return items;
  }

  async setFavorite(ref: PhotoRef, favorite: boolean): Promise<boolean> {
    try {
      const res = await proxyFetch(`${this.baseUrl}/api/photosedit/favorite`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_hashes: [ref.sourcePhotoId], favorite }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('file', blob, ref.name);
      const res = await proxyFetch(`${this.baseUrl}/api/upload/`, {
        method: 'POST',
        headers: this.headers(),
        body: formData,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createAlbum(name: string): Promise<string | null> {
    try {
      const res = await proxyFetch(`${this.baseUrl}/api/albums/user/edit/`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: name }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.id ? `user:${data.id}` : null;
    } catch {
      return null;
    }
  }
}
