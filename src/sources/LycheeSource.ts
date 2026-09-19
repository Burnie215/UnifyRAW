import type {
  SourceProvider, PhotoRef, SourceMetadata, SourceBrowseItem, SourceExportCapabilities,
  ExportAssetInput, ExportAssetResult, DeleteResult,
} from './types';
import { BaseHttpSource } from './BaseHttpSource';
import { dedupeFetch, dedupeObjectUrlFetch, isStale, markStaleAll } from './staleAssetCache';
import { ListingFailures } from './IncompleteListingError';
import type { SourceTransportConfig } from '../platform/sourceTransport';
import {
  classifySourceConnectionFailure,
  classifySourceConnectionResponse,
  SourceConnectionError,
} from './connectionError';
import { requestExportResponse } from '../export/ExportError';

export interface LycheeConfig extends SourceTransportConfig {
  serverUrl: string;
  apiToken: string;
}

interface LycheeSizeVariant {
  url: string;
  width?: number;
  height?: number;
  filesize?: number;
}

interface LycheePhoto {
  id: string;
  album_id?: string | null;
  title?: string;
  description?: string;
  type?: string;
  tags?: string[];
  taken_at?: string | null;
  is_highlighted?: boolean;
  size_variants?: {
    thumb?: LycheeSizeVariant;
    small?: LycheeSizeVariant;
    small2x?: LycheeSizeVariant;
    medium?: LycheeSizeVariant;
    medium2x?: LycheeSizeVariant;
    original?: LycheeSizeVariant;
  };
  preformatted?: {
    aperture?: string | null;
    focal?: string | null;
    iso?: string | null;
    lens?: string | null;
    make?: string | null;
    model?: string | null;
    shutter?: string | null;
    latitude?: string | number | null;
    longitude?: string | number | null;
  };
  rating?: { rating?: number | null } | null;
}

interface LycheeAlbumThumb {
  id: string;
  title: string;
  parent_id?: string | null;
  num_photos?: number;
}

interface LycheePagedAlbums {
  data?: LycheeAlbumThumb[];
  current_page?: number;
  last_page?: number;
}

interface LycheePagedPhotos {
  photos?: LycheePhoto[];
  data?: LycheePhoto[];
  current_page?: number;
  last_page?: number;
}

const SMART_ALBUM_UNSORTED = 'unsorted';

function extFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split('?')[0].split('#')[0];
  const seg = path.substring(path.lastIndexOf('/') + 1);
  const dot = seg.lastIndexOf('.');
  if (dot <= 0 || dot === seg.length - 1) return null;
  const ext = seg.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,5}$/.test(ext)) return null;
  return ext;
}

function buildPhotoName(photo: LycheePhoto): string {
  const base = photo.title ?? photo.id;
  if (base.includes('.')) return base;
  const ext = extFromUrl(photo.size_variants?.original?.url);
  return ext ? `${base}.${ext}` : base;
}

export class LycheeSource extends BaseHttpSource implements SourceProvider {
  readonly type = 'lychee';
  private apiToken: string;
  private connectionError: SourceConnectionError | null = null;

  constructor(id: string, label: string, config: LycheeConfig) {
    super(id, label, config.serverUrl, config.transport, 'lychee');
    this.apiToken = config.apiToken;
  }

