import type { Database } from 'sql.js';
import type {
  CreatePhotoLibraryImportRequest,
  LibraryImportStatus,
  PhotoLibraryImport,
} from '@photolib/shared';

export function recoverInterruptedLibraryImports(db: Database, now = Date.now()): void {
  db.run(
    `UPDATE server_library_imports SET
      status = 'failed', errorCode = 'IMPORT_INTERRUPTED',
      errorMessage = 'Backend restarted during upload', updatedAt = ?
     WHERE status = 'uploading'`,
    [now],
  );
}

export class LibraryImportRepository {
  constructor(private readonly db: Database) {}

  create(
    ownerId: string,
    libraryId: string,
    importId: string,
    request: CreatePhotoLibraryImportRequest,
    now: number,
  ): PhotoLibraryImport {
    this.db.run(
      `INSERT INTO server_library_imports (
        id, ownerId, libraryId, fileName, expectedSize, receivedSize,
        expectedChecksum, dateModified, status, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'pending', ?, ?)`,
      [
        importId,
        ownerId,
        libraryId,
        request.fileName,
        request.sizeBytes,
        request.checksumSha256 ?? null,
        request.dateModified ?? null,
        now,
        now,
      ],
    );
    return this.get(ownerId, libraryId, importId)!;
  }

  get(ownerId: string, libraryId: string, importId: string): PhotoLibraryImport | null {
    const stmt = this.db.prepare(
      `SELECT * FROM server_library_imports
       WHERE ownerId = ? AND libraryId = ? AND id = ?`,
    );
    stmt.bind([ownerId, libraryId, importId]);
    const record = stmt.step() ? mapImport(stmt.getAsObject()) : null;
    stmt.free();
    return record;
  }

  setState(
    ownerId: string,
    libraryId: string,
    importId: string,
    status: LibraryImportStatus,
    options: {
      receivedBytes?: number;
      assetId?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      now?: number;
    } = {},
  ): PhotoLibraryImport {
    const current = this.get(ownerId, libraryId, importId);
    if (!current) throw new Error('Import record not found');
    this.db.run(
      `UPDATE server_library_imports SET
        status = ?, receivedSize = ?, resultAssetId = ?, errorCode = ?,
        errorMessage = ?, updatedAt = ?
       WHERE ownerId = ? AND libraryId = ? AND id = ?`,
      [
        status,
        options.receivedBytes ?? current.receivedBytes,
        options.assetId === undefined ? current.assetId : options.assetId,
        options.errorCode === undefined ? current.errorCode : options.errorCode,
        options.errorMessage === undefined ? current.errorMessage : options.errorMessage,
        options.now ?? Date.now(),
        ownerId,
        libraryId,
        importId,
      ],
    );
    return this.get(ownerId, libraryId, importId)!;
  }
}

function mapImport(row: Record<string, unknown>): PhotoLibraryImport {
  return {
    id: String(row.id),
    libraryId: String(row.libraryId),
    fileName: String(row.fileName),
    sizeBytes: Number(row.expectedSize),
    receivedBytes: Number(row.receivedSize),
    checksumSha256: nullableString(row.expectedChecksum),
    dateModified: nullableNumber(row.dateModified),
    status: row.status as LibraryImportStatus,
    assetId: nullableString(row.resultAssetId),
    errorCode: nullableString(row.errorCode),
    errorMessage: nullableString(row.errorMessage),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
