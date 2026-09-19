import type { Database } from 'sql.js';
import type {
  LibraryAssetStatus,
  LibraryScanStatus,
  PhotoLibraryAsset,
  PhotoLibraryAssetMetadata,
  PhotoLibraryAssetChanges,
  PhotoLibraryAssetPage,
  PhotoLibraryScan,
  PhotoLibraryStats,
} from '@photolib/shared';

export interface StoredLibraryAsset extends PhotoLibraryAsset {
  ownerId: string;
  extension: string;
  fullChecksum: string | null;
  inode: number | null;
  scanGeneration: number;
  firstSeenGeneration: number;
  lastSeenAt: number;
  thumbVersion: number;
  createdAt: number;
  updatedAt: number;
  errorCode: string | null;
  errorMessage: string | null;
  metadata: PhotoLibraryAssetMetadata | null;
}

export interface IndexedLibraryFile {
  ownerId: string;
  libraryId: string;
  rootId: string;
  relativePath: string;
  fileName: string;
  extension: string;
  mimeType: string;
  size: number;
  mtimeMs: number;
  inode: number | null;
  quickHash: string;
  width?: number | null;
  height?: number | null;
  orientation?: number | null;
  dateTaken?: number | null;
  metadata?: PhotoLibraryAssetMetadata | null;
  scanGeneration: number;
  seenAt: number;
}

export interface ImportedLibraryFile extends IndexedLibraryFile {
  id: string;
  fullChecksum: string;
}

export type ReconcileFileResult = 'added' | 'updated' | 'restored';

export interface ScanCounters {
  discovered: number;
  added: number;
  updated: number;
  offline: number;
  restored: number;
  errors: number;
}

export function recoverInterruptedLibraryScans(db: Database, now = Date.now()): void {
  db.run(
    `UPDATE server_library_scans SET
      status = 'interrupted', finishedAt = ?, errorSummary = 'Backend restarted during scan'
     WHERE status IN ('queued', 'running')`,
    [now],
  );
  db.run(
    `UPDATE server_libraries SET status = 'idle', updatedAt = ?
     WHERE status = 'scanning'`,
    [now],
  );
}

export class LibraryAssetRepository {
  constructor(private readonly db: Database) {}

  createScan(ownerId: string, libraryId: string, scanId: string, createdAt: number): PhotoLibraryScan {
    const generation = this.nextGeneration(ownerId, libraryId);
    this.db.run(
      `INSERT INTO server_library_scans (
        id, libraryId, ownerId, kind, status, generation, createdAt
      ) VALUES (?, ?, ?, 'full', 'queued', ?, ?)`,
      [scanId, libraryId, ownerId, generation, createdAt],
    );
    return this.getScan(ownerId, libraryId, scanId)!;
  }

  findActiveScan(ownerId: string, libraryId: string): PhotoLibraryScan | null {
    const stmt = this.db.prepare(
      `SELECT * FROM server_library_scans
       WHERE ownerId = ? AND libraryId = ? AND status IN ('queued', 'running')
       ORDER BY createdAt DESC LIMIT 1`,
    );
    stmt.bind([ownerId, libraryId]);
    const scan = stmt.step() ? mapScan(stmt.getAsObject()) : null;
    stmt.free();
    return scan;
  }

  getScan(ownerId: string, libraryId: string, scanId: string): PhotoLibraryScan | null {
    const stmt = this.db.prepare(
      `SELECT * FROM server_library_scans
       WHERE ownerId = ? AND libraryId = ? AND id = ?`,
    );
    stmt.bind([ownerId, libraryId, scanId]);
    const scan = stmt.step() ? mapScan(stmt.getAsObject()) : null;
    stmt.free();
    return scan;
  }

  interruptAbandonedScans(now = Date.now()): void {
    recoverInterruptedLibraryScans(this.db, now);
  }

