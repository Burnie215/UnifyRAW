import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { LibraryRequestError } from './library.errors.js';
import { isPathInside } from './library.paths.js';
import { LibraryStorage } from './library.storage.js';

export type LibraryThumbnailSize = 'small' | 'large';

export interface ResolvedLibraryThumbnail {
  filePath: string;
  etag: string;
}

const PIXELS_BY_SIZE: Readonly<Record<LibraryThumbnailSize, number>> = {
  small: 320,
  large: 1280,
};

export class LibraryThumbnailService {
  private readonly inFlight = new Map<string, Promise<ResolvedLibraryThumbnail>>();

  constructor(
    private readonly storage: LibraryStorage,
    private readonly thumbnailRoot: string | undefined,
  ) {}

  getOrCreate(
    ownerId: string,
    libraryId: string,
    assetId: string,
    size: LibraryThumbnailSize,
  ): Promise<ResolvedLibraryThumbnail> {
    const key = `${ownerId}\0${libraryId}\0${assetId}\0${size}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = this.create(ownerId, libraryId, assetId, size)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async create(
    ownerId: string,
    libraryId: string,
    assetId: string,
    size: LibraryThumbnailSize,
  ): Promise<ResolvedLibraryThumbnail> {
    if (!this.thumbnailRoot) {
      throw new LibraryRequestError(
        'THUMBNAIL_STORAGE_DISABLED',
        503,
        'Thumbnail storage is not configured',
      );
    }
    const original = await this.storage.resolveAssetFile(ownerId, libraryId, assetId);

    try {
      const root = path.resolve(this.thumbnailRoot);
      await fs.mkdir(root, { recursive: true, mode: 0o750 });
      const canonicalRoot = await fs.realpath(root);
      const directory = path.join(canonicalRoot, libraryId, assetId);
      if (!isPathInside(canonicalRoot, directory)) throw new Error('Invalid thumbnail path');
      await fs.mkdir(directory, { recursive: true, mode: 0o750 });

      const filePath = path.join(
        directory,
        `${original.asset.thumbVersion}-${size}.webp`,
      );
      if (await fileExists(filePath)) {
        return { filePath, etag: thumbnailEtag(original.asset.thumbVersion, size) };
      }

      const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
      try {
        await sharp(original.filePath, { failOn: 'none' })
          .rotate()
          .resize(PIXELS_BY_SIZE[size], PIXELS_BY_SIZE[size], {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 82 })
          .toFile(temporaryPath);
        await fs.rename(temporaryPath, filePath);
      } finally {
        await fs.unlink(temporaryPath).catch(() => undefined);
      }

      return { filePath, etag: thumbnailEtag(original.asset.thumbVersion, size) };
    } catch (error) {
      if (error instanceof LibraryRequestError) throw error;
      throw new LibraryRequestError(
        'THUMBNAIL_UNAVAILABLE',
        422,
        'Thumbnail could not be generated for this asset',
        { cause: error },
      );
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function thumbnailEtag(version: number, size: LibraryThumbnailSize): string {
  return `"library-thumb-${version}-${size}"`;
}

