import type {
  SourceProvider, PhotoRef, PhotoPage,
  SourceMetadata, SourceBrowseItem, SourceExportCapabilities,
  ExportAssetInput, ExportAssetResult,
} from './types';
import {
  createSourceFetch,
  resolveSourceTransportMode,
  type SourceFetch,
  type SourceTransportConfig,
  type SourceTransportMode,
} from '../platform/sourceTransport';
import { getBrand } from '../brand';
import { isStale, markStaleAll, dedupeFetch, dedupeObjectUrlFetch } from './staleAssetCache';
import { ListingFailures, type ListingSkip } from './IncompleteListingError';
import {
  classifySourceConnectionFailure,
  classifySourceConnectionResponse,
  type SourceConnectionError,
} from './connectionError';
import { requestExportResponse } from '../export/ExportError';

export interface ImmichConfig extends SourceTransportConfig {
  serverUrl: string;
  apiKey: string;
  /** If set, only import photos from these album IDs */
  albumIds?: string[];
}

/**
 * Keep a single canonical server base for both supported configuration forms:
 * `https://immich.example` and `https://immich.example/api`.
 *
 * Provider methods append Immich's `/api/...` routes themselves, so retaining
 * a configured `/api` suffix would otherwise produce `/api/api/...` requests.
 */
export function normalizeImmichBaseUrl(serverUrl: string): string {
  return serverUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api$/i, '');
}

/** One Immich album as the album map uses it. */
export interface ImmichAlbum {
  id: string;
  name: string;
  assetIds: Set<string>;
}

/** What `getAlbums` could build, and what it had to leave out. */
export interface ImmichAlbums {
  albums: ImmichAlbum[];
  /**
   * Albums the server answered without a name. They get no folder at all -
   * see `albumNameOf` for why no stand-in is acceptable - so the listing that
   * uses this map is incomplete and must not let a refresh prune.
   */
  namelessIds: string[];
}

export class ImmichSource implements SourceProvider {
  // Widened from the inferred literal so ImmichV3Source can override it.
  readonly type: string = 'immich';
  // `protected` rather than `private` so ImmichV3Source can reuse them; the
  // v3 subclass overrides only the endpoints Immich 3.0 actually changed.
  protected baseUrl: string;
  protected apiKey: string;
  protected albumMap: Map<string, string[]> | null = null;
  /** Ids of the albums the cached map has no folder for; empty until it is built. */
  protected namelessAlbumIds: string[] = [];
  protected filterAlbumIds: string[] | undefined;
  protected readonly transportMode: SourceTransportMode;
  protected readonly request: SourceFetch;
  private connectionError: SourceConnectionError | null = null;

  readonly id: string;
  readonly label: string;

  constructor(
    id: string,
    label: string,
    config: ImmichConfig,
    // ImmichV3Source inherits this constructor, and its own `type` field is
    // not initialised yet while this runs — so the type is passed, not read.
    sourceType: string = 'immich',
  ) {
    this.id = id;
    this.label = label;
    this.baseUrl = normalizeImmichBaseUrl(config.serverUrl);
    this.apiKey = config.apiKey;
    this.filterAlbumIds = config.albumIds;
    this.transportMode = resolveSourceTransportMode(config.transport, sourceType);
    this.request = createSourceFetch(this.transportMode);
  }