  markScanRunning(ownerId: string, libraryId: string, scanId: string, now: number): void {
    this.db.run(
      `UPDATE server_library_scans SET status = 'running', startedAt = ?
       WHERE ownerId = ? AND libraryId = ? AND id = ?`,
      [now, ownerId, libraryId, scanId],
    );
    this.db.run(
      `UPDATE server_libraries SET status = 'scanning', lastError = NULL, updatedAt = ?
       WHERE ownerId = ? AND id = ?`,
      [now, ownerId, libraryId],
    );
  }

  updateScanProgress(
    ownerId: string,
    libraryId: string,
    scanId: string,
    counters: ScanCounters,
    currentPath: string | null,
  ): void {
    this.db.run(
      `UPDATE server_library_scans SET
        discovered = ?, added = ?, updated = ?, offline = ?, restored = ?,
        errors = ?, currentPath = ?
       WHERE ownerId = ? AND libraryId = ? AND id = ?`,
      [
        counters.discovered,
        counters.added,
        counters.updated,
        counters.offline,
        counters.restored,
        counters.errors,
        currentPath,
        ownerId,
        libraryId,
        scanId,
      ],
    );
  }

  finishScan(
    ownerId: string,
    libraryId: string,
    scanId: string,
    status: LibraryScanStatus,
    counters: ScanCounters,
    errorSummary: string | null,
    now: number,
  ): void {
    this.updateScanProgress(ownerId, libraryId, scanId, counters, null);
    this.db.run(
      `UPDATE server_library_scans SET
        status = ?, finishedAt = ?, errorSummary = ?, currentPath = NULL
       WHERE ownerId = ? AND libraryId = ? AND id = ?`,
      [status, now, errorSummary, ownerId, libraryId, scanId],
    );
    this.db.run(
      `UPDATE server_libraries SET
        status = ?, lastScanAt = ?, lastError = ?, updatedAt = ?
       WHERE ownerId = ? AND id = ?`,
      [
        status === 'failed' || errorSummary ? 'error' : 'idle',
        now,
        errorSummary,
        now,
        ownerId,
        libraryId,
      ],
    );
  }

  requestScanCancellation(ownerId: string, libraryId: string, scanId: string): boolean {
    const scan = this.getScan(ownerId, libraryId, scanId);
    if (!scan || (scan.status !== 'queued' && scan.status !== 'running')) return false;
    this.db.run(
      `UPDATE server_library_scans SET cancelRequested = 1
       WHERE ownerId = ? AND libraryId = ? AND id = ?`,
      [ownerId, libraryId, scanId],
    );
    return true;
  }

  findByPath(
    ownerId: string,
    libraryId: string,
    rootId: string,
    relativePath: string,
  ): StoredLibraryAsset | null {
    const stmt = this.db.prepare(
      `SELECT * FROM server_library_assets
       WHERE ownerId = ? AND libraryId = ? AND rootId = ? AND relativePath = ?`,
    );
    stmt.bind([ownerId, libraryId, rootId, relativePath]);
    const asset = stmt.step() ? mapStoredAsset(stmt.getAsObject()) : null;
    stmt.free();
    return asset;
  }

  getStoredAsset(
    ownerId: string,
    libraryId: string,
    assetId: string,
  ): StoredLibraryAsset | null {
    const stmt = this.db.prepare(
      `SELECT * FROM server_library_assets
       WHERE ownerId = ? AND libraryId = ? AND id = ?`,
    );
    stmt.bind([ownerId, libraryId, assetId]);
    const asset = stmt.step() ? mapStoredAsset(stmt.getAsObject()) : null;
    stmt.free();
    return asset;
  }

  getAsset(
    ownerId: string,
    libraryId: string,
    assetId: string,
  ): PhotoLibraryAsset | null {
    const asset = this.getStoredAsset(ownerId, libraryId, assetId);
    return asset ? toPublicAsset(asset) : null;
  }

