import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Database } from 'sql.js';
import type {
  CreatePhotoLibraryImportRequest,
  PhotoLibraryImport,
  PhotoLibraryImportCommit,
} from '@photolib/shared';
import {
  LibraryAssetRepository,
  type StoredLibraryAsset,
} from './library.asset.repository.js';
import { LibraryRequestError } from './library.errors.js';
import { computeLibraryFullChecksum, computeLibraryQuickHash } from './library.hash.js';
import { LibraryImportRepository } from './library.import.repository.js';
import { mediaTypeForPath } from './library.media.js';
import { isPathInside, type LibraryStorageConfig } from './library.paths.js';
import { LibraryRepository, type StoredLibraryRoot } from './library.repository.js';

const DEFAULT_MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;

export class LibraryImportService {
  constructor(
    private readonly db: Database,
    private readonly libraries: LibraryRepository,
    private readonly imports: LibraryImportRepository,
    private readonly assets: LibraryAssetRepository,
    private readonly storageConfig: LibraryStorageConfig,
  ) {}

  create(ownerId: string, libraryId: string, body: unknown): PhotoLibraryImport {
    this.requireManagedRoot(ownerId, libraryId);
    const request = parseCreateImport(body, this.maxImportBytes());
    return this.imports.create(ownerId, libraryId, randomUUID(), request, Date.now());
  }

  get(ownerId: string, libraryId: string, importId: string): PhotoLibraryImport {
    this.requireManagedRoot(ownerId, libraryId);
    const record = this.imports.get(ownerId, libraryId, importId);
    if (!record) throw importNotFound();
    return record;
  }

  async uploadContent(
    ownerId: string,
    libraryId: string,
    importId: string,
    chunks: AsyncIterable<unknown>,
  ): Promise<PhotoLibraryImport> {
    const root = this.requireManagedRoot(ownerId, libraryId);
    const record = this.get(ownerId, libraryId, importId);
    if (record.status === 'uploaded') return record;
    if (record.status !== 'pending') {
      throw new LibraryRequestError('IMPORT_NOT_UPLOADABLE', 409, 'Import cannot receive content');
    }

    await this.assertFreeSpace(root.canonicalPath, record.sizeBytes);

    const incoming = await this.ensurePrivateDirectory(root, '.incoming');
    const uploadingPath = path.join(incoming, `${importId}.uploading`);
    const stagedPath = path.join(incoming, `${importId}.part`);
    let received = 0;
    let handle: fs.FileHandle | null = null;
    this.imports.setState(ownerId, libraryId, importId, 'uploading', {
      receivedBytes: 0,
      errorCode: null,
      errorMessage: null,
    });

    try {
      await fs.rm(uploadingPath, { force: true });
      handle = await fs.open(uploadingPath, 'wx', 0o640);
      for await (const value of chunks) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        received += chunk.byteLength;
        if (received > record.sizeBytes || received > this.maxImportBytes()) {
          throw new LibraryRequestError('IMPORT_TOO_LARGE', 413, 'Uploaded file exceeds declared size');
        }
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      handle = null;
      if (received !== record.sizeBytes) {
        throw new LibraryRequestError('IMPORT_SIZE_MISMATCH', 400, 'Uploaded file size does not match');
      }
      await fs.rename(uploadingPath, stagedPath);
      return this.imports.setState(ownerId, libraryId, importId, 'uploaded', {
        receivedBytes: received,
      });
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fs.rm(uploadingPath, { force: true }).catch(() => undefined);
      await fs.rm(stagedPath, { force: true }).catch(() => undefined);
      const requestError = error instanceof LibraryRequestError
        ? error
        : new LibraryRequestError('IMPORT_UPLOAD_FAILED', 500, 'Import upload failed', { cause: error });
      this.imports.setState(ownerId, libraryId, importId, 'failed', {
        receivedBytes: received,
        errorCode: requestError.code,
        errorMessage: requestError.message,
      });
      throw requestError;
    }
  }

