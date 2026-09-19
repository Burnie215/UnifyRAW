import { randomUUID } from 'node:crypto';
import type { PhotoLibraryScan } from '@photolib/shared';
import { saveToFile } from '../services/db.js';
import { LibraryAssetRepository } from './library.asset.repository.js';
import { LibraryRequestError } from './library.errors.js';
import { LibraryRepository } from './library.repository.js';
import { LibraryScanner } from './library.scanner.js';

interface QueuedScan {
  ownerId: string;
  libraryId: string;
  scanId: string;
}

export class LibraryScanQueue {
  private readonly pending: QueuedScan[] = [];
  private readonly activeByLibrary = new Map<string, string>();
  private readonly cancelled = new Set<string>();
  private activeCount = 0;

  constructor(
    private readonly libraries: LibraryRepository,
    private readonly assets: LibraryAssetRepository,
    private readonly scanner: LibraryScanner,
    private readonly maxConcurrent = parseConcurrency(),
  ) {
    this.assets.interruptAbandonedScans();
  }

  enqueue(ownerId: string, libraryId: string): PhotoLibraryScan {
    if (!this.libraries.get(ownerId, libraryId)) {
      throw new LibraryRequestError('LIBRARY_NOT_FOUND', 404, 'Library not found');
    }
    const key = libraryKey(ownerId, libraryId);
    const activeScan = this.activeByLibrary.get(key) ?? this.assets.findActiveScan(ownerId, libraryId)?.id;
    if (activeScan) {
      throw new LibraryRequestError(
        'SCAN_ALREADY_RUNNING',
        409,
        'A scan is already running for this library',
      );
    }

    const scanId = randomUUID();
    const scan = this.assets.createScan(ownerId, libraryId, scanId, Date.now());
    this.activeByLibrary.set(key, scanId);
    this.pending.push({ ownerId, libraryId, scanId });
    queueMicrotask(() => this.pump());
    saveToFile();
    return scan;
  }

  get(ownerId: string, libraryId: string, scanId: string): PhotoLibraryScan {
    const scan = this.assets.getScan(ownerId, libraryId, scanId);
    if (!scan) throw new LibraryRequestError('SCAN_NOT_FOUND', 404, 'Library scan not found');
    return scan;
  }

  cancel(ownerId: string, libraryId: string, scanId: string): PhotoLibraryScan {
    if (!this.assets.requestScanCancellation(ownerId, libraryId, scanId)) {
      const existing = this.assets.getScan(ownerId, libraryId, scanId);
      if (!existing) {
        throw new LibraryRequestError('SCAN_NOT_FOUND', 404, 'Library scan not found');
      }
      throw new LibraryRequestError('SCAN_NOT_ACTIVE', 409, 'Library scan is not active');
    }
    this.cancelled.add(scanId);
    const scan = this.get(ownerId, libraryId, scanId);
    saveToFile();
    return scan;
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrent && this.pending.length > 0) {
      const scan = this.pending.shift()!;
      this.activeCount++;
      void this.run(scan);
    }
  }

  private async run(scan: QueuedScan): Promise<void> {
    try {
      await this.scanner.run(
        scan.ownerId,
        scan.libraryId,
        scan.scanId,
        () => this.cancelled.has(scan.scanId),
      );
    } finally {
      this.cancelled.delete(scan.scanId);
      this.activeByLibrary.delete(libraryKey(scan.ownerId, scan.libraryId));
      this.activeCount--;
      saveToFile();
      this.pump();
    }
  }
}

function libraryKey(ownerId: string, libraryId: string): string {
  return `${ownerId}\0${libraryId}`;
}

function parseConcurrency(): number {
  const configured = Number(process.env.PHOTOLIB_SCAN_CONCURRENCY ?? 2);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 8
    ? configured
    : 2;
}
