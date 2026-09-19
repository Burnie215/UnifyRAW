import type {
  PhotoRef, ExportAssetInput, ExportAssetResult, DeleteResult,
} from './types';
import { ImmichSource } from './ImmichSource';
import type { ImmichAlbum, ImmichAlbums, ImmichConfig } from './ImmichSource';
import { ListingFailures } from './IncompleteListingError';
import { requestExportResponse } from '../export/ExportError';

export type ImmichV3Config = ImmichConfig;

/** Shape of the bits of Immich's AssetResponseDto we actually read. */
interface V3Asset {
  id: string;
  type?: string;
  originalFileName?: string;
  originalMimeType?: string;
  fileCreatedAt?: string;
  fileModifiedAt?: string;
  exifInfo?: { fileSizeInByte?: number };
}

interface V3SearchPage {
  items: V3Asset[];
  /** Immich returns the next page as a string, or null on the last page. */
  nextPage: string | null;
  total?: number;
}

/**
 * SHA1 of the blob, hex-encoded — the value Immich 3.0 expects in
 * `x-immich-checksum`. v3 dropped `deviceAssetId`/`deviceId`, so the
 * content checksum is the only server-side duplicate key left.
 */
async function sha1Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Immich 3.0+ provider.
 *
 * Inherits everything Immich kept stable across the major (thumbnails,
 * originals, single-asset metadata, favorites, tags, album creation) and
 * overrides only what 3.0 actually broke:
 *
 *  - `GET /albums/{id}` no longer returns `assets[]` -> album contents now
 *    come from `POST /search/metadata` with an `albumIds` filter.
 *  - Upload dropped `deviceAssetId`/`deviceId` -> idempotency runs off the
 *    filename pre-check plus the `x-immich-checksum` header.
 *  - Error bodies are sanitized -> "already gone" is decided by HTTP status,
 *    not by matching words in the message.
 *
 * Stacking (`POST /stacks`) and album assignment (`PUT /albums/{id}/assets`)
 * were overridden here too, until F004 showed 2.x speaks the same two verbs;
 * both live in the base class now.
 *
 * See docs/source-api-reference.md section "Immich v3 (3.0+)".
 */
export class ImmichV3Source extends ImmichSource {
  readonly type = 'immich-v3';