  async commit(
    ownerId: string,
    libraryId: string,
    importId: string,
  ): Promise<PhotoLibraryImportCommit> {
    const root = this.requireManagedRoot(ownerId, libraryId);
    const record = this.get(ownerId, libraryId, importId);
    if (record.status === 'committed' && record.assetId) {
      const existing = this.assets.getAsset(ownerId, libraryId, record.assetId);
      if (!existing) throw new LibraryRequestError('IMPORTED_ASSET_MISSING', 409, 'Imported asset is missing');
      return { import: record, asset: existing, duplicate: true };
    }
    if (record.status !== 'uploaded') {
      throw new LibraryRequestError('IMPORT_NOT_COMMITTABLE', 409, 'Import is not ready to commit');
    }

    const incoming = await this.ensurePrivateDirectory(root, '.incoming');
    const stagedPath = path.join(incoming, `${importId}.part`);
    let finalPath: string | null = null;
    try {
      const stat = await fs.stat(stagedPath);
      if (!stat.isFile() || stat.size !== record.sizeBytes) {
        throw new LibraryRequestError('IMPORT_SIZE_MISMATCH', 409, 'Staged file size does not match');
      }
      const media = mediaTypeForPath(record.fileName);
      if (!media) throw new LibraryRequestError('UNSUPPORTED_MEDIA', 415, 'Unsupported image format');
      await validateImageSignature(stagedPath, media.mimeType);
      const checksum = await computeLibraryFullChecksum(stagedPath);
      if (record.checksumSha256 && checksum !== record.checksumSha256) {
        throw new LibraryRequestError('IMPORT_CHECKSUM_MISMATCH', 409, 'Uploaded file checksum does not match');
      }

      const duplicate = this.assets.findOnlineByFullChecksum(ownerId, libraryId, checksum);
      if (duplicate) {
        await fs.rm(stagedPath, { force: true });
        const committed = this.imports.setState(ownerId, libraryId, importId, 'committed', {
          receivedBytes: record.sizeBytes,
          assetId: duplicate.id,
          errorCode: null,
          errorMessage: null,
        });
        return { import: committed, asset: toPublicAsset(duplicate), duplicate: true };
      }

      const assetId = randomUUID();
      const now = Date.now();
      const date = new Date(record.dateModified ?? now);
      const year = String(date.getUTCFullYear());
      const day = date.toISOString().slice(0, 10);
      const relativeDirectory = path.posix.join('originals', year, day);
      await this.ensurePrivateDirectory(root, relativeDirectory);
      const relativePath = path.posix.join(relativeDirectory, `${assetId}_${record.fileName}`);
      finalPath = path.join(root.canonicalPath, ...relativePath.split('/'));
      if (!isPathInside(root.canonicalPath, finalPath)) throw new Error('Import target escaped root');
      await fs.rename(stagedPath, finalPath);
      if (record.dateModified) {
        const modified = new Date(record.dateModified);
        await fs.utimes(finalPath, modified, modified);
      }
      const finalStat = await fs.stat(finalPath);
      const quickHash = await computeLibraryQuickHash(finalPath, finalStat.size);

      this.db.exec('BEGIN');
      try {
        const asset = this.assets.insertImportedFile({
          id: assetId,
          ownerId,
          libraryId,
          rootId: root.id,
          relativePath,
          fileName: record.fileName,
          extension: media.extension,
          mimeType: media.mimeType,
          size: finalStat.size,
          mtimeMs: Math.trunc(finalStat.mtimeMs),
          inode: Number.isSafeInteger(finalStat.ino) ? finalStat.ino : null,
          quickHash,
          fullChecksum: checksum,
          scanGeneration: 0,
          seenAt: now,
        });
        const committed = this.imports.setState(ownerId, libraryId, importId, 'committed', {
          receivedBytes: record.sizeBytes,
          assetId,
          errorCode: null,
          errorMessage: null,
          now,
        });
        this.db.exec('COMMIT');
        return { import: committed, asset, duplicate: false };
      } catch (error) {
        this.rollback();
        throw error;
      }
    } catch (error) {
      if (finalPath) {
        await fs.rename(finalPath, stagedPath).catch(() => undefined);
      }
      const requestError = error instanceof LibraryRequestError
        ? error
        : new LibraryRequestError('IMPORT_COMMIT_FAILED', 500, 'Import commit failed', { cause: error });
      this.imports.setState(ownerId, libraryId, importId, 'failed', {
        errorCode: requestError.code,
        errorMessage: requestError.message,
      });
      throw requestError;
    }
  }

