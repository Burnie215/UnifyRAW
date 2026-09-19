import type { PhotoLibraryIntegrityReport } from '@photolib/shared';
import { LibraryAssetRepository } from './library.asset.repository.js';
import { LibraryRequestError } from './library.errors.js';
import { computeLibraryFullChecksum } from './library.hash.js';
import { LibraryRepository } from './library.repository.js';
import { LibraryStorage } from './library.storage.js';

export class LibraryIntegrityService {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly assets: LibraryAssetRepository,
    private readonly storage: LibraryStorage,
  ) {}

  async check(ownerId: string, libraryId: string): Promise<PhotoLibraryIntegrityReport> {
    const library = this.libraries.get(ownerId, libraryId);
    if (!library) throw new LibraryRequestError('LIBRARY_NOT_FOUND', 404, 'Library not found');
    if (library.mode !== 'managed') {
      throw new LibraryRequestError(
        'INTEGRITY_CHECK_MANAGED_ONLY',
        409,
        'Full integrity checks are available for managed libraries',
      );
    }

    const startedAt = Date.now();
    const report: PhotoLibraryIntegrityReport = {
      libraryId,
      checked: 0,
      valid: 0,
      initialized: 0,
      missing: 0,
      changed: 0,
      unreadable: 0,
      issues: [],
      startedAt,
      finishedAt: startedAt,
    };

    for (const asset of this.assets.listOnlineStoredAssets(ownerId, libraryId)) {
      report.checked++;
      try {
        const file = await this.storage.resolveAssetFile(ownerId, libraryId, asset.id);
        const checksum = await computeLibraryFullChecksum(file.filePath);
        if (!asset.fullChecksum) {
          this.assets.initializeFullChecksum(asset.id, checksum, Date.now());
          report.initialized++;
        } else if (checksum === asset.fullChecksum) {
          report.valid++;
        } else {
          report.changed++;
          report.issues.push({ assetId: asset.id, code: 'CHECKSUM_MISMATCH' });
          this.assets.markIntegrityError(asset, 'CHECKSUM_MISMATCH', Date.now());
        }
      } catch (error) {
        const missing = error instanceof LibraryRequestError
          && (error.code === 'ASSET_NOT_AVAILABLE' || error.code === 'ASSET_NOT_ONLINE');
        if (missing) report.missing++;
        else report.unreadable++;
        report.issues.push({ assetId: asset.id, code: missing ? 'MISSING' : 'UNREADABLE' });
        this.assets.markIntegrityError(asset, missing ? 'FILE_MISSING' : 'FILE_UNREADABLE', Date.now());
      }
    }
    report.finishedAt = Date.now();
    return report;
  }
}
