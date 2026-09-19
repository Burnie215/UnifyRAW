import type { SourceProvider, PhotoRef, PhotoPage, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';

export interface PhotoprismConfig {
  serverUrl: string;
  username: string;
  password: string;
}

interface PhotoPrismPhoto {
  UID: string;
  FileName?: string;
  Title?: string;
  TakenAt?: string;
  Hash?: string;
  Files?: Array<{ Hash?: string }>;
  Camera?: { Make?: string; Model?: string };
  CameraModel?: string;
  Lens?: { Make?: string; Model?: string };
  LensModel?: string;
  Iso?: number;
  FocalLength?: number;
  FNumber?: number;
  Exposure?: string;
  Width?: number;
  Height?: number;
  Lat?: number;
  Lng?: number;
  Details?: { Keywords?: string };
  Favorite?: boolean;
  Description?: string;
}

interface PhotoPrismAlbum {
  UID: string;
  Title: string;
  PhotoCount?: number;
}

export class PhotoprismSource implements SourceProvider {
  readonly type = 'photoprism';
  readonly id: string;
  readonly label: string;

  private baseUrl: string;
  private username: string;
  private password: string;
  private sessionToken: string | null = null;
  private downloadToken: string | null = null;

  constructor(id: string, label: string, config: PhotoprismConfig) {
    this.id = id;
    this.label = label;
    this.baseUrl = config.serverUrl.replace(/\/+$/, '');
    this.username = config.username;
    this.password = config.password;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.sessionToken) h['X-Auth-Token'] = this.sessionToken;
    return h;
  }

  private async authenticate(): Promise<boolean> {
    try {
      const res = await proxyFetch(`${this.baseUrl}/api/v1/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: this.username, password: this.password }),
      });
      if (!res.ok) return false;
      const data = await res.json() as {
        id?: string;
        config?: { downloadToken?: string };
      };
      if (!data.id) return false;
      this.sessionToken = data.id;
      this.downloadToken = data.config?.downloadToken ?? null;
      return true;
    } catch {
      return false;
    }
  }

  async connect(): Promise<boolean> {
    return this.authenticate();
  }

  async disconnect(): Promise<void> {
    this.sessionToken = null;
    this.downloadToken = null;
  }

  async *listPhotos(): AsyncIterable<PhotoRef> {
    let offset = 0;
    const count = 200;
    while (true) {
      const page = await this.listPhotosPage(Math.floor(offset / count) + 1, count);
      if (!page || page.photos.length === 0) break;
      for (const photo of page.photos) yield photo;
      if (!page.hasMore) break;
      offset += count;
    }
  }

  async listPhotosPage(page: number, pageSize: number): Promise<PhotoPage | null> {
    const offset = (page - 1) * pageSize;
    try {
      const res = await proxyFetch(
        `${this.baseUrl}/api/v1/photos?count=${pageSize}&offset=${offset}`,
        { headers: this.headers() },
      );
      if (!res.ok) return null;
      const photos = await res.json() as PhotoPrismPhoto[];

      return {
        photos: photos.map((p) => ({
          sourcePhotoId: p.UID,
          sourceId: this.id,
          name: p.FileName ?? p.Title ?? p.UID,
          mimeType: 'image/jpeg',
          dateTaken: p.TakenAt ? new Date(p.TakenAt).getTime() : undefined,
        })),
        hasMore: photos.length === pageSize,
      };
    } catch {
      return null;
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const hash = await this.getPhotoHash(ref.sourcePhotoId);
    if (!hash) throw new Error('Photo not found');
    const url = `${this.baseUrl}/api/v1/t/${hash}/${this.downloadToken}/fit_1920`;
    const res = await proxyFetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    const hash = await this.getPhotoHash(ref.sourcePhotoId, signal);
    if (!hash) return null;
    const url = `${this.baseUrl}/api/v1/t/${hash}/${this.downloadToken}/tile_500`;
    try {
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
      const res = await proxyFetch(
        `${this.baseUrl}/api/v1/photos/${ref.sourcePhotoId}/dl`,
        { headers: this.headers(), signal },
      );
      if (!res.ok) return null;
      const blob = await res.blob();
      if (signal?.aborted) return null;
      return new File([blob], ref.name, { type: blob.type });
    } catch {
      return null;
    }
  }

  private photoHashCache = new Map<string, string>();

  private async getPhotoHash(uid: string, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    if (this.photoHashCache.has(uid)) return this.photoHashCache.get(uid)!;
    try {
      const res = await proxyFetch(
        `${this.baseUrl}/api/v1/photos/${uid}`,
        { headers: this.headers(), signal },
      );
      if (!res.ok) return null;
      const data = await res.json() as PhotoPrismPhoto;
      if (signal?.aborted) return null;
      const hash = data.Hash ?? data.Files?.[0]?.Hash;
      if (hash) this.photoHashCache.set(uid, hash);
      return hash ?? null;
    } catch {
      return null;
    }
  }

  /** Re-authenticate if session expired */
  private async ensureSession(): Promise<void> {
    if (this.sessionToken) {
      // Quick check: try a lightweight request
      const res = await proxyFetch(`${this.baseUrl}/api/v1/status`, {
        headers: this.headers(),
      });
      if (res.ok) return;
    }
    await this.authenticate();
  }

  // ─── Extended capabilities ───

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      await this.ensureSession();
      const res = await proxyFetch(
        `${this.baseUrl}/api/v1/photos/${ref.sourcePhotoId}`,
        { headers: this.headers() },
      );
      if (!res.ok) return null;
      const p = await res.json() as PhotoPrismPhoto;
      return {
        camera: p.Camera?.Make && p.Camera?.Model ? `${p.Camera.Make} ${p.Camera.Model}` : p.CameraModel ?? null,
        lens: p.Lens?.Make && p.Lens?.Model ? `${p.Lens.Make} ${p.Lens.Model}` : p.LensModel ?? null,
        iso: p.Iso ?? null,
        focalLength: p.FocalLength ?? null,
        aperture: p.FNumber ?? null,
        shutterSpeed: p.Exposure ?? null,
        width: p.Width ?? null,
        height: p.Height ?? null,
        latitude: p.Lat ?? null,
        longitude: p.Lng ?? null,
        keywords: p.Details?.Keywords?.split(',').map((k: string) => k.trim()).filter(Boolean) ?? [],
        rating: null,
        favorite: p.Favorite ?? false,
        title: p.Title ?? null,
        description: p.Description ?? null,
      };
    } catch {
      return null;
    }
  }

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    try {
      await this.ensureSession();
      const res = await proxyFetch(
        `${this.baseUrl}/api/v1/albums?count=1000&offset=0&type=album`,
        { headers: this.headers() },
      );
      if (!res.ok) return [];
      const albums = await res.json() as PhotoPrismAlbum[];
      return albums.map((a) => ({
        id: a.UID,
        name: a.Title,
        type: 'album' as const,
        photoCount: a.PhotoCount,
      }));
    } catch {
      return [];
    }
  }

  async setFavorite(ref: PhotoRef, favorite: boolean): Promise<boolean> {
    try {
      await this.ensureSession();
      const method = favorite ? 'POST' : 'DELETE';
      const res = await proxyFetch(
        `${this.baseUrl}/api/v1/photos/${ref.sourcePhotoId}/like`,
        { method, headers: this.headers() },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async setTags(ref: PhotoRef, tags: string[]): Promise<boolean> {
    try {
      await this.ensureSession();

      // 1. Get current labels on this photo
      const photoRes = await proxyFetch(
        `${this.baseUrl}/api/v1/photos/${ref.sourcePhotoId}`,
        { headers: this.headers() },
      );
      const currentLabels: { ID: number; Name: string }[] = [];
      if (photoRes.ok) {
        const photo = await photoRes.json();
        for (const pl of photo.Labels ?? []) {
          if (pl.Label?.ID && pl.Label?.Name) {
            currentLabels.push({ ID: pl.Label.ID, Name: pl.Label.Name });
          }
        }
      }

      const desiredLower = new Set(tags.map((t) => t.toLowerCase()));
      const currentLower = new Map(currentLabels.map((l) => [l.Name.toLowerCase(), l.ID]));

      // 2. Remove labels not in desired set
      for (const [name, id] of currentLower) {
        if (!desiredLower.has(name)) {
          await proxyFetch(
            `${this.baseUrl}/api/v1/photos/${ref.sourcePhotoId}/label/${id}`,
            { method: 'DELETE', headers: this.headers() },
          );
        }
      }

      // 3. Add labels not yet assigned
      for (const tag of tags) {
        if (!currentLower.has(tag.toLowerCase())) {
          await proxyFetch(
            `${this.baseUrl}/api/v1/photos/${ref.sourcePhotoId}/label`,
            {
              method: 'POST',
              headers: { ...this.headers(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ Name: tag, Uncertainty: 0 }),
            },
          );
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  async setTitle(ref: PhotoRef, title: string, description?: string): Promise<boolean> {
    try {
      await this.ensureSession();
      const body: Record<string, string> = { Title: title };
      if (description !== undefined) body.Description = description;
      const res = await proxyFetch(
        `${this.baseUrl}/api/v1/photos/${ref.sourcePhotoId}`,
        {
          method: 'PUT',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      await this.ensureSession();
      const formData = new FormData();
      formData.append('files', blob, ref.name);
      const res = await proxyFetch(
        `${this.baseUrl}/api/v1/upload/photolib`,
        { method: 'POST', headers: this.headers(), body: formData },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async createAlbum(name: string): Promise<string | null> {
    try {
      await this.ensureSession();
      const res = await proxyFetch(`${this.baseUrl}/api/v1/albums`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ Title: name, Type: 'album' }),
      });
      if (!res.ok) return null;
      const album = await res.json();
      return album.UID ?? null;
    } catch {
      return null;
    }
  }

  async addToAlbum(albumId: string, refs: PhotoRef[]): Promise<boolean> {
    try {
      await this.ensureSession();
      const photos = refs.map((r) => r.sourcePhotoId);
      const res = await proxyFetch(
        `${this.baseUrl}/api/v1/albums/${albumId}/photos`,
        {
          method: 'POST',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ photos }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}