  async cancel(ownerId: string, libraryId: string, importId: string): Promise<void> {
    const root = this.requireManagedRoot(ownerId, libraryId);
    const record = this.get(ownerId, libraryId, importId);
    if (record.status === 'committed') {
      throw new LibraryRequestError('IMPORT_ALREADY_COMMITTED', 409, 'Committed import cannot be cancelled');
    }
    const incoming = await this.ensurePrivateDirectory(root, '.incoming');
    await Promise.all([
      fs.rm(path.join(incoming, `${importId}.uploading`), { force: true }),
      fs.rm(path.join(incoming, `${importId}.part`), { force: true }),
    ]);
    this.imports.setState(ownerId, libraryId, importId, 'cancelled', {
      errorCode: null,
      errorMessage: null,
    });
  }

  private requireManagedRoot(ownerId: string, libraryId: string): StoredLibraryRoot {
    const library = this.libraries.get(ownerId, libraryId);
    if (!library) throw new LibraryRequestError('LIBRARY_NOT_FOUND', 404, 'Library not found');
    if (library.mode !== 'managed' || library.readOnly) {
      throw new LibraryRequestError('LIBRARY_READ_ONLY', 403, 'Library does not accept imports');
    }
    const root = library.roots.find((candidate) => candidate.writable);
    if (!root) throw new LibraryRequestError('MANAGED_STORAGE_UNAVAILABLE', 503, 'Managed storage is not writable');
    return root;
  }

  private async ensurePrivateDirectory(root: StoredLibraryRoot, relativePath: string): Promise<string> {
    const canonicalRoot = await fs.realpath(root.path);
    if (canonicalRoot !== root.canonicalPath) {
      throw new LibraryRequestError('MANAGED_STORAGE_UNAVAILABLE', 503, 'Managed storage root changed');
    }
    const candidate = path.join(canonicalRoot, ...relativePath.split('/'));
    if (!isPathInside(canonicalRoot, candidate) || candidate === canonicalRoot) {
      throw new LibraryRequestError('INVALID_STORAGE_PATH', 500, 'Invalid managed storage path');
    }
    await fs.mkdir(candidate, { recursive: true, mode: 0o750 });
    const canonicalDirectory = await fs.realpath(candidate);
    if (!isPathInside(canonicalRoot, canonicalDirectory)) {
      throw new LibraryRequestError('INVALID_STORAGE_PATH', 500, 'Managed storage path escaped root');
    }
    return canonicalDirectory;
  }

  private maxImportBytes(): number {
    const configured = this.storageConfig.maxImportBytes;
    return configured === 0 ? Number.MAX_SAFE_INTEGER : configured ?? DEFAULT_MAX_IMPORT_BYTES;
  }

  private async assertFreeSpace(rootPath: string, requiredBytes: number): Promise<void> {
    try {
      const stats = await fs.statfs(rootPath);
      const available = BigInt(Math.trunc(stats.bavail)) * BigInt(Math.trunc(stats.bsize));
      const reserve = 64n * 1024n * 1024n;
      if (available < BigInt(requiredBytes) + reserve) {
        throw new LibraryRequestError(
          'INSUFFICIENT_STORAGE',
          507,
          'Not enough free space for this import',
        );
      }
    } catch (error) {
      if (error instanceof LibraryRequestError) throw error;
      // Some network filesystems do not expose statfs reliably. The streaming
      // size limit and atomic staging path still protect catalog consistency.
    }
  }