  protected authHeaders(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.apiToken}` };
  }

  async connect(): Promise<boolean> {
    this.connectionError = null;
    try {
      const res = await this.request(this.resolveUrl('/api/v2/Albums'), {
        method: 'GET',
        headers: this.jsonHeaders(),
      });
      if (!res.ok) {
        this.connectionError = await classifySourceConnectionResponse(
          res,
          this.transportMode,
          this.label || 'Lychee',
        );
        return false;
      }
      try {
        const body: unknown = await res.json();
        if (body === null) throw new Error('Empty JSON response');
        return true;
      } catch {
        this.connectionError = new SourceConnectionError('source-invalid-response', {
          sourceName: this.label || 'Lychee',
          status: res.status,
        });
        return false;
      }
    } catch (cause) {
      this.connectionError = classifySourceConnectionFailure(
        cause,
        this.transportMode,
        this.label || 'Lychee',
      );
      return false;
    }
  }

  getConnectionError(): SourceConnectionError | null {
    return this.connectionError;
  }

  async disconnect(): Promise<void> {}

  /** Drop cached photo metadata so the next scan re-fetches it. */
  refresh(): void {
    this.photoCache.clear();
  }

  async *listPhotos(path?: string, signal?: AbortSignal): AsyncIterable<PhotoRef> {
    const failures = new ListingFailures();
    const seenIds = new Set<string>();
    const albumIds = path
      ? [path]
      : [...await this.collectAllAlbumIds(signal, failures.record), SMART_ALBUM_UNSORTED];

    for (const albumId of albumIds) {
      for await (const photo of this.iterAlbumPhotos(albumId, signal, failures.record)) {
        if (seenIds.has(photo.id)) continue;
        seenIds.add(photo.id);
        this.photoCache.set(photo.id, photo);
        yield {
          sourcePhotoId: photo.id,
          sourceId: this.id,
          name: buildPhotoName(photo),
          mimeType: photo.type ?? 'image/jpeg',
          dateTaken: photo.taken_at ? new Date(photo.taken_at).getTime() : undefined,
        };
      }
    }
    failures.finish(this.label || 'Lychee', signal);
  }

  private iterAlbumPhotos(
    albumId: string,
    signal?: AbortSignal,
    onFailure?: (what: string) => void,
  ): AsyncIterable<LycheePhoto> {
    return this.paginatePageNum<LycheePhoto>(
      (page) => `/api/v2/Album::photos?album_id=${encodeURIComponent(albumId)}&page=${page}`,
      (body) => {
        const b = body as LycheePagedPhotos;
        return {
          // Lychee v7 returns photos under "photos"; older versions used "data".
          items: b.photos ?? b.data ?? [],
          current: b.current_page,
          last: b.last_page,
        };
      },
      signal,
      onFailure,
    );
  }

  /** Sammelt alle regulären Album-IDs (rekursiv, exkl. Smart/Tag). */
  private async collectAllAlbumIds(signal?: AbortSignal, onFailure?: (what: string) => void): Promise<string[]> {
    const ids: string[] = [];
    const root = await this.getJson<{
      albums?: LycheeAlbumThumb[];
      shared_albums?: LycheeAlbumThumb[];
    }>('/api/v2/Albums', signal);
    if (!root) {
      onFailure?.('/api/v2/Albums');
      return ids;
    }
    const topLevel = [...(root.albums ?? []), ...(root.shared_albums ?? [])];
    for (const album of topLevel) {
      ids.push(album.id);
      await this.collectChildAlbumIds(album.id, ids, signal, onFailure);
    }
    return ids;
  }

  private async collectChildAlbumIds(
    parentId: string,
    into: string[],
    signal?: AbortSignal,
    onFailure?: (what: string) => void,
  ): Promise<void> {
    const childIter = this.paginatePageNum<LycheeAlbumThumb>(
      (page) => `/api/v2/Album::albums?album_id=${encodeURIComponent(parentId)}&page=${page}`,
      (body) => {
        const b = body as LycheePagedAlbums;
        return { items: b.data ?? [], current: b.current_page, last: b.last_page };
      },
      signal,
      onFailure,
    );
    for await (const child of childIter) {
      into.push(child.id);
      await this.collectChildAlbumIds(child.id, into, signal, onFailure);
    }
  }

  // The same negative cache as Immich: a photo deleted in Lychee answers 404
  // from every variant, and each tile mount would ask again.
  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    if (isStale(ref.sourceId, ref.sourcePhotoId, 'display')) {
      throw new Error('Asset previously reported missing — skipping');
    }
    const obj = await dedupeObjectUrlFetch(ref.sourceId, ref.sourcePhotoId, 'display', async () => {
      const photo = await this.ensurePhotoCache(ref.sourcePhotoId);
      const url = photo?.size_variants?.original?.url ?? photo?.size_variants?.medium?.url;
      if (!url) return null;
      return this.fetchAsBlob(url, () => markStaleAll(ref.sourceId, ref.sourcePhotoId));
    });
    if (!obj) throw new Error('Failed to fetch display URL');
    return obj;
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted || isStale(ref.sourceId, ref.sourcePhotoId, 'thumb')) return null;
    return dedupeObjectUrlFetch(ref.sourceId, ref.sourcePhotoId, 'thumb', async () => {
      const photo = await this.ensurePhotoCache(ref.sourcePhotoId, signal);
      const url = photo?.size_variants?.thumb?.url ?? photo?.size_variants?.small?.url;
      if (!url) return null;
      return this.fetchAsBlob(url, () => markStaleAll(ref.sourceId, ref.sourcePhotoId), signal);
    }, signal);
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted || isStale(ref.sourceId, ref.sourcePhotoId, 'file')) return null;
    return dedupeFetch(ref.sourceId, ref.sourcePhotoId, 'file', async () => {
      const photo = await this.ensurePhotoCache(ref.sourcePhotoId, signal);
      const url = photo?.size_variants?.original?.url;
      if (!url) return null;
      return this.fetchAsFile(
        url,
        ref.name,
        () => markStaleAll(ref.sourceId, ref.sourcePhotoId),
        signal,
      );
    }, signal);
  }

  private photoCache = new Map<string, LycheePhoto>();

  /** Lazy-populate Cache: wenn Photo unbekannt, alle Alben durchgehen. */
  private async ensurePhotoCache(photoId: string, signal?: AbortSignal): Promise<LycheePhoto | null> {
    if (signal?.aborted) return null;
    const cached = this.photoCache.get(photoId);
    if (cached) return cached;
    const albumIds = [...await this.collectAllAlbumIds(signal), SMART_ALBUM_UNSORTED];
    for (const albumId of albumIds) {
      for await (const photo of this.iterAlbumPhotos(albumId, signal)) {
        if (signal?.aborted) return null;
        this.photoCache.set(photo.id, photo);
        if (photo.id === photoId) return photo;
      }
    }
    return null;
  }

  // ─── Extended capabilities ───

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    const photo = await this.ensurePhotoCache(ref.sourcePhotoId);
    if (!photo) return null;
    const pf = photo.preformatted ?? {};
    const lat = typeof pf.latitude === 'string' ? parseFloat(pf.latitude) : pf.latitude ?? null;
    const lon = typeof pf.longitude === 'string' ? parseFloat(pf.longitude) : pf.longitude ?? null;
    return {
      camera: pf.make && pf.model ? `${pf.make} ${pf.model}` : pf.model ?? null,
      lens: pf.lens ?? null,
      iso: pf.iso ? parseInt(pf.iso, 10) : null,
      focalLength: pf.focal ? parseFloat(pf.focal) : null,
      aperture: pf.aperture ? parseFloat(pf.aperture) : null,
      shutterSpeed: pf.shutter ?? null,
      width: photo.size_variants?.original?.width ?? null,
      height: photo.size_variants?.original?.height ?? null,
      latitude: Number.isFinite(lat as number) ? (lat as number) : null,
      longitude: Number.isFinite(lon as number) ? (lon as number) : null,
      keywords: photo.tags ?? [],
      rating: photo.rating?.rating ?? null,
      favorite: photo.is_highlighted ?? false,
      title: photo.title ?? null,
      description: photo.description ?? null,
    };
  }

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    const root = await this.getJson<{
      albums?: LycheeAlbumThumb[];
      shared_albums?: LycheeAlbumThumb[];
    }>('/api/v2/Albums');
    if (!root) return [];
    const topLevel = [...(root.albums ?? []), ...(root.shared_albums ?? [])];
    const result: SourceBrowseItem[] = [];
    for (const album of topLevel) {
      result.push(await this.buildBrowseItem(album));
    }
    return result;
  }

  private async buildBrowseItem(album: LycheeAlbumThumb): Promise<SourceBrowseItem> {
    const children = await this.fetchChildAlbums(album.id);
    return {
      id: album.id,
      name: album.title,
      type: 'album',
      photoCount: album.num_photos,
      children: children.length > 0 ? children : undefined,
    };
  }

  private async fetchChildAlbums(parentId: string): Promise<SourceBrowseItem[]> {
    const result: SourceBrowseItem[] = [];
    const iter = this.paginatePageNum<LycheeAlbumThumb>(
      (page) => `/api/v2/Album::albums?album_id=${encodeURIComponent(parentId)}&page=${page}`,
      (body) => {
        const b = body as LycheePagedAlbums;
        return { items: b.data ?? [], current: b.current_page, last: b.last_page };
      },
    );
    for await (const child of iter) {
      result.push(await this.buildBrowseItem(child));
    }
    return result;
  }

  async setFavorite(ref: PhotoRef, favorite: boolean): Promise<boolean> {
    return this.sendJson('POST', '/api/v2/Photo::highlight', {
      photos: [ref.sourcePhotoId], is_highlighted: favorite,
    });
  }

  async setRating(ref: PhotoRef, rating: number): Promise<boolean> {
    const clamped = Math.max(1, Math.min(5, Math.round(rating)));
    return this.sendJson('POST', '/api/v2/Photo::setRating', {
      photo: ref.sourcePhotoId, rating: clamped,
    });
  }

  async setTags(ref: PhotoRef, tags: string[]): Promise<boolean> {
    return this.sendJson('PATCH', '/api/v2/Photo::tags', {
      photos: [ref.sourcePhotoId], tags, shall_override: true,
    });
  }

  async setTitle(ref: PhotoRef, title: string, description?: string): Promise<boolean> {
    const titleOk = await this.sendJson('PATCH', '/api/v2/Photo::rename', {
      photo: ref.sourcePhotoId, title,
    });
    if (!titleOk) return false;
    if (description !== undefined) {
      const descOk = await this.sendJson('PATCH', '/api/v2/Photo', {
        photo: ref.sourcePhotoId, description,
      });
      if (!descOk) return false;
    }
    return true;
  }

  /**
   * No `tif` and no `dng`, and both omissions are Lychee's rule rather than
   * ours. `FileExtensionService::SUPPORTED_IMAGE_FILE_EXTENSIONS` is jpg, png,
   * gif, webp, avif, heic, heif - TIFF is not in it. `.dng` only appears in
   * `CONVERTIBLE_RAW_EXTENSIONS`, and that list is merged into the accepted
   * extensions ONLY when the instance has Imagick; otherwise the admin has to
   * put it into the `raw_formats` setting by hand, which defaults to `.tex`.
   *
   * Neither condition is visible from the client, and an upload that fails the
   * extension check is refused outright. Declaring `dng` here would offer a
   * button that most installations answer with an error, so the conservative
   * answer stands until a real instance says otherwise.
   */
  readonly exportCapabilities: SourceExportCapabilities = {
    canWrite: true,
    supportsStacking: false,
    allowedFormats: ['jpg', 'png'],
    filenameStrategy: 'free',
    albumPlacement: 'same',
  };

  /**
   * Push edited render back into the same album as the original.
   * Idempotency: before uploading we list the album's photos and skip when
   * a photo with the target filename already exists (the filename carries
   * the edit-stack hash). Lychee has no native stacking, so original and
   * edit live as siblings.
   */
  async exportAsset(input: ExportAssetInput): Promise<ExportAssetResult> {
    const photo = await this.ensurePhotoCache(input.original.sourcePhotoId);
    const albumId = input.targetAlbumId ?? photo?.album_id ?? '';

    if (albumId) {
      const data = await this.postJson<{ photos?: Array<{ id: string; title?: string }> }>(
        '/api/v2/Album', { album_id: albumId },
      );
      if (data) {
        const stem = input.filename.replace(/\.[^.]+$/, '');
        const existing = data.photos?.find((p) => p.title === stem || p.title === input.filename);
        if (existing) {
          return { assetId: existing.id, alreadyExisted: true };
        }
      }
      // Listing failed → fall through and try the upload anyway.
    }

    const ext = input.filename.includes('.') ? input.filename.slice(input.filename.lastIndexOf('.')) : '.jpg';
    const formData = new FormData();
    formData.append('album_id', albumId);
    formData.append('file', input.renderedBlob, input.filename);
    formData.append('file_name', input.filename);
    formData.append('uuid_name', crypto.randomUUID());
    formData.append('extension', ext);
    formData.append('chunk_number', '1');
    formData.append('total_chunks', '1');
    const res = await requestExportResponse('Lychee', () => this.request(this.resolveUrl('/api/v2/Photo'), {
      method: 'POST',
      headers: this.multipartHeaders(),
      body: formData,
    }));
    const body = await res.text();
    let newId = '';
    try {
      const parsed = JSON.parse(body);
      newId = typeof parsed === 'string' ? parsed : (parsed?.id ?? '');
    } catch {
      newId = body.trim().replace(/^"|"$/g, '');
    }
    return { assetId: newId, alreadyExisted: false };
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const photo = await this.ensurePhotoCache(ref.sourcePhotoId);
      const albumId = photo?.album_id ?? '';
      const ext = ref.name.includes('.') ? ref.name.slice(ref.name.lastIndexOf('.')) : '.jpg';
      const formData = new FormData();
      formData.append('album_id', albumId);
      formData.append('file', blob, ref.name);
      formData.append('file_name', ref.name);
      formData.append('uuid_name', crypto.randomUUID());
      formData.append('extension', ext);
      formData.append('chunk_number', '1');
      formData.append('total_chunks', '1');
      const res = await this.request(this.resolveUrl('/api/v2/Photo'), {
        method: 'POST',
        headers: this.multipartHeaders(),
        body: formData,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createAlbum(name: string, parentId?: string): Promise<string | null> {
    const data = await this.postText('/api/v2/Album', { title: name, parent_album: parentId ?? null });
    if (data === null) return null;
    const trimmed = data.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : (parsed?.id ?? null);
    } catch {
      return trimmed || null;
    }
  }

  async addToAlbum(albumId: string, refs: PhotoRef[]): Promise<boolean> {
    return this.sendJson('POST', '/api/v2/Photo::move', {
      photos: refs.map((r) => r.sourcePhotoId),
      album: albumId,
    });
  }

  async deletePhotos(refs: PhotoRef[]): Promise<DeleteResult> {
    // Lychee requires `photo_ids` + `from_id` (the album-context). One DELETE per album.
    const byAlbum = new Map<string, string[]>();
    for (const r of refs) {
      const cached = this.photoCache.get(r.sourcePhotoId);
      const albumId = cached?.album_id ?? SMART_ALBUM_UNSORTED;
      const list = byAlbum.get(albumId) ?? [];
      list.push(r.sourcePhotoId);
      byAlbum.set(albumId, list);
    }

    const succeededIds: string[] = [];
    const failed: { sourcePhotoId: string; error: string }[] = [];

    for (const [albumId, photoIds] of byAlbum) {
      try {
        const res = await this.request(this.resolveUrl('/api/v2/Photo'), {
          method: 'DELETE',
          headers: this.jsonHeaders(),
          body: JSON.stringify({ photo_ids: photoIds, from_id: albumId }),
        });
        if (res.ok) {
          for (const id of photoIds) { this.photoCache.delete(id); succeededIds.push(id); }
        } else {
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.text();
            const parsed = JSON.parse(body);
            const m = parsed?.message ?? parsed?.error;
            if (typeof m === 'string') detail = `${detail}: ${m}`;
          } catch { /* keep generic */ }
          for (const id of photoIds) failed.push({ sourcePhotoId: id, error: detail });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'network error';
        for (const id of photoIds) failed.push({ sourcePhotoId: id, error: msg });
      }
    }
    return { succeededIds, failed };
  }
}