  findOnlineByFullChecksum(
    ownerId: string,
    libraryId: string,
    checksum: string,
  ): StoredLibraryAsset | null {
    const stmt = this.db.prepare(
      `SELECT * FROM server_library_assets
       WHERE ownerId = ? AND libraryId = ? AND fullChecksum = ? AND status = 'online'
       ORDER BY createdAt LIMIT 1`,
    );
    stmt.bind([ownerId, libraryId, checksum]);
    const asset = stmt.step() ? mapStoredAsset(stmt.getAsObject()) : null;
    stmt.free();
    return asset;
  }

  listOnlineStoredAssets(ownerId: string, libraryId: string): StoredLibraryAsset[] {
    return this.queryAssets(
      `SELECT * FROM server_library_assets
       WHERE ownerId = ? AND libraryId = ? AND status = 'online'
       ORDER BY id`,
      [ownerId, libraryId],
    );
  }

  initializeFullChecksum(assetId: string, checksum: string, now: number): void {
    this.db.run(
      `UPDATE server_library_assets SET fullChecksum = ?, updatedAt = ?
       WHERE id = ? AND fullChecksum IS NULL`,
      [checksum, now, assetId],
    );
  }

  markIntegrityError(
    existing: StoredLibraryAsset,
    errorCode: string,
    now: number,
  ): void {
    const revision = this.nextRevision(existing.ownerId, existing.libraryId);
    this.db.run(
      `UPDATE server_library_assets SET
        status = 'error', revision = ?, errorCode = ?, errorMessage = NULL,
        updatedAt = ? WHERE id = ?`,
      [revision, errorCode, now, existing.id],
    );
  }

  insertImportedFile(file: ImportedLibraryFile): PhotoLibraryAsset {
    const revision = this.nextRevision(file.ownerId, file.libraryId);
    this.db.run(
      `INSERT INTO server_library_assets (
        id, ownerId, libraryId, rootId, relativePath, fileName, extension,
        mimeType, size, mtimeMs, inode, quickHash, fullChecksum, status,
        scanGeneration, firstSeenGeneration, lastSeenAt, revision,
        thumbVersion, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, 1, ?, ?)`,
      [
        file.id,
        file.ownerId,
        file.libraryId,
        file.rootId,
        file.relativePath,
        file.fileName,
        file.extension,
        file.mimeType,
        file.size,
        file.mtimeMs,
        file.inode,
        file.quickHash,
        file.fullChecksum,
        file.scanGeneration,
        file.scanGeneration,
        file.seenAt,
        revision,
        file.seenAt,
        file.seenAt,
      ],
    );
    return this.getAsset(file.ownerId, file.libraryId, file.id)!;
  }

  markTrashed(
    ownerId: string,
    libraryId: string,
    assetId: string,
    now: number,
  ): PhotoLibraryAsset {
    const existing = this.getStoredAsset(ownerId, libraryId, assetId);
    if (!existing) throw new Error('Asset not found');
    const revision = this.nextRevision(ownerId, libraryId);
    this.db.run(
      `UPDATE server_library_assets SET
        status = 'trashed', trashedAt = ?, revision = ?, updatedAt = ?,
        errorCode = NULL, errorMessage = NULL
       WHERE ownerId = ? AND libraryId = ? AND id = ?`,
      [now, revision, now, ownerId, libraryId, assetId],
    );
    return this.getAsset(ownerId, libraryId, assetId)!;
  }

