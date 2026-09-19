import type { SourceProvider, PhotoRef, PhotoPage, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';

export interface PiwigoConfig {
  serverUrl: string;
  apiKey: string;
}

interface PiwigoImageSummary {
  id: string | number;
  file?: string;
  name?: string;
  date_creation?: string;
}

interface PiwigoImageInfo {
  element_url?: string;
  derivatives?: Record<string, { url?: string }>;
  tags?: Array<{ name: string }>;
  width?: number;
  height?: number;
  latitude?: string;
  longitude?: string;
  rating_score?: string;
  name?: string;
  comment?: string;
}

interface PiwigoCategory {
  id: string | number;
  name: string;
  nb_images?: number;
  sub_categories?: PiwigoCategory[];
}

interface PiwigoExifEntry {
  tag?: string;
  label?: string;
  value?: string;
  raw?: string;
}

interface PiwigoTag {
  id: number;
  name: string;
}

export class PiwigoSource implements SourceProvider {
  readonly type = 'piwigo';
  readonly id: string;
  readonly label: string;

  private baseUrl: string;
  private apiKey: string;

  constructor(id: string, label: string, config: PiwigoConfig) {
    this.id = id;
    this.label = label;
    this.baseUrl = config.serverUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
  }

  private headers(): Record<string, string> {
    return { 'X-PIWIGO-API': this.apiKey };
  }

  private async rpc<T>(
    method: string,
    params?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const body = new URLSearchParams({ method, format: 'json', ...params });
    const res = await proxyFetch(`${this.baseUrl}/ws.php?format=json`, {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
    });
    if (!res.ok) throw new Error(`Piwigo ${method} failed: ${res.status}`);
    const data = await res.json() as { stat?: string; message?: string; result: T };
    if (data.stat !== 'ok') throw new Error(`Piwigo ${method}: ${data.message ?? 'error'}`);
    return data.result;
  }

  async connect(): Promise<boolean> {
    try {
      await this.rpc<unknown>('pwg.session.getStatus');
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(): AsyncIterable<PhotoRef> {
    let page = 0;
    const perPage = 200;
    while (true) {
      const result = await this.listPhotosPage(page + 1, perPage);
      if (!result || result.photos.length === 0) break;
      for (const photo of result.photos) yield photo;
      if (!result.hasMore) break;
      page++;
    }
  }

  async listPhotosPage(page: number, pageSize: number): Promise<PhotoPage | null> {
    try {
      const result = await this.rpc<{
        images?: PiwigoImageSummary[];
        paging?: { page: number; per_page: number; total_count: number };
      }>('pwg.categories.getImages', {
        per_page: String(pageSize),
        page: String(page - 1), // Piwigo pages are 0-based
        recursive: 'true',
      });

      const images = result.images ?? [];
      const paging = result.paging;

      return {
        photos: images.map((img) => ({
          sourcePhotoId: String(img.id),
          sourceId: this.id,
          name: img.file ?? img.name ?? `${img.id}`,
          mimeType: 'image/jpeg',
          dateTaken: img.date_creation ? new Date(img.date_creation).getTime() : undefined,
        })),
        hasMore: paging ? (paging.page + 1) * paging.per_page < paging.total_count : images.length === pageSize,
        total: paging?.total_count,
      };
    } catch {
      return null;
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const info = await this.rpc<PiwigoImageInfo>('pwg.images.getInfo', { image_id: ref.sourcePhotoId });
    const url = info.derivatives?.xxlarge?.url ?? info.derivatives?.xlarge?.url ?? info.element_url;
    if (!url) throw new Error('No display URL');
    const res = await proxyFetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      const info = await this.rpc<PiwigoImageInfo>(
        'pwg.images.getInfo',
        { image_id: ref.sourcePhotoId },
        signal,
      );
      const url = info.derivatives?.medium?.url ?? info.derivatives?.thumb?.url;
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
      const info = await this.rpc<PiwigoImageInfo>(
        'pwg.images.getInfo',
        { image_id: ref.sourcePhotoId },
        signal,
      );
      const url = info.element_url;
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

  // ─── Extended capabilities ───

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      const info = await this.rpc<PiwigoImageInfo>('pwg.images.getInfo', { image_id: ref.sourcePhotoId });
      // Fetch EXIF separately for camera/lens details
      const exifData: Record<string, string> = {};
      try {
        const exifResult = await this.rpc<PiwigoExifEntry[]>(
          'pwg.images.getExif',
          { image_id: ref.sourcePhotoId },
        );
        for (const entry of exifResult) {
          const key = entry.tag ?? entry.label;
          const value = entry.value ?? entry.raw;
          if (key && value) exifData[key] = value;
        }
      } catch { /* EXIF not available */ }

      const tags: string[] = (info.tags ?? []).map((t: { name: string }) => t.name);

      return {
        camera: exifData['Model'] ?? exifData['Camera'] ?? null,
        lens: exifData['LensModel'] ?? exifData['Lens'] ?? null,
        iso: exifData['ISOSpeedRatings'] ? Number(exifData['ISOSpeedRatings']) : null,
        focalLength: exifData['FocalLength'] ? parseFloat(exifData['FocalLength']) : null,
        aperture: exifData['FNumber'] ? parseFloat(exifData['FNumber']) : null,
        shutterSpeed: exifData['ExposureTime'] ?? null,
        width: info.width ?? null,
        height: info.height ?? null,
        latitude: info.latitude ? parseFloat(info.latitude) : null,
        longitude: info.longitude ? parseFloat(info.longitude) : null,
        keywords: tags,
        rating: info.rating_score ? Math.round(parseFloat(info.rating_score)) : null,
        favorite: false,
        title: info.name ?? null,
        description: info.comment ?? null,
      };
    } catch {
      return null;
    }
  }

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    try {
      const result = await this.rpc<{ categories?: PiwigoCategory[] } | PiwigoCategory[]>(
        'pwg.categories.getList', {
        recursive: 'true',
        tree_output: 'true',
      });
      const categories = Array.isArray(result) ? result : result.categories ?? [];
      return this.mapCategories(categories);
    } catch {
      return [];
    }
  }

  private mapCategories(cats: PiwigoCategory[]): SourceBrowseItem[] {
    return cats.map((c) => ({
      id: String(c.id),
      name: c.name,
      type: 'category' as const,
      photoCount: c.nb_images,
      children: c.sub_categories ? this.mapCategories(c.sub_categories) : undefined,
    }));
  }

  async setRating(ref: PhotoRef, rating: number): Promise<boolean> {
    try {
      await this.rpc<unknown>('pwg.images.rate', {
        image_id: ref.sourcePhotoId,
        rate: String(Math.max(1, Math.min(5, rating))),
      });
      return true;
    } catch {
      return false;
    }
  }

  async setTags(ref: PhotoRef, tags: string[]): Promise<boolean> {
    try {
      // Get existing tags to find/create IDs
      const allTags = await this.rpc<{ tags?: PiwigoTag[] }>('pwg.tags.getAdminList')
        .then((result) => result.tags ?? [])
        .catch((): PiwigoTag[] => []);
      const tagMap = new Map(allTags.map((t) => [t.name.toLowerCase(), t.id]));

      const tagIds: number[] = [];
      for (const tag of tags) {
        let tagId = tagMap.get(tag.toLowerCase());
        if (tagId === undefined) {
          try {
            const created = await this.rpc<{ id?: number }>('pwg.tags.add', { name: tag });
            tagId = created.id;
          } catch { continue; }
        }
        if (tagId !== undefined) tagIds.push(tagId);
      }

      await this.rpc<unknown>('pwg.images.setTags', {
        image_id: ref.sourcePhotoId,
        tags: tagIds.join(','),
      });
      return true;
    } catch {
      return false;
    }
  }

  async setTitle(ref: PhotoRef, title: string, description?: string): Promise<boolean> {
    try {
      const params: Record<string, string> = {
        image_id: ref.sourcePhotoId,
        name: title,
      };
      if (description !== undefined) params.comment = description;
      await this.rpc<unknown>('pwg.images.setInfo', params);
      return true;
    } catch {
      return false;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('method', 'pwg.images.addSimple');
      formData.append('image', blob, ref.name);
      const res = await proxyFetch(`${this.baseUrl}/ws.php?format=json`, {
        method: 'POST',
        headers: this.headers(),
        body: formData,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createAlbum(name: string, parentId?: string): Promise<string | null> {
    try {
      const params: Record<string, string> = { name };
      if (parentId) params.parent = parentId;
      const result = await this.rpc<{ id?: string | number }>('pwg.categories.add', params);
      return result.id ? String(result.id) : null;
    } catch {
      return null;
    }
  }

  async addToAlbum(albumId: string, refs: PhotoRef[]): Promise<boolean> {
    try {
      for (const ref of refs) {
        await this.rpc<unknown>('pwg.images.setCategory', {
          image_id: ref.sourcePhotoId,
          category_id: albumId,
        });
      }
      return true;
    } catch {
      return false;
    }
  }
}
