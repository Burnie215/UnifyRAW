import type { SourceProvider, PhotoRef, PhotoPage, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';

export interface GooglePhotosConfig {
  accessToken: string;
  refreshToken?: string;
}

const LIBRARY_BASE = 'https://photoslibrary.googleapis.com/v1';

interface GoogleMediaItem {
  id: string;
  filename?: string;
  mimeType?: string;
  baseUrl?: string;
  description?: string;
  mediaMetadata?: {
    creationTime?: string;
    width?: string;
    height?: string;
    photo?: {
      cameraMake?: string;
      cameraModel?: string;
      isoEquivalent?: number;
      focalLength?: number;
      apertureFNumber?: number;
      exposureTime?: string;
    };
  };
}

interface GoogleMediaItemsResponse {
  mediaItems?: GoogleMediaItem[];
  nextPageToken?: string;
}

export class GooglePhotosSource implements SourceProvider {
  readonly type = 'google-photos';
  readonly id: string;
  readonly label: string;

  private accessToken: string;

  constructor(id: string, label: string, config: GooglePhotosConfig) {
    this.id = id;
    this.label = label;
    this.accessToken = config.accessToken;
  }

  private headers(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.accessToken}` };
  }

  async connect(): Promise<boolean> {
    try {
      // Verify token by listing a single item
      const res = await proxyFetch(`${LIBRARY_BASE}/mediaItems?pageSize=1`, {
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(): AsyncIterable<PhotoRef> {
    let pageToken: string | null = null;

    while (true) {
      const url = pageToken
        ? `${LIBRARY_BASE}/mediaItems?pageSize=100&pageToken=${pageToken}`
        : `${LIBRARY_BASE}/mediaItems?pageSize=100`;

      try {
        const res = await proxyFetch(url, { headers: this.headers() });
        if (!res.ok) break;
        const data = await res.json() as GoogleMediaItemsResponse;

        for (const item of data.mediaItems ?? []) {
          if (!item.mimeType?.startsWith('image/')) continue;
          yield {
            sourcePhotoId: item.id,
            sourceId: this.id,
            name: item.filename ?? item.id,
            mimeType: item.mimeType,
            dateTaken: item.mediaMetadata?.creationTime
              ? new Date(item.mediaMetadata.creationTime).getTime()
              : undefined,
          };
        }

        pageToken = data.nextPageToken ?? null;
        if (!pageToken) break;
      } catch {
        break;
      }
    }
  }

  async listPhotosPage(_page: number, _pageSize: number): Promise<PhotoPage | null> {
    // Google Photos uses cursor-based pagination
    return null;
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    // baseUrl expires after 60 minutes — must re-fetch
    const item = await this.getMediaItem(ref.sourcePhotoId);
    if (!item?.baseUrl) throw new Error('No display URL');
    // Append size params for high-res
    const url = `${item.baseUrl}=w2048-h2048`;
    const res = await proxyFetch(url);
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      const item = await this.getMediaItem(ref.sourcePhotoId, signal);
      if (!item?.baseUrl) return null;
      const url = `${item.baseUrl}=w300-h300`;
      const res = await proxyFetch(url, { signal });
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
      const item = await this.getMediaItem(ref.sourcePhotoId, signal);
      if (!item?.baseUrl) return null;
      // =d suffix downloads original with EXIF
      const url = `${item.baseUrl}=d`;
      const res = await proxyFetch(url, { signal });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (signal?.aborted) return null;
      return new File([blob], ref.name, { type: blob.type });
    } catch {
      return null;
    }
  }

  private async getMediaItem(mediaItemId: string, signal?: AbortSignal): Promise<GoogleMediaItem | null> {
    const res = await proxyFetch(`${LIBRARY_BASE}/mediaItems/${mediaItemId}`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) return null;
    return await res.json() as GoogleMediaItem;
  }

  // ─── Extended capabilities ───

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      const item = await this.getMediaItem(ref.sourcePhotoId);
      if (!item) return null;
      const photo = item.mediaMetadata?.photo ?? {};
      return {
        camera: photo.cameraMake && photo.cameraModel ? `${photo.cameraMake} ${photo.cameraModel}` : photo.cameraModel ?? null,
        lens: null,
        iso: photo.isoEquivalent ? Number(photo.isoEquivalent) : null,
        focalLength: photo.focalLength ?? null,
        aperture: photo.apertureFNumber ?? null,
        shutterSpeed: photo.exposureTime ?? null,
        width: item.mediaMetadata?.width ? Number(item.mediaMetadata.width) : null,
        height: item.mediaMetadata?.height ? Number(item.mediaMetadata.height) : null,
        latitude: null, // Google Photos API doesn't expose GPS
        longitude: null,
        keywords: [],
        rating: null,
        favorite: false,
        title: null,
        description: item.description ?? null,
      };
    } catch {
      return null;
    }
  }

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    try {
      const items: SourceBrowseItem[] = [];
      let pageToken: string | null = null;

      while (true) {
        const url = pageToken
          ? `${LIBRARY_BASE}/albums?pageSize=50&pageToken=${pageToken}`
          : `${LIBRARY_BASE}/albums?pageSize=50`;
        const res = await proxyFetch(url, { headers: this.headers() });
        if (!res.ok) break;
        const data = await res.json();

        for (const album of data.albums ?? []) {
          items.push({
            id: album.id,
            name: album.title ?? album.id,
            type: 'album',
            photoCount: album.mediaItemsCount ? Number(album.mediaItemsCount) : undefined,
          });
        }

        pageToken = data.nextPageToken ?? null;
        if (!pageToken) break;
      }
      return items;
    } catch {
      return [];
    }
  }
}