  markRestored(
    ownerId: string,
    libraryId: string,
    assetId: string,
    relativePath: string,
    fileName: string,
    mtimeMs: number,
    now: number,
  ): PhotoLibraryAsset {
    const existing = this.getStoredAsset(ownerId, libraryId, assetId);
    if (!existing) throw new Error('Asset not found');
    const revision = this.nextRevision(ownerId, libraryId);
    this.db.run(
      `UPDATE server_library_assets SET
        relativePath = ?, fileName = ?, mtimeMs = ?, status = 'online',
        trashedAt = NULL, revision = ?, updatedAt = ?, lastSeenAt = ?,
        thumbVersion = thumbVersion + 1, errorCode = NULL, errorMessage = NULL
       WHERE ownerId = ? AND libraryId = ? AND id = ?`,
      [relativePath, fileName, mtimeMs, revision, now, now, ownerId, libraryId, assetId],
    );
    return this.getAsset(ownerId, libraryId, assetId)!;
  }

  deleteTrashedAsset(ownerId: string, libraryId: string, assetId: string): boolean {
    const existing = this.getStoredAsset(ownerId, libraryId, assetId);
    if (!existing || existing.status !== 'trashed') return false;
    const revision = this.currentRevision(ownerId, libraryId) + 1;
    this.db.exec('BEGIN');
    try {
      this.setRevision(ownerId, libraryId, revision);
      this.db.run(
        `DELETE FROM server_library_assets
         WHERE ownerId = ? AND libraryId = ? AND id = ? AND status = 'trashed'`,
        [ownerId, libraryId, assetId],
      );
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  touchUnchanged(assetId: string, scanGeneration: number, seenAt: number): void {
    this.db.run(
      `UPDATE server_library_assets SET scanGeneration = ?, lastSeenAt = ?
       WHERE id = ?`,
      [scanGeneration, seenAt, assetId],
    );
  }

  reconcileFile(
    file: IndexedLibraryFile,
    existing: StoredLibraryAsset | null,
    assetId: string,
  ): ReconcileFileResult {
    const revision = this.nextRevision(file.ownerId, file.libraryId);
    if (!existing) {
      this.db.run(
        `INSERT INTO server_library_assets (
          id, ownerId, libraryId, rootId, relativePath, fileName, extension,
          mimeType, size, mtimeMs, inode, quickHash, width, height, orientation,
          dateTaken, metadataJson, status,
          scanGeneration, firstSeenGeneration, lastSeenAt, revision,
          thumbVersion, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'online', ?, ?, ?, ?, 1, ?, ?)`,
        [
          assetId,
          file.ownerId,
          file.libraryId,
          file.rootId,
          file.relativePath,
          file.fileName,
          file.extension,
          file.mimeType,
          file.size,
          file.mtimeMs,
          file.inode,
          file.quickHash,
          file.width ?? null,
          file.height ?? null,
          file.orientation ?? null,
          file.dateTaken ?? null,
          JSON.stringify(file.metadata ?? {}),
          file.scanGeneration,
          file.scanGeneration,
          file.seenAt,
          revision,
          file.seenAt,
          file.seenAt,
        ],
      );
      return 'added';
    }

    const restored = existing.status === 'offline' || existing.status === 'error';
    this.db.run(
      `UPDATE server_library_assets SET
        fileName = ?, extension = ?, mimeType = ?, size = ?, mtimeMs = ?,
        inode = ?, quickHash = ?, width = ?, height = ?, orientation = ?,
        dateTaken = ?, metadataJson = ?,
        status = 'online', scanGeneration = ?,
        lastSeenAt = ?, revision = ?, thumbVersion = thumbVersion + 1,
        errorCode = NULL, errorMessage = NULL, updatedAt = ?
       WHERE id = ?`,
      [
        file.fileName,
        file.extension,
        file.mimeType,
        file.size,
        file.mtimeMs,
        file.inode,
        file.quickHash,
        file.width ?? null,
        file.height ?? null,
        file.orientation ?? null,
        file.dateTaken ?? null,
        JSON.stringify(file.metadata ?? {}),
        file.scanGeneration,
        file.seenAt,
        revision,
        file.seenAt,
        existing.id,
      ],
    );
    return restored ? 'restored' : 'updated';
  }

  markAssetError(
    existing: StoredLibraryAsset,
    scanGeneration: number,
    errorCode: string,
    now: number,
  ): void {
    const revision = this.nextRevision(existing.ownerId, existing.libraryId);
    this.db.run(
      `UPDATE server_library_assets SET
        status = 'error', scanGeneration = ?, lastSeenAt = ?, revision = ?,
        errorCode = ?, errorMessage = NULL, updatedAt = ?
       WHERE id = ?`,
      [scanGeneration, now, revision, errorCode, now, existing.id],
    );
  }

  markMissingOffline(
    ownerId: string,
    libraryId: string,
    rootId: string,
    scanGeneration: number,
    now: number,
  ): number {
    const stmt = this.db.prepare(
      `SELECT id FROM server_library_assets
       WHERE ownerId = ? AND libraryId = ? AND rootId = ?
         AND scanGeneration <> ? AND status IN ('online', 'error')`,
    );
    stmt.bind([ownerId, libraryId, rootId, scanGeneration]);
    const ids: string[] = [];
    while (stmt.step()) ids.push(String(stmt.getAsObject().id));
    stmt.free();
    if (ids.length === 0) return 0;

    this.db.exec('BEGIN');
    try {
      let revision = this.currentRevision(ownerId, libraryId);
      for (const id of ids) {
        revision++;
        this.db.run(
          `UPDATE server_library_assets SET
            status = 'offline', revision = ?, updatedAt = ?,
            errorCode = NULL, errorMessage = NULL
           WHERE id = ?`,
          [revision, now, id],
        );
      }
      this.setRevision(ownerId, libraryId, revision);
      this.db.exec('COMMIT');
      return ids.length;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  reconcileMoves(
    ownerId: string,
    libraryId: string,
    scanGeneration: number,
    now: number,
  ): number {
    const newAssets = this.queryAssets(
      `SELECT * FROM server_library_assets
       WHERE ownerId = ? AND libraryId = ? AND firstSeenGeneration = ?
         AND status = 'online' AND quickHash IS NOT NULL`,
      [ownerId, libraryId, scanGeneration],
    );
    const oldAssets = this.queryAssets(
      `SELECT * FROM server_library_assets
       WHERE ownerId = ? AND libraryId = ? AND scanGeneration <> ?
         AND status = 'offline' AND quickHash IS NOT NULL`,
      [ownerId, libraryId, scanGeneration],
    );
    const newByFingerprint = groupByFingerprint(newAssets);
    const oldByFingerprint = groupByFingerprint(oldAssets);
    const pairs: Array<{ added: StoredLibraryAsset; missing: StoredLibraryAsset }> = [];
    for (const [fingerprint, additions] of newByFingerprint) {
      const missing = oldByFingerprint.get(fingerprint);
      if (additions.length === 1 && missing?.length === 1) {
        pairs.push({ added: additions[0], missing: missing[0] });
      }
    }
    if (pairs.length === 0) return 0;

    this.db.exec('BEGIN');
    try {
      let revision = this.currentRevision(ownerId, libraryId);
      for (const pair of pairs) {
        this.db.run('DELETE FROM server_library_assets WHERE id = ?', [pair.added.id]);
        revision++;
        this.db.run(
          `UPDATE server_library_assets SET
            rootId = ?, relativePath = ?, fileName = ?, extension = ?, mimeType = ?,
            size = ?, mtimeMs = ?, inode = ?, quickHash = ?, status = 'online',
            scanGeneration = ?, lastSeenAt = ?, revision = ?,
            thumbVersion = thumbVersion + 1, errorCode = NULL, errorMessage = NULL,
            updatedAt = ?
           WHERE id = ?`,
          [
            pair.added.rootId,
            pair.added.relativePath,
            pair.added.name,
            pair.added.extension,
            pair.added.mimeType,
            pair.added.sizeBytes,
            pair.added.dateModified,
            pair.added.inode,
            pair.added.quickHash,
            scanGeneration,
            now,
            revision,
            now,
            pair.missing.id,
          ],
        );
      }
      this.setRevision(ownerId, libraryId, revision);
      this.db.exec('COMMIT');
      return pairs.length;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  markRootAvailable(rootId: string, now: number): void {
    this.db.run(
      `UPDATE server_library_roots SET lastSeenAt = ?, lastError = NULL WHERE id = ?`,
      [now, rootId],
    );
  }

  markRootUnavailable(rootId: string): void {
    this.db.run(
      `UPDATE server_library_roots SET lastError = 'Root is not accessible' WHERE id = ?`,
      [rootId],
    );
  }

  listAssets(
    ownerId: string,
    libraryId: string,
    cursor: string | null,
    limit: number,
    status?: LibraryAssetStatus,
  ): PhotoLibraryAssetPage {
    const params: Array<string | number> = [ownerId, libraryId];
    const filters = ['ownerId = ?', 'libraryId = ?'];
    if (cursor) {
      filters.push('id > ?');
      params.push(cursor);
    }
    if (status) {
      filters.push('status = ?');
      params.push(status);
    }
    params.push(limit + 1);
    const assets = this.queryAssets(
      `SELECT * FROM server_library_assets
       WHERE ${filters.join(' AND ')}
       ORDER BY id LIMIT ?`,
      params,
    );
    const hasMore = assets.length > limit;
    const page = hasMore ? assets.slice(0, limit) : assets;
    return {
      assets: page.map(toPublicAsset),
      nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
      hasMore,
      libraryRevision: this.currentRevision(ownerId, libraryId),
    };
  }

  listChanges(
    ownerId: string,
    libraryId: string,
    afterRevision: number,
    limit: number,
  ): PhotoLibraryAssetChanges {
    const assets = this.queryAssets(
      `SELECT * FROM server_library_assets
       WHERE ownerId = ? AND libraryId = ? AND revision > ?
       ORDER BY revision, id LIMIT ?`,
      [ownerId, libraryId, afterRevision, limit + 1],
    );
    const hasMore = assets.length > limit;
    const page = hasMore ? assets.slice(0, limit) : assets;
    return {
      assets: page.map(toPublicAsset),
      nextAfterRevision: page.at(-1)?.revision ?? afterRevision,
      hasMore,
      libraryRevision: this.currentRevision(ownerId, libraryId),
    };
  }

  getStats(ownerId: string, libraryId: string): PhotoLibraryStats {
    const stmt = this.db.prepare(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
       FROM server_library_assets
       WHERE ownerId = ? AND libraryId = ?
       GROUP BY status`,
    );
    stmt.bind([ownerId, libraryId]);
    const stats: PhotoLibraryStats = {
      total: 0,
      online: 0,
      offline: 0,
      error: 0,
      trashed: 0,
      importing: 0,
      onlineBytes: 0,
      libraryRevision: this.currentRevision(ownerId, libraryId),
    };
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const status = String(row.status) as LibraryAssetStatus;
      const count = Number(row.count ?? 0);
      stats.total += count;
      stats[status] = count;
      if (status === 'online') stats.onlineBytes = Number(row.bytes ?? 0);
    }
    stmt.free();
    return stats;
  }

  private nextGeneration(ownerId: string, libraryId: string): number {
    const stmt = this.db.prepare(
      `SELECT COALESCE(MAX(generation), 0) + 1 AS generation
       FROM server_library_scans WHERE ownerId = ? AND libraryId = ?`,
    );
    stmt.bind([ownerId, libraryId]);
    const generation = stmt.step()
      ? Number(stmt.getAsObject().generation ?? 1)
      : 1;
    stmt.free();
    return generation;
  }

  private nextRevision(ownerId: string, libraryId: string): number {
    const revision = this.currentRevision(ownerId, libraryId) + 1;
    this.setRevision(ownerId, libraryId, revision);
    return revision;
  }

  private currentRevision(ownerId: string, libraryId: string): number {
    const stmt = this.db.prepare(
      'SELECT revision FROM server_libraries WHERE ownerId = ? AND id = ?',
    );
    stmt.bind([ownerId, libraryId]);
    const revision = stmt.step() ? Number(stmt.getAsObject().revision ?? 0) : 0;
    stmt.free();
    return revision;
  }

  private setRevision(ownerId: string, libraryId: string, revision: number): void {
    this.db.run(
      `UPDATE server_libraries SET revision = ?, updatedAt = ?
       WHERE ownerId = ? AND id = ?`,
      [revision, Date.now(), ownerId, libraryId],
    );
  }

  private queryAssets(sql: string, params: Array<string | number>): StoredLibraryAsset[] {
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const assets: StoredLibraryAsset[] = [];
    while (stmt.step()) assets.push(mapStoredAsset(stmt.getAsObject()));
    stmt.free();
    return assets;
  }

  private rollback(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // Preserve the original database error.
    }
  }
}

function mapStoredAsset(row: Record<string, unknown>): StoredLibraryAsset {
  return {
    id: String(row.id),
    ownerId: String(row.ownerId),
    libraryId: String(row.libraryId),
    rootId: String(row.rootId),
    relativePath: String(row.relativePath),
    name: String(row.fileName),
    extension: String(row.extension),
    fullChecksum: nullableString(row.fullChecksum),
    mimeType: nullableString(row.mimeType),
    sizeBytes: Number(row.size),
    dateModified: Number(row.mtimeMs),
    inode: nullableNumber(row.inode),
    quickHash: nullableString(row.quickHash),
    width: nullableNumber(row.width),
    height: nullableNumber(row.height),
    dateTaken: nullableNumber(row.dateTaken),
    metadata: parseAssetMetadata(row.metadataJson),
    status: row.status as LibraryAssetStatus,
    scanGeneration: Number(row.scanGeneration),
    firstSeenGeneration: Number(row.firstSeenGeneration),
    lastSeenAt: Number(row.lastSeenAt),
    revision: Number(row.revision),
    thumbVersion: Number(row.thumbVersion),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    errorCode: nullableString(row.errorCode),
    errorMessage: nullableString(row.errorMessage),
  };
}

function toPublicAsset(asset: StoredLibraryAsset): PhotoLibraryAsset {
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
    metadata: asset.metadata,
    status: asset.status,
    revision: asset.revision,
  };
}

function parseAssetMetadata(value: unknown): PhotoLibraryAssetMetadata | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? parsed as PhotoLibraryAssetMetadata
      : null;
  } catch {
    return null;
  }
}

function mapScan(row: Record<string, unknown>): PhotoLibraryScan {
  return {
    id: String(row.id),
    libraryId: String(row.libraryId),
    status: row.status as LibraryScanStatus,
    generation: Number(row.generation),
    discovered: Number(row.discovered),
    added: Number(row.added),
    updated: Number(row.updated),
    offline: Number(row.offline),
    restored: Number(row.restored),
    errors: Number(row.errors),
    currentPath: nullableString(row.currentPath),
    cancelRequested: row.cancelRequested === 1,
    startedAt: nullableNumber(row.startedAt),
    finishedAt: nullableNumber(row.finishedAt),
    createdAt: Number(row.createdAt),
    errorSummary: nullableString(row.errorSummary),
  };
}

function groupByFingerprint(
  assets: readonly StoredLibraryAsset[],
): Map<string, StoredLibraryAsset[]> {
  const groups = new Map<string, StoredLibraryAsset[]>();
  for (const asset of assets) {
    if (!asset.quickHash) continue;
    const key = `${asset.quickHash}:${asset.sizeBytes}`;
    const group = groups.get(key) ?? [];
    group.push(asset);
    groups.set(key, group);
  }
  return groups;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
