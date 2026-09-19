import fs from 'node:fs/promises';
import path from 'node:path';
import { LibraryAssetRepository, type StoredLibraryAsset } from './library.asset.repository.js';
import { LibraryRequestError } from './library.errors.js';
import { isPathInside } from './library.paths.js';
import { LibraryRepository } from './library.repository.js';
import type { PhotoLibraryAsset } from '@photolib/shared';

export interface ResolvedLibraryAssetFile {
  asset: StoredLibraryAsset;
  filePath: string;
  size: number;
  mtimeMs: number;
}

export class LibraryStorage {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly assets: LibraryAssetRepository,
  ) {}

  async resolveAssetFile(
    ownerId: string,
    libraryId: string,
    assetId: string,
  ): Promise<ResolvedLibraryAssetFile> {
    const library = this.libraries.get(ownerId, libraryId);
    const asset = this.assets.getStoredAsset(ownerId, libraryId, assetId);
    if (!library || !asset) {
      throw new LibraryRequestError('ASSET_NOT_FOUND', 404, 'Library asset not found');
    }
    if (asset.status !== 'online') {
      throw new LibraryRequestError('ASSET_NOT_ONLINE', 409, 'Library asset is not available');
    }

    const root = library.roots.find((candidate) => candidate.id === asset.rootId);
    if (!root) {
      throw new LibraryRequestError('ASSET_NOT_AVAILABLE', 409, 'Library asset is not available');
    }

    try {
      const canonicalRoot = await fs.realpath(root.path);
      if (canonicalRoot !== root.canonicalPath) throw new Error('Library root changed');

      const nativeRelativePath = asset.relativePath.split('/').join(path.sep);
      const candidate = path.resolve(canonicalRoot, nativeRelativePath);
      if (!isPathInside(canonicalRoot, candidate) || candidate === canonicalRoot) {
        throw new Error('Asset path escaped root');
      }
      const filePath = await fs.realpath(candidate);
      if (!isPathInside(canonicalRoot, filePath)) throw new Error('Asset path escaped root');
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error('Asset is not a file');

      return {
        asset,
        filePath,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
      };
    } catch (error) {
      throw new LibraryRequestError(
        'ASSET_NOT_AVAILABLE',
        409,
        'Library asset is not available',
        { cause: error },
      );
    }
  }

  async trashAsset(
    ownerId: string,
    libraryId: string,
    assetId: string,
  ): Promise<PhotoLibraryAsset> {
    const { library, root, asset } = this.requireManagedAsset(ownerId, libraryId, assetId);
    if (asset.status === 'trashed') return this.assets.getAsset(ownerId, libraryId, assetId)!;
    if (asset.status !== 'online') {
      throw new LibraryRequestError('ASSET_NOT_ONLINE', 409, 'Only online assets can be moved to trash');
    }
    const source = await this.resolveAssetFile(ownerId, library.id, asset.id);
    const trashRelative = path.posix.join('.trash', asset.id, asset.relativePath);
    const target = await this.safeNewFilePath(root.canonicalPath, trashRelative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    await this.assertDirectoryInsideRoot(root.canonicalPath, path.dirname(target));
    await fs.rename(source.filePath, target);
    try {
      return this.assets.markTrashed(ownerId, libraryId, assetId, Date.now());
    } catch (error) {
      await fs.rename(target, source.filePath).catch(() => undefined);
      throw error;
    }
  }

  async restoreAsset(
    ownerId: string,
    libraryId: string,
    assetId: string,
  ): Promise<PhotoLibraryAsset> {
    const { root, asset } = this.requireManagedAsset(ownerId, libraryId, assetId);
    if (asset.status === 'online') return this.assets.getAsset(ownerId, libraryId, assetId)!;
    if (asset.status !== 'trashed') {
      throw new LibraryRequestError('ASSET_NOT_TRASHED', 409, 'Only trashed assets can be restored');
    }
    const trashRelative = path.posix.join('.trash', asset.id, asset.relativePath);
    const source = await this.resolveExistingFile(root.canonicalPath, trashRelative);
    const restoredRelative = await this.findRestoreRelativePath(root.canonicalPath, asset.relativePath);
    const target = await this.safeNewFilePath(root.canonicalPath, restoredRelative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    await this.assertDirectoryInsideRoot(root.canonicalPath, path.dirname(target));
    await fs.rename(source, target);
    try {
      const stat = await fs.stat(target);
      return this.assets.markRestored(
        ownerId,
        libraryId,
        assetId,
        restoredRelative,
        path.posix.basename(restoredRelative),
        Math.trunc(stat.mtimeMs),
        Date.now(),
      );
    } catch (error) {
      await fs.rename(target, source).catch(() => undefined);
      throw error;
    }
  }

  async purgeTrashedAsset(
    ownerId: string,
    libraryId: string,
    assetId: string,
  ): Promise<void> {
    const { root, asset } = this.requireManagedAsset(ownerId, libraryId, assetId);
    if (asset.status !== 'trashed') {
      throw new LibraryRequestError('ASSET_NOT_TRASHED', 409, 'Only trashed assets can be permanently removed');
    }
    const trashRelative = path.posix.join('.trash', asset.id, asset.relativePath);
    const source = await this.resolveExistingFile(root.canonicalPath, trashRelative);
    const quarantine = `${source}.purging`;
    await fs.rename(source, quarantine);
    try {
      if (!this.assets.deleteTrashedAsset(ownerId, libraryId, assetId)) {
        throw new LibraryRequestError('ASSET_NOT_FOUND', 404, 'Library asset not found');
      }
      await fs.rm(quarantine, { force: true });
    } catch (error) {
      await fs.rename(quarantine, source).catch(() => undefined);
      throw error;
    }
  }

  private requireManagedAsset(ownerId: string, libraryId: string, assetId: string) {
    const library = this.libraries.get(ownerId, libraryId);
    const asset = this.assets.getStoredAsset(ownerId, libraryId, assetId);
    if (!library || !asset) {
      throw new LibraryRequestError('ASSET_NOT_FOUND', 404, 'Library asset not found');
    }
    if (library.mode !== 'managed' || library.readOnly) {
      throw new LibraryRequestError('LIBRARY_READ_ONLY', 403, 'External libraries are read-only');
    }
    const root = library.roots.find((candidate) => candidate.id === asset.rootId && candidate.writable);
    if (!root) {
      throw new LibraryRequestError('MANAGED_STORAGE_UNAVAILABLE', 503, 'Managed storage is not writable');
    }
    return { library, root, asset };
  }

  private async safeNewFilePath(canonicalRoot: string, relativePath: string): Promise<string> {
    const currentRoot = await fs.realpath(canonicalRoot);
    if (currentRoot !== canonicalRoot) {
      throw new LibraryRequestError('MANAGED_STORAGE_UNAVAILABLE', 503, 'Managed storage root changed');
    }
    const target = path.join(canonicalRoot, ...relativePath.split('/'));
    if (!isPathInside(canonicalRoot, target) || target === canonicalRoot) {
      throw new LibraryRequestError('INVALID_STORAGE_PATH', 500, 'Invalid managed storage path');
    }
    return target;
  }

  private async resolveExistingFile(canonicalRoot: string, relativePath: string): Promise<string> {
    const candidate = await this.safeNewFilePath(canonicalRoot, relativePath);
    try {
      const resolved = await fs.realpath(candidate);
      if (!isPathInside(canonicalRoot, resolved)) throw new Error('File escaped root');
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) throw new Error('Not a file');
      return resolved;
    } catch (error) {
      throw new LibraryRequestError('ASSET_NOT_AVAILABLE', 409, 'Library asset is not available', {
        cause: error,
      });
    }
  }

  private async assertDirectoryInsideRoot(canonicalRoot: string, directory: string): Promise<void> {
    const resolved = await fs.realpath(directory);
    if (!isPathInside(canonicalRoot, resolved)) {
      throw new LibraryRequestError('INVALID_STORAGE_PATH', 500, 'Managed storage path escaped root');
    }
  }

  private async findRestoreRelativePath(
    canonicalRoot: string,
    preferredRelativePath: string,
  ): Promise<string> {
    if (!await exists(path.join(canonicalRoot, ...preferredRelativePath.split('/')))) {
      return preferredRelativePath;
    }
    const extension = path.posix.extname(preferredRelativePath);
    const stem = preferredRelativePath.slice(0, -extension.length || undefined);
    for (let suffix = 1; suffix <= 10_000; suffix++) {
      const candidate = `${stem}-restored-${suffix}${extension}`;
      if (!await exists(path.join(canonicalRoot, ...candidate.split('/')))) return candidate;
    }
    throw new LibraryRequestError('RESTORE_NAME_CONFLICT', 409, 'Could not find a free restore file name');
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