  protected headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey };
  }

  async connect(): Promise<boolean> {
    this.connectionError = null;
    try {
      const res = await this.request(`${this.baseUrl}/api/server/ping`, {
        headers: this.headers(),
      });
      if (res.ok) return true;
      this.connectionError = await classifySourceConnectionResponse(
        res,
        this.transportMode,
        this.label || (this.type === 'immich-v3' ? 'Immich v3' : 'Immich v2'),
      );
      return false;
    } catch (cause) {
      this.connectionError = classifySourceConnectionFailure(
        cause,
        this.transportMode,
        this.label || (this.type === 'immich-v3' ? 'Immich v3' : 'Immich v2'),
      );
      return false;
    }
  }

  getConnectionError(): SourceConnectionError | null {
    return this.connectionError;
  }

  async disconnect(): Promise<void> {}

  /** Drop the cached album map so the next scan re-reads albums from the server. */
  refresh(): void {
    this.albumMap = null;
    this.namelessAlbumIds = [];
  }

  /**
   * All albums with their asset IDs. Throws when the server does not answer:
   * "no albums" and "albums unknown" file the same assets under different
   * sourcePhotoIds, so a failure must not look like an empty list. An album
   * deleted between the list and its detail request (404) is skipped.
   *
   * An album the server carries WITHOUT a name is skipped too, and reported in
   * `namelessIds` rather than thrown: one such album used to make the whole
   * map unknown, and with it the whole source list nothing. Its photos simply
   * get no album folder in this listing (see `albumNameOf`), and the listing
   * that uses the map counts as incomplete, so nothing is pruned behind them.
   */
  async getAlbums(signal?: AbortSignal): Promise<ImmichAlbums> {
    const res = await this.request(`${this.baseUrl}/api/albums`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new Error(`Immich album list failed: ${res.status}`);

    const albums: { id: string; albumName?: unknown }[] = await res.json();
    const result: ImmichAlbum[] = [];
    const namelessIds: string[] = [];

    for (const album of albums) {
      // The name is part of every sourcePhotoId this map produces, so an album
      // the server named nothing cannot be filed: 'Albums/undefined/<id>' is a
      // fabricated folder, shared by every nameless album, and its rows land
      // next to the ones the catalog already holds. No folder is the only
      // honest answer; the detail request is not worth spending on it.
      const name = this.albumNameOf(album);
      if (name === null) {
        namelessIds.push(album.id);
        continue;
      }

      const detailRes = await this.request(`${this.baseUrl}/api/albums/${album.id}`, {
        headers: this.headers(),
        signal,
      });
      if (detailRes.status === 404) continue;
      if (!detailRes.ok) throw new Error(`Immich album ${album.id} failed: ${detailRes.status}`);
      const detail = await detailRes.json();
      const assetIds = new Set<string>(
        (detail.assets ?? []).map((a: { id: string }) => a.id),
      );
      result.push({ id: album.id, name, assetIds });
    }

    return { albums: result, namelessIds };
  }

  /** The gaps in the cached album map, in the shape a listing reports them. */
  protected albumMapSkips(): ListingSkip[] {
    return this.namelessAlbumIds.map((id) => ({
      kind: 'album-without-name' as const,
      detail: `album ${id}: no name`,
    }));
  }

  /**
   * The album's own name, or null when the answer carries none. The name is
   * part of every sourcePhotoId of the album-filtered listing, so a stand-in is
   * not a cosmetic choice: under it the album's photos arrive as
   * 'Albums/Album/<id>' next to the rows they already have under their real
   * name, and every nameless album shares that one folder. An album the server
   * answered without a name is therefore skipped and reported, exactly like one
   * whose request failed.
   */
  protected albumNameOf(detail: { albumName?: unknown } | null): string | null {
    const name = detail?.albumName;
    return typeof name === 'string' && name !== '' ? name : null;
  }

  async *listPhotos(_path?: string, signal?: AbortSignal): AsyncIterable<PhotoRef> {
    const failures = new ListingFailures();
    const sourceName = this.label || 'Immich';
    // If filtering by albums, load directly from album endpoints
    if (this.filterAlbumIds && this.filterAlbumIds.length > 0) {
      for (const albumId of this.filterAlbumIds) {
        try {
          const res = await this.request(`${this.baseUrl}/api/albums/${albumId}`, {
            headers: this.headers(),
            signal,
          });
          if (!res.ok) {
            console.log('[immich] album fetch failed', albumId, res.status);
            failures.record(`album ${albumId}: HTTP ${res.status}`);
            continue;
          }
          const detail = await res.json();
          const albumName = this.albumNameOf(detail);
          if (albumName === null) {
            failures.record(`album ${albumId}: no name`, 'album-without-name');
            continue;
          }
          for (const asset of detail.assets ?? []) {
            if (asset.type !== 'IMAGE') continue;
            yield {
              sourcePhotoId: `Albums/${albumName}/${asset.id}`,
              sourceId: this.id,
              name: asset.originalFileName ?? 'unknown',
              mimeType: asset.originalMimeType,
              sizeBytes: asset.exifInfo?.fileSizeInByte,
              dateTaken: asset.fileCreatedAt ? new Date(asset.fileCreatedAt).getTime() : undefined,
              dateModified: asset.fileModifiedAt ? new Date(asset.fileModifiedAt).getTime() : undefined,
            };
          }
        } catch {
          failures.record(`album ${albumId}`);
          continue;
        }
      }
      failures.finish(sourceName, signal);
      return;
    }

    // Default: paginated loading of all photos
    let page = 1;
    const pageSize = 200;

    while (true) {
      const result = await this.listPhotosPage(page, pageSize, signal);
      // listPhotosPage answers every failure with null; only an empty page ends the list.
      if (!result) {
        failures.record(`page ${page}`);
        break;
      }
      // A page can arrive whole and still be filed through an album map with
      // gaps; `finish` folds the repeats of the same album into one.
      for (const skip of result.skipped ?? []) failures.record(skip.detail, skip.kind);
      if (result.photos.length === 0) break;
      for (const photo of result.photos) yield photo;
      if (!result.hasMore) break;
      page++;
    }
    failures.finish(sourceName, signal);
  }

  /** Build assetId → albumNames lookup (cached) */
  protected async ensureAlbumMap(signal?: AbortSignal): Promise<Map<string, string[]>> {
    if (this.albumMap) return this.albumMap;
    const map = new Map<string, string[]>();
    this.albumMap = map;
    let answer: ImmichAlbums;
    try {
      answer = await this.getAlbums(signal);
    } catch (error) {
      this.albumMap = null;
      throw error;
    }
    if (signal?.aborted) {
      // The album folder is part of every sourcePhotoId; a map cut short by
      // the abort would file photos under the wrong folder on the next page.
      this.albumMap = null;
      signal.throwIfAborted();
    }
    this.namelessAlbumIds = answer.namelessIds;
    for (const album of answer.albums) {
      for (const assetId of album.assetIds) {
        const existing = map.get(assetId);
        if (existing) existing.push(album.name);
        else map.set(assetId, [album.name]);
      }
    }
    return map;
  }

  async listPhotosPage(
    page: number,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<PhotoPage | null> {
    // If filtering by albums, don't use paginated endpoint — use listPhotos instead
    if (this.filterAlbumIds && this.filterAlbumIds.length > 0) {
      return null; // Forces useSources to use listPhotos() which respects album filter
    }

    try {
      // Load album map on first page
      if (page === 1) {
        await this.ensureAlbumMap(signal);
      }

      const res = await this.request(`${this.baseUrl}/api/search/metadata`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: pageSize, page, type: 'IMAGE' }),
        signal,
      });

      if (!res.ok) return null;

      const data = await res.json();
      const assets = data.assets?.items ?? [];
      const total = data.assets?.total ?? undefined;

      const photos: PhotoRef[] = assets.map((asset: Record<string, unknown>) => {
        const assetId = asset.id as string;
        const albumNames = this.albumMap?.get(assetId);
        // Path: Albums/AlbumName/assetId or Alle Fotos/assetId
        const folder = albumNames ? `Albums/${albumNames[0]}` : 'Alle Fotos';

        return {
          sourcePhotoId: `${folder}/${assetId}`,
          sourceId: this.id,
          name: (asset.originalFileName as string) ?? 'unknown',
          mimeType: asset.originalMimeType as string | undefined,
          sizeBytes: (asset.exifInfo as Record<string, unknown>)?.fileSizeInByte as number | undefined,
          dateTaken: asset.fileCreatedAt ? new Date(asset.fileCreatedAt as string).getTime() : undefined,
          dateModified: asset.fileModifiedAt ? new Date(asset.fileModifiedAt as string).getTime() : undefined,
        };
      });

      // Immich's own end-of-list marker (docs/source-api-reference.md:88). A
      // page length cannot be one here: `type: 'IMAGE'` is a server-side
      // filter, so the server hands back a short page in the middle of the
      // library whenever it dropped that page's videos. Ending there raises no
      // failure, so the walk counts as complete - and complete is what lets a
      // full refresh soft-delete everything behind it. A deployment that does
      // not report the field at all leaves only the page length; reading its
      // absence as "no next page" would end every walk after page 1.
      const nextPage = data.assets?.nextPage;
      const hasMore = nextPage === undefined ? assets.length >= pageSize : nextPage !== null;

      // Every page of this walk is filed through the same album map, so every
      // page carries its gaps. Reporting them once would tie the report to the
      // page that happened to build the map; a walk that starts elsewhere, or
      // takes page 1 twice, would then miscount.
      return { photos, hasMore, total, skipped: this.albumMapSkips() };
    } catch {
      return null;
    }
  }

  /** Extract asset UUID from sourcePhotoId (Albums/Name/UUID or Alle Fotos/UUID) */
  protected assetId(ref: PhotoRef): string {
    const parts = ref.sourcePhotoId.split('/');
    return parts[parts.length - 1];
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    if (isStale(ref.sourceId, ref.sourcePhotoId, 'display')) {
      throw new Error('Asset previously reported missing — skipping');
    }
    const url = await dedupeObjectUrlFetch(ref.sourceId, ref.sourcePhotoId, 'display', async () => {
      const id = this.assetId(ref);
      const res = await this.request(
        `${this.baseUrl}/api/assets/${id}/thumbnail?size=preview`,
        { headers: this.headers() },
      );
      if (!res.ok) {
        if (res.status === 400 || res.status === 404) {
          markStaleAll(ref.sourceId, ref.sourcePhotoId);
        }
        throw new Error(`Failed to load image: ${res.status}`);
      }
      return res.blob();
    });
    if (!url) throw new Error('Failed to load image');
    return url;
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted || isStale(ref.sourceId, ref.sourcePhotoId, 'thumb')) return null;
    return dedupeObjectUrlFetch(ref.sourceId, ref.sourcePhotoId, 'thumb', async () => {
      try {
        const id = this.assetId(ref);
        const res = await this.request(
          `${this.baseUrl}/api/assets/${id}/thumbnail?size=thumbnail`,
          { headers: this.headers(), signal },
        );
        if (!res.ok) {
          if (res.status === 400 || res.status === 404) {
            // Mark all ops stale — a deleted Immich asset returns 4xx
            // from every endpoint, so caching just 'thumb' would let
            // subsequent getFile/getDisplayUrl calls re-hit the upstream.
            markStaleAll(ref.sourceId, ref.sourcePhotoId);
          }
          return null;
        }
        const blob = await res.blob();
        return signal?.aborted ? null : blob;
      } catch {
        return null;
      }
    }, signal);
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted || isStale(ref.sourceId, ref.sourcePhotoId, 'file')) return null;
    return dedupeFetch(ref.sourceId, ref.sourcePhotoId, 'file', async () => {
      try {
        const id = this.assetId(ref);
        const res = await this.request(
          `${this.baseUrl}/api/assets/${id}/original`,
          { headers: this.headers(), signal },
        );
        if (!res.ok) {
          if (res.status === 400 || res.status === 404) {
            markStaleAll(ref.sourceId, ref.sourcePhotoId);
          }
          return null;
        }
        const blob = await res.blob();
        if (signal?.aborted) return null;
        return new File([blob], ref.name, { type: blob.type });
      } catch {
        return null;
      }
    }, signal);
  }

  /**
   * Server-side fetch descriptor for the RAW smart-preview fast path —
   * lets the backend pull the original file directly from Immich instead
   * of routing the 25-50 MB RAW through the user's browser.
   */
  getRemoteFetchHint(ref: PhotoRef): { url: string; headers: Record<string, string> } | null {
    if (this.transportMode === 'browser-direct') return null;
    return {
      url: `${this.baseUrl}/api/assets/${this.assetId(ref)}/original`,
      headers: this.headers(),
    };
  }

  // ─── Extended capabilities ───

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      const id = this.assetId(ref);
      const res = await this.request(`${this.baseUrl}/api/assets/${id}`, {
        headers: this.headers(),
      });
      if (!res.ok) return null;
      const asset = await res.json();
      const exif = asset.exifInfo ?? {};
      return {
        camera: exif.make && exif.model ? `${exif.make} ${exif.model}` : exif.model ?? null,
        lens: exif.lensModel ?? null,
        iso: exif.iso ?? null,
        focalLength: exif.focalLength ?? null,
        aperture: exif.fNumber ?? null,
        shutterSpeed: exif.exposureTime ?? null,
        width: exif.exifImageWidth ?? null,
        height: exif.exifImageHeight ?? null,
        latitude: exif.latitude ?? null,
        longitude: exif.longitude ?? null,
        keywords: [],
        rating: null,
        favorite: asset.isFavorite ?? false,
        title: null,
        description: asset.exifInfo?.description ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * The albums the picker offers. An album the server carries without a name
   * arrives here too, and gets no name invented for it (see `albumNameOf`):
   * the empty name is what the picker turns into "without a name", the same
   * thing the listing says about it.
   */
  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    try {
      const res = await this.request(`${this.baseUrl}/api/albums`, {
        headers: this.headers(),
      });
      if (!res.ok) return [];
      const albums: { id: string; albumName?: unknown; assetCount?: number }[] = await res.json();
      return albums.map((a) => ({
        id: a.id,
        name: this.albumNameOf(a) ?? '',
        type: 'album' as const,
        photoCount: a.assetCount,
      }));
    } catch {
      return [];
    }
  }

  async setFavorite(ref: PhotoRef, favorite: boolean): Promise<boolean> {
    try {
      const id = this.assetId(ref);
      const res = await this.request(`${this.baseUrl}/api/assets/${id}`, {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ isFavorite: favorite }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async setTags(ref: PhotoRef, tags: string[]): Promise<boolean> {
    try {
      const id = this.assetId(ref);

      // 1. Get all existing tags
      const tagsRes = await this.request(`${this.baseUrl}/api/tags`, {
        headers: this.headers(),
      });
      if (!tagsRes.ok) return false;
      const allTags: { id: string; name: string }[] = await tagsRes.json();
      const tagMap = new Map(allTags.map((t) => [t.name.toLowerCase(), t.id]));

      // 2. Get asset detail to find currently assigned tags
      const assetRes = await this.request(`${this.baseUrl}/api/assets/${id}`, {
        headers: this.headers(),
      });
      const asset = assetRes.ok ? await assetRes.json() : null;
      const currentTagIds = new Set<string>(
        (asset?.tags ?? []).map((t: { id: string }) => t.id),
      );

      // 3. Resolve desired tag names → IDs (create if needed)
      const desiredTagIds = new Set<string>();
      for (const tag of tags) {
        let tagId = tagMap.get(tag.toLowerCase());
        if (!tagId) {
          const createRes = await this.request(`${this.baseUrl}/api/tags`, {
            method: 'POST',
            headers: { ...this.headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: tag, type: 'OBJECT' }),
          });
          if (!createRes.ok) continue;
          const created = await createRes.json();
          tagId = created.id;
        }
        if (tagId) desiredTagIds.add(tagId);
      }

      // 4. Add new tags (not yet assigned)
      for (const tagId of desiredTagIds) {
        if (!currentTagIds.has(tagId)) {
          await this.request(`${this.baseUrl}/api/tags/${tagId}/assets`, {
            method: 'PUT',
            headers: { ...this.headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetIds: [id] }),
          });
        }
      }

      // 5. Remove old tags (no longer desired)
      // Note: Immich tag API doesn't have a direct "remove asset from tag" endpoint,
      // so we skip removal to avoid data loss. Tags are additive-only in Immich.

      return true;
    } catch {
      return false;
    }
  }

  /**
   * `dng` is in the list because Immich's own extension map carries it:
   * `.dng` sits in the `raw` group of `server/src/utils/mime-types.ts`, that
   * group is merged into `image`, and `mimeTypes.isAsset` - the gate the
   * upload route gets its accept-list from - answers yes for it.
   *
   * What that buys is storage, not necessarily a picture. Immich thumbnails a
   * RAW through libvips/LibRaw, and LibRaw leaves float samples in
   * `float_image` unless it is asked to convert them, which is the same limit
   * `DngEncoder.browser.test.ts` pins down for the bundled libraw-wasm. The
   * asset uploads, stacks and downloads correctly either way; whether its
   * preview renders has to be measured against a running instance.
   */
  readonly exportCapabilities: SourceExportCapabilities = {
    canWrite: true,
    supportsStacking: 'native-id',
    allowedFormats: ['jpg', 'tif', 'png', 'dng'],
    filenameStrategy: 'free',
    albumPlacement: 'same',
  };

  /**
   * Push edited render back as new asset and stack it under the original.
   * Idempotency: `deviceAssetId` is derived from the edit-stack hash, so a
   * re-export of the same edit hits Immich's "already exists" path and we
   * return the existing asset id without uploading again.
   */
  async exportAsset(input: ExportAssetInput): Promise<ExportAssetResult> {
    const vendor = getBrand().vendorId;
    const deviceAssetId = `${vendor.toLowerCase()}-edit-${input.editStackHash.slice(0, 16)}`;
    const deviceId = vendor;

    const formData = new FormData();
    formData.append('assetData', input.renderedBlob, input.filename);
    formData.append('deviceAssetId', deviceAssetId);
    formData.append('deviceId', deviceId);
    formData.append('fileCreatedAt', new Date().toISOString());
    formData.append('fileModifiedAt', new Date().toISOString());

    const res = await requestExportResponse('Immich', () => this.request(`${this.baseUrl}/api/assets`, {
      method: 'POST',
      headers: this.headers(),
      body: formData,
    }));
    const body = (await res.json()) as { id: string; status?: string };
    const alreadyExisted = body.status === 'duplicate';
    const newAssetId = body.id;

    // Only a fresh upload is stacked: a duplicate already sits in the stack
    // the earlier export built.
    if (!alreadyExisted) {
      await this.stackUnderOriginal(this.assetId(input.original), newAssetId);
    }
    await this.placeExportInAlbum(input, newAssetId);

    return {
      assetId: newAssetId,
      url: `${this.baseUrl}/api/assets/${newAssetId}/original`,
      alreadyExisted,
    };
  }

  /**
   * Put the exported asset into the original's stack. `POST /stacks` is the
   * only route that stacks in 2.x and 3.x alike. The stack-parent field this
   * used to send on `PUT /assets` is not part of `AssetBulkUpdateDto`, and
   * that route answers 204 whatever it is handed — so the old call reported
   * success while nothing was ever stacked.
   *
   * The first id becomes the stack primary, which keeps the original the face
   * of the stack. Stacking is a nice-to-have: the asset is uploaded either
   * way, so a failure is logged, never thrown.
   */
  protected async stackUnderOriginal(parentId: string, newAssetId: string): Promise<void> {
    // A stack needs two distinct assets (StackCreateDto: minItems 2).
    if (!parentId || !newAssetId || parentId === newAssetId) return;
    try {
      const res = await this.request(`${this.baseUrl}/api/stacks`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetIds: [parentId, newAssetId] }),
      });
      if (!res.ok) console.warn(`[Immich] stack failed: HTTP ${res.status}`);
    } catch (e) {
      console.warn('[Immich] stack failed:', e);
    }
  }

  /** Keep an exported asset beside its original without making placement fatal to the upload. */
  protected async placeExportInAlbum(input: ExportAssetInput, newAssetId: string): Promise<void> {
    try {
      let albumId = input.targetAlbumId;
      if (!albumId) {
        const originalId = this.assetId(input.original);
        const res = await this.request(
          `${this.baseUrl}/api/albums?assetId=${encodeURIComponent(originalId)}`,
          { headers: this.headers() },
        );
        if (!res.ok) {
          console.warn(`[Immich] album lookup failed: HTTP ${res.status}`);
          return;
        }
        const albums = await res.json() as unknown;
        albumId = Array.isArray(albums) && typeof albums[0]?.id === 'string'
          ? albums[0].id
          : undefined;
      }
      if (!albumId) return;

      const added = await this.addToAlbum(albumId, [{
        sourceId: this.id,
        sourcePhotoId: newAssetId,
        name: input.filename,
      }]);
      if (!added) console.warn(`[Immich] album placement failed: ${albumId}`);
    } catch (error) {
      console.warn('[Immich] album placement failed:', error);
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const formData = new FormData();
      formData.append('assetData', blob, ref.name);
      const vendor = getBrand().vendorId;
      formData.append('deviceAssetId', `${vendor.toLowerCase()}-edit-${Date.now()}`);
      formData.append('deviceId', vendor);
      formData.append('fileCreatedAt', new Date().toISOString());
      formData.append('fileModifiedAt', new Date().toISOString());
      const res = await this.request(`${this.baseUrl}/api/assets`, {
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
      const res = await this.request(`${this.baseUrl}/api/albums`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ albumName: name }),
      });
      if (!res.ok) return null;
      const album = await res.json();
      return album.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Immich exposes this as PUT in 2.x and 3.x alike — there is no POST route
   * (docs/source-api-reference.md:185), so the POST this sent was a 404.
   */
  async addToAlbum(albumId: string, refs: PhotoRef[]): Promise<boolean> {
    try {
      const ids = refs.map((r) => this.assetId(r));
      const res = await this.request(`${this.baseUrl}/api/albums/${albumId}/assets`, {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Reports back the caller's own `sourcePhotoId` (`Albums/<album>/<assetId>`),
   * never the bare Immich asset id: the catalog matches rows by that full id,
   * so a stripped id silently leaves the row behind after a successful delete.
   */
  async deletePhotos(refs: PhotoRef[]): Promise<import('./types').DeleteResult> {
    const ids = refs.map((r) => this.assetId(r));
    const batch = await this.deleteBatch(ids);
    if (batch.kind === 'ok') return { succeededIds: refs.map((r) => r.sourcePhotoId), failed: [] };

    // Immich's batch endpoint fails the whole request if any single id is
    // unknown (or the token lacks asset.delete on it). Fall back to a
    // per-id pass so the remaining valid ids still get deleted, and treat
    // "not found / no access" as already-deleted (success from PhotoLib's
    // POV — the catalog row should drop either way).
    const succeeded: string[] = [];
    const failed: { sourcePhotoId: string; error: string }[] = [];
    for (const ref of refs) {
      const r = await this.deleteBatch([this.assetId(ref)]);
      if (r.kind === 'ok' || isAlreadyGoneError(r.detail)) {
        succeeded.push(ref.sourcePhotoId);
      } else {
        failed.push({ sourcePhotoId: ref.sourcePhotoId, error: r.detail });
      }
    }
    return { succeededIds: succeeded, failed };
  }

  protected async deleteBatch(ids: string[]): Promise<{ kind: 'ok' } | { kind: 'err'; detail: string }> {
    try {
      const res = await this.request(`${this.baseUrl}/api/assets`, {
        method: 'DELETE',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, force: true }),
      });
      if (res.ok) return { kind: 'ok' };
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.text();
        const parsed = JSON.parse(body);
        const m = parsed?.message ?? parsed?.error;
        if (typeof m === 'string') detail = `${detail}: ${m}`;
      } catch { /* */ }
      return { kind: 'err', detail };
    } catch (e) {
      return { kind: 'err', detail: e instanceof Error ? e.message : 'network error' };
    }
  }
}

function isAlreadyGoneError(detail: string): boolean {
  const lower = detail.toLowerCase();
  return lower.includes('not found') || lower.includes('no asset.delete access');
}