  /** One page of `POST /search/metadata`. Returns null on transport failure. */
  private async searchPage(
    filter: Record<string, unknown>,
    page: number,
    size: number,
    signal?: AbortSignal,
  ): Promise<V3SearchPage | null> {
    try {
      const res = await this.request(`${this.baseUrl}/api/search/metadata`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...filter, page, size }),
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return {
        items: data.assets?.items ?? [],
        nextPage: data.assets?.nextPage ?? null,
        total: data.assets?.total,
      };
    } catch {
      return null;
    }
  }

  /**
   * Walk every page of a metadata search. Paging stops on `nextPage: null`,
   * which is authoritative — a short page is not a reliable end-of-list
   * signal once server-side filters are involved.
   */
  private async *searchAll(
    filter: Record<string, unknown>,
    signal?: AbortSignal,
    onFailure?: (what: string) => void,
  ): AsyncIterable<V3Asset> {
    const size = 200;
    let page = 1;
    while (true) {
      const res = await this.searchPage(filter, page, size, signal);
      if (!res) {
        onFailure?.(`search ${JSON.stringify(filter)} page ${page}`);
        return;
      }
      if (res.items.length === 0) return;
      for (const asset of res.items) yield asset;
      if (!res.nextPage) return;
      page++;
    }
  }

  private toPhotoRef(asset: V3Asset, folder: string): PhotoRef {
    return {
      sourcePhotoId: `${folder}/${asset.id}`,
      sourceId: this.id,
      name: asset.originalFileName ?? 'unknown',
      mimeType: asset.originalMimeType,
      sizeBytes: asset.exifInfo?.fileSizeInByte,
      dateTaken: asset.fileCreatedAt ? new Date(asset.fileCreatedAt).getTime() : undefined,
      dateModified: asset.fileModifiedAt ? new Date(asset.fileModifiedAt).getTime() : undefined,
    };
  }

  /**
   * v3's `AlbumResponseDto` has no `assets[]`, so the member ids have to be
   * searched per album. Costs one paged search per album instead of the
   * single detail request v2 needed.
   */
  override async getAlbums(signal?: AbortSignal): Promise<ImmichAlbums> {
    const res = await this.request(`${this.baseUrl}/api/albums`, {
      headers: this.headers(),
      signal,
    });
    if (!res.ok) throw new Error(`Immich album list failed: ${res.status}`);
    const albums: { id: string; albumName?: unknown }[] = await res.json();

    const result: ImmichAlbum[] = [];
    const namelessIds: string[] = [];
    for (const album of albums) {
      // No name, no folder: see the v2 getAlbums. Checked before the member
      // search, which costs a paged request per album.
      const name = this.albumNameOf(album);
      if (name === null) {
        namelessIds.push(album.id);
        continue;
      }

      const assetIds = new Set<string>();
      // A member search cut short is not a smaller album: every id it misses
      // is filed as 'Alle Fotos/<id>' instead of 'Albums/<name>/<id>' and
      // lands in the catalog a second time. v2 throws here, and v3 has no
      // per-album 404 to skip either — the members come from a search, whose
      // failure says nothing about whether the album still exists.
      const failures: string[] = [];
      for await (const asset of this.searchAll({ albumIds: [album.id] }, signal, (what) => { failures.push(what); })) {
        assetIds.add(asset.id);
      }
      if (failures.length > 0) {
        signal?.throwIfAborted();
        throw new Error(`Immich album ${album.id} failed: ${failures[0]}`);
      }
      result.push({ id: album.id, name, assetIds });
    }
    return { albums: result, namelessIds };
  }

  override async *listPhotos(path?: string, signal?: AbortSignal): AsyncIterable<PhotoRef> {
    if (!this.filterAlbumIds || this.filterAlbumIds.length === 0) {
      // No album filter — the inherited paginated path already goes through
      // POST /search/metadata, which is unchanged in v3.
      yield* super.listPhotos(path, signal);
      return;
    }

    const failures = new ListingFailures();
    for (const albumId of this.filterAlbumIds) {
      // The name is part of every sourcePhotoId below, so an album whose name
      // did not arrive - a request that failed or an answer carrying none - is
      // skipped whole, exactly as the v2 branch does (see albumNameOf).
      let albumName: string | null = null;
      try {
        const res = await this.request(`${this.baseUrl}/api/albums/${albumId}`, {
          headers: this.headers(),
          signal,
        });
        if (!res.ok) failures.record(`album ${albumId}: HTTP ${res.status}`);
        else {
          albumName = this.albumNameOf(await res.json());
          if (albumName === null) failures.record(`album ${albumId}: no name`, 'album-without-name');
        }
      } catch {
        failures.record(`album ${albumId}`);
      }
      if (albumName === null) continue;

      for await (const asset of this.searchAll({ albumIds: [albumId], type: 'IMAGE' }, signal, failures.record)) {
        if (asset.type && asset.type !== 'IMAGE') continue;
        yield this.toPhotoRef(asset, `Albums/${albumName}`);
      }
    }
    failures.finish(this.label || 'Immich v3', signal);
  }

  /** First asset with exactly this original filename, or null. */
  private async findByFilename(filename: string): Promise<string | null> {
    const page = await this.searchPage({ originalFileName: filename }, 1, 1);
    return page?.items[0]?.id ?? null;
  }

  /**
   * Idempotency without `deviceAssetId`: the export filename carries the
   * edit-stack hash, so a filename hit means this exact edit was already
   * pushed. The `x-immich-checksum` header is the second line of defence —
   * it makes Immich answer `status: "duplicate"` for byte-identical content
   * that was uploaded under a different name.
   */
  override async exportAsset(input: ExportAssetInput): Promise<ExportAssetResult> {
    const existingId = await this.findByFilename(input.filename);
    if (existingId) {
      await this.placeExportInAlbum(input, existingId);
      return {
        assetId: existingId,
        url: `${this.baseUrl}/api/assets/${existingId}/original`,
        alreadyExisted: true,
      };
    }

    const checksum = await sha1Hex(input.renderedBlob);
    const now = new Date().toISOString();

    const formData = new FormData();
    formData.append('assetData', input.renderedBlob, input.filename);
    formData.append('filename', input.filename);
    formData.append('fileCreatedAt', now);
    formData.append('fileModifiedAt', now);

    const res = await requestExportResponse('Immich', () => this.request(`${this.baseUrl}/api/assets`, {
      method: 'POST',
      headers: { ...this.headers(), 'x-immich-checksum': checksum },
      body: formData,
    }));

    const body = (await res.json()) as { id: string; status?: string };
    const alreadyExisted = body.status === 'duplicate';
    const newAssetId = body.id;

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

  override async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const now = new Date().toISOString();
      const formData = new FormData();
      formData.append('assetData', blob, ref.name);
      formData.append('filename', ref.name);
      formData.append('fileCreatedAt', now);
      formData.append('fileModifiedAt', now);

      const res = await this.request(`${this.baseUrl}/api/assets`, {
        method: 'POST',
        headers: { ...this.headers(), 'x-immich-checksum': await sha1Hex(blob) },
        body: formData,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Same batch-then-per-id strategy as v2, but "already gone" is decided by
   * HTTP status. v3 sanitizes error messages, so the v2 text heuristic
   * ("not found", "no asset.delete access") no longer holds.
   */
  override async deletePhotos(refs: PhotoRef[]): Promise<DeleteResult> {
    const ids = refs.map((r) => this.assetId(r));
    if ((await this.deleteRequest(ids)).ok) {
      return { succeededIds: refs.map((r) => r.sourcePhotoId), failed: [] };
    }

    const succeeded: string[] = [];
    const failed: { sourcePhotoId: string; error: string }[] = [];
    for (const ref of refs) {
      const r = await this.deleteRequest([this.assetId(ref)]);
      // 400/404 mean the asset is not there (or not ours) — either way the
      // catalog row should drop, so treat it as success.
      if (r.ok || r.status === 400 || r.status === 404) succeeded.push(ref.sourcePhotoId);
      else failed.push({ sourcePhotoId: ref.sourcePhotoId, error: `HTTP ${r.status}` });
    }
    return { succeededIds: succeeded, failed };
  }

  private async deleteRequest(ids: string[]): Promise<{ ok: boolean; status: number }> {
    try {
      const res = await this.request(`${this.baseUrl}/api/assets`, {
        method: 'DELETE',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, force: true }),
      });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }
}
