import type { SourceProvider, PhotoRef, PhotoPage, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';

export interface FlickrConfig {
  apiKey: string;
  userId: string;
}

const REST_BASE = 'https://www.flickr.com/services/rest/';

interface FlickrPhotoSummary {
  id: string;
  title?: string;
  media?: string;
  datetaken?: string;
}

interface FlickrText {
  _content?: string;
}

interface FlickrPhotoInfo {
  id: string;
  server: string;
  secret: string;
  title?: FlickrText;
  description?: FlickrText;
  tags?: { tag?: Array<{ raw?: string; _content?: string }> };
}

interface FlickrSize {
  label?: string;
  source?: string;
}

interface FlickrPhotoSet {
  id: string;
  title?: FlickrText | string;
  photos?: string | number;
}

export class FlickrSource implements SourceProvider {
  readonly type = 'flickr';
  readonly id: string;
  readonly label: string;

  private apiKey: string;
  private userId: string;

  constructor(id: string, label: string, config: FlickrConfig) {
    this.id = id;
    this.label = label;
    this.apiKey = config.apiKey;
    this.userId = config.userId;
  }

  private async call<T>(
    method: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const urlParams = new URLSearchParams({
      method, api_key: this.apiKey, format: 'json', nojsoncallback: '1',
      ...params,
    });
    const res = await proxyFetch(`${REST_BASE}?${urlParams}`, { signal });
    if (!res.ok) throw new Error(`Flickr ${method} failed: ${res.status}`);
    const data = await res.json() as T & { stat?: string; message?: string };
    if (data.stat !== 'ok') throw new Error(`Flickr ${method}: ${data.message}`);
    return data;
  }

  async connect(): Promise<boolean> {
    try {
      await this.call<unknown>('flickr.people.getInfo', { user_id: this.userId });
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(): AsyncIterable<PhotoRef> {
    let page = 1;
    const perPage = 500;
    while (true) {
      const result = await this.listPhotosPage(page, perPage);
      if (!result || result.photos.length === 0) break;
      for (const photo of result.photos) yield photo;
      if (!result.hasMore) break;
      page++;
    }
  }

  async listPhotosPage(page: number, pageSize: number): Promise<PhotoPage | null> {
    try {
      const data = await this.call<{
        photos?: { photo?: FlickrPhotoSummary[]; pages?: number; total?: number };
      }>('flickr.people.getPhotos', {
        user_id: this.userId,
        per_page: String(pageSize),
        page: String(page),
        extras: 'url_sq,url_m,url_l,url_o,date_taken,geo,tags,media',
      });

      const photos = data.photos?.photo ?? [];
      const pages = data.photos?.pages ?? 1;

      return {
        photos: photos
          .filter((photo) => photo.media === 'photo')
          .map((photo) => ({
            sourcePhotoId: photo.id,
            sourceId: this.id,
            name: photo.title || `${photo.id}.jpg`,
            mimeType: 'image/jpeg',
            dateTaken: photo.datetaken ? new Date(photo.datetaken).getTime() : undefined,
          })),
        hasMore: page < pages,
        total: data.photos?.total,
      };
    } catch {
      return null;
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const sizes = await this.getSizes(ref.sourcePhotoId);
    const url = sizes.find((size) => size.label === 'Large')?.source
      ?? sizes.find((size) => size.label === 'Original')?.source;
    if (!url) throw new Error('No display URL');
    const res = await proxyFetch(url);
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      // Use static URL scheme — no API call needed
      const info = await this.call<{ photo?: FlickrPhotoInfo }>(
        'flickr.photos.getInfo',
        { photo_id: ref.sourcePhotoId },
        signal,
      );
      const p = info.photo;
      if (!p) return null;
      const url = `https://live.staticflickr.com/${p.server}/${p.id}_${p.secret}_m.jpg`;
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
      const sizes = await this.getSizes(ref.sourcePhotoId, signal);
      const original = sizes.find((size) => size.label === 'Original');
      if (!original?.source) return null;
      const res = await proxyFetch(original.source, { signal });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (signal?.aborted) return null;
      return new File([blob], ref.name, { type: blob.type });
    } catch {
      return null;
    }
  }

  private async getSizes(photoId: string, signal?: AbortSignal): Promise<FlickrSize[]> {
    const data = await this.call<{ sizes?: { size?: FlickrSize[] } }>(
      'flickr.photos.getSizes',
      { photo_id: photoId },
      signal,
    );
    return data.sizes?.size ?? [];
  }

  // ─── Extended capabilities ───
  // No write methods: every Flickr write needs OAuth 1.0a signing, which this
  // provider does not do. writeCapabilitiesOf() therefore reports all false.

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      const infoData = await this.call<{ photo?: FlickrPhotoInfo }>(
        'flickr.photos.getInfo',
        { photo_id: ref.sourcePhotoId },
      );
      const p = infoData.photo;
      if (!p) return null;

      // Fetch EXIF data
      const exif: Record<string, string> = {};
      try {
        const exifData = await this.call<{
          photo?: { exif?: Array<{ tag: string; raw?: FlickrText }> };
        }>('flickr.photos.getExif', { photo_id: ref.sourcePhotoId });
        for (const entry of exifData.photo?.exif ?? []) {
          exif[entry.tag] = entry.raw?._content ?? '';
        }
      } catch { /* EXIF may not be available */ }

      // Fetch GPS
      let lat: number | null = null, lng: number | null = null;
      try {
        const geoData = await this.call<{
          photo?: { location?: { latitude?: string; longitude?: string } };
        }>('flickr.photos.geo.getLocation', { photo_id: ref.sourcePhotoId });
        lat = geoData.photo?.location?.latitude ? parseFloat(geoData.photo.location.latitude) : null;
        lng = geoData.photo?.location?.longitude ? parseFloat(geoData.photo.location.longitude) : null;
      } catch { /* no geo */ }

      const tags = (p.tags?.tag ?? [])
        .map((tag) => tag.raw ?? tag._content)
        .filter((tag): tag is string => typeof tag === 'string');

      return {
        camera: exif['Model'] ?? null,
        lens: exif['LensModel'] ?? exif['Lens'] ?? null,
        iso: exif['ISO'] ? Number(exif['ISO']) : null,
        focalLength: exif['FocalLength'] ? parseFloat(exif['FocalLength']) : null,
        aperture: exif['FNumber'] ? parseFloat(exif['FNumber']) : null,
        shutterSpeed: exif['ExposureTime'] ?? null,
        width: null,
        height: null,
        latitude: lat,
        longitude: lng,
        keywords: tags,
        rating: null,
        favorite: false,
        title: p.title?._content ?? null,
        description: p.description?._content ?? null,
      };
    } catch {
      return null;
    }
  }

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    try {
      const data = await this.call<{
        photosets?: { photoset?: FlickrPhotoSet[] };
      }>('flickr.photosets.getList', {
        user_id: this.userId,
        per_page: '500',
      });
      const sets = data.photosets?.photoset ?? [];
      return sets.map((s) => ({
        id: s.id,
        name: typeof s.title === 'string' ? s.title : s.title?._content ?? s.id,
        type: 'photoset' as const,
        photoCount: s.photos ? Number(s.photos) : undefined,
      }));
    } catch {
      return [];
    }
  }
}