  private rollback(): void {
    try { this.db.exec('ROLLBACK'); } catch { /* preserve original error */ }
  }
}

function parseCreateImport(value: unknown, maxBytes: number): CreatePhotoLibraryImportRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LibraryRequestError('INVALID_REQUEST', 400, 'Request body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (
    typeof body.fileName !== 'string'
    || body.fileName.length === 0
    || body.fileName.length > 255
    || body.fileName.trim() !== body.fileName
    || body.fileName.includes('/')
    || body.fileName.includes('\\')
    || hasControlCharacter(body.fileName)
    || !mediaTypeForPath(body.fileName)
  ) {
    throw new LibraryRequestError('INVALID_FILE_NAME', 400, 'Invalid or unsupported image file name');
  }
  if (!Number.isSafeInteger(body.sizeBytes) || (body.sizeBytes as number) <= 0) {
    throw new LibraryRequestError('INVALID_FILE_SIZE', 400, 'Invalid file size');
  }
  if ((body.sizeBytes as number) > maxBytes) {
    throw new LibraryRequestError('IMPORT_TOO_LARGE', 413, 'File exceeds the import size limit');
  }
  if (body.checksumSha256 !== undefined && (
    typeof body.checksumSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(body.checksumSha256)
  )) {
    throw new LibraryRequestError('INVALID_CHECKSUM', 400, 'Invalid SHA-256 checksum');
  }
  if (body.dateModified !== undefined && (
    !Number.isSafeInteger(body.dateModified) || (body.dateModified as number) < 0
  )) {
    throw new LibraryRequestError('INVALID_DATE_MODIFIED', 400, 'Invalid modification date');
  }
  return {
    fileName: body.fileName,
    sizeBytes: body.sizeBytes as number,
    checksumSha256: typeof body.checksumSha256 === 'string'
      ? body.checksumSha256.toLowerCase()
      : undefined,
    dateModified: body.dateModified as number | undefined,
  };
}

async function validateImageSignature(filePath: string, mimeType: string): Promise<void> {
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff', 'image/avif', 'image/heic', 'image/heif'].includes(mimeType)) {
    return; // RAW formats have vendor-specific or TIFF-derived signatures.
  }
  const handle = await fs.open(filePath, 'r');
  try {
    const bytes = Buffer.alloc(32);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const head = bytes.subarray(0, bytesRead);
    const ascii = head.toString('ascii');
    const valid = mimeType === 'image/jpeg' ? head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
      : mimeType === 'image/png' ? head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === 'image/gif' ? ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')
      : mimeType === 'image/webp' ? ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP'
      : mimeType === 'image/bmp' ? ascii.startsWith('BM')
      : mimeType === 'image/tiff' ? ascii.startsWith('II*\0') || ascii.startsWith('MM\0*')
      : ascii.slice(4, 8) === 'ftyp';
    if (!valid) throw new LibraryRequestError('INVALID_MEDIA_CONTENT', 415, 'File content does not match its image format');
  } finally {
    await handle.close();
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) if (character.charCodeAt(0) < 32) return true;
  return false;
}

function importNotFound(): LibraryRequestError {
  return new LibraryRequestError('IMPORT_NOT_FOUND', 404, 'Library import not found');
}

function toPublicAsset(asset: StoredLibraryAsset): PhotoLibraryImportCommit['asset'] {
  return {
    id: asset.id,
    libraryId: asset.libraryId,
    rootId: asset.rootId,
    relativePath: asset.relativePath,
    name: asset.name,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    dateModified: asset.dateModified,
    dateTaken: asset.dateTaken,
    quickHash: asset.quickHash,
    width: asset.width,
    height: asset.height,
    status: asset.status,
    revision: asset.revision,
  };
}
