import type {
  PhotoLibrary,
  PhotoLibraryAsset,
  PhotoLibrarySourceConfig,
} from '@photolib/shared';
import {
  deletePhotoLibrary,
  fetchPhotoLibraryAssetOriginal,
  fetchPhotoLibraryAssetThumbnail,
  getPhotoLibrary,
  getPhotoLibraryAsset,
  importFileIntoPhotoLibrary,
  listPhotoLibraryAssetChanges,
  listPhotoLibraryAssets,
  scanPhotoLibrary,
  trashPhotoLibraryAsset,
} from '../platform/libraryApi';
import type {
  PhotoPage,
  PhotoRef,
  SourceChangePage,
  SourceMetadata,
  SourceProvider,
  WriteCapabilities,
  DeleteResult,
} from './types';

export type PhotoLibLibraryConfig = PhotoLibrarySourceConfig;

export class PhotoLibLibrarySource implements SourceProvider {
  readonly type = 'photolib-library';
  private library: PhotoLibrary | null = null;
  private readonly cursorsByPage = new Map<number, string | null>([[1, null]]);
  readonly id: string;
  readonly label: string;
  private readonly config: PhotoLibLibraryConfig;

  constructor(
    id: string,
    label: string,
    config: PhotoLibLibraryConfig,
  ) {
    this.id = id;
    this.label = label;
    this.config = config;
  }

  async connect(): Promise<boolean> {
    try {
      this.library = await getPhotoLibrary(this.config.libraryId);
      return true;
    } catch {
      this.library = null;
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.library = null;
    this.cursorsByPage.clear();
    this.cursorsByPage.set(1, null);
  }

  async *listPhotos(_path?: string, signal?: AbortSignal): AsyncIterable<PhotoRef> {
    let cursor: string | null = null;
    do {
      const page = await listPhotoLibraryAssets(this.config.libraryId, { cursor, limit: 500, signal });
      for (const asset of page.assets) yield this.toPhotoRef(asset);
      cursor = page.nextCursor;
    } while (cursor);
  }

  async listPhotosPage(page: number, pageSize: number, signal?: AbortSignal): Promise<PhotoPage | null> {
    if (!Number.isInteger(page) || page < 1) return null;
    const cursor = this.cursorsByPage.get(page);
    if (cursor === undefined) return null;
    const result = await listPhotoLibraryAssets(this.config.libraryId, {
      cursor,
      limit: Math.min(Math.max(pageSize, 1), 500),
      signal,
    });
    if (result.nextCursor) this.cursorsByPage.set(page + 1, result.nextCursor);
    else this.cursorsByPage.delete(page + 1);
    return {
      photos: result.assets.map((asset) => this.toPhotoRef(asset)),
      hasMore: result.hasMore,
    };
  }

  async listChanges(afterRevision: number, limit: number, signal?: AbortSignal): Promise<SourceChangePage> {
    const result = await listPhotoLibraryAssetChanges(
      this.config.libraryId,
      afterRevision,
      Math.min(Math.max(limit, 1), 500),
      signal,
    );
    return {
      photos: result.assets.map((asset) => this.toPhotoRef(asset)),
      nextRevision: result.nextAfterRevision,
      hasMore: result.hasMore,
      sourceRevision: result.libraryRevision,
    };
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const response = await fetchPhotoLibraryAssetOriginal(this.config.libraryId, ref.sourcePhotoId);
    return URL.createObjectURL(await response.blob());
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      const response = await fetchPhotoLibraryAssetThumbnail(
        this.config.libraryId,
        ref.sourcePhotoId,
        'small',
        signal,
      );
      const blob = await response.blob();
      return signal?.aborted ? null : URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    try {
      const response = await fetchPhotoLibraryAssetOriginal(
        this.config.libraryId,
        ref.sourcePhotoId,
        signal,
      );
      const blob = await response.blob();
      if (signal?.aborted) return null;
      return new File([blob], ref.name, {
        type: blob.type || ref.mimeType || 'application/octet-stream',
        lastModified: ref.dateModified ?? Date.now(),
      });
    } catch {
      return null;
    }
  }

  getRawPreviewHint(ref: PhotoRef): { url: string } {
    return {
      url: `/api/libraries/${encodeURIComponent(this.config.libraryId)}`
        + `/assets/${encodeURIComponent(ref.sourcePhotoId)}/raw-preview`,
    };
  }

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      const asset = await getPhotoLibraryAsset(this.config.libraryId, ref.sourcePhotoId);
      return {
        width: asset.width,
        height: asset.height,
        camera: asset.metadata?.camera,
        lens: asset.metadata?.lens,
        iso: asset.metadata?.iso,
        focalLength: asset.metadata?.focalLength,
        aperture: asset.metadata?.aperture,
        shutterSpeed: asset.metadata?.shutterSpeed,
      };
    } catch {
      return null;
    }
  }

  /** deletePhotos exists unconditionally; a library without a trash must not offer it. */
  writeRestrictions(): Partial<WriteCapabilities> {
    return { canDelete: this.library?.capabilities.canTrash ?? false };
  }

  async refresh(): Promise<void> {
    this.cursorsByPage.clear();
    this.cursorsByPage.set(1, null);
    await scanPhotoLibrary(this.config.libraryId);
    this.library = await getPhotoLibrary(this.config.libraryId);
  }

  async importFiles(
    files: readonly File[],
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.library?.capabilities.canImport) {
      throw new Error('This PhotoLib library does not accept imports');
    }
    let completed = 0;
    onProgress?.(completed, files.length);
    for (const file of files) {
      signal?.throwIfAborted();
      await importFileIntoPhotoLibrary(this.config.libraryId, file, signal);
      completed++;
      onProgress?.(completed, files.length);
    }
  }

  async deletePhotos(refs: PhotoRef[]): Promise<DeleteResult> {
    if (!this.library?.capabilities.canTrash) {
      return {
        succeededIds: [],
        failed: refs.map((ref) => ({
          sourcePhotoId: ref.sourcePhotoId,
          error: 'This PhotoLib library is read-only',
        })),
      };
    }
    const result: DeleteResult = { succeededIds: [], failed: [] };
    for (const ref of refs) {
      try {
        await trashPhotoLibraryAsset(this.config.libraryId, ref.sourcePhotoId);
        result.succeededIds.push(ref.sourcePhotoId);
      } catch (error) {
        result.failed.push({
          sourcePhotoId: ref.sourcePhotoId,
          error: error instanceof Error ? error.message : 'Could not move asset to trash',
        });
      }
    }
    return result;
  }

  getLibrary(): PhotoLibrary | null {
    return this.library;
  }

  async deleteLibrary(): Promise<void> {
    await deletePhotoLibrary(this.config.libraryId);
  }

  private toPhotoRef(asset: PhotoLibraryAsset): PhotoRef {
    return {
      sourcePhotoId: asset.id,
      sourceId: this.id,
      name: asset.name,
      mimeType: asset.mimeType ?? undefined,
      sizeBytes: asset.sizeBytes,
      dateTaken: asset.dateTaken ?? undefined,
      dateModified: asset.dateModified,
      contentHash: asset.quickHash,
      sourcePath: asset.relativePath,
      availability: asset.status,
      sourceRevision: asset.revision,
      width: asset.width,
      height: asset.height,
      camera: asset.metadata?.camera,
      lens: asset.metadata?.lens,
      iso: asset.metadata?.iso,
      focalLength: asset.metadata?.focalLength,
      aperture: asset.metadata?.aperture,
      shutterSpeed: asset.metadata?.shutterSpeed,
    };
  }
}
