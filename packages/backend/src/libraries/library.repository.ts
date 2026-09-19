import type { Database } from 'sql.js';
import type { LibraryMode, LibraryStatus } from '@photolib/shared';

export interface StoredLibraryRoot {
  id: string;
  libraryId: string;
  ownerId: string;
  path: string;
  canonicalPath: string;
  label: string;
  writable: boolean;
  lastSeenAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface StoredPhotoLibrary {
  id: string;
  ownerId: string;
  name: string;
  mode: LibraryMode;
  readOnly: boolean;
  exclusionPatterns: string[];
  includeHidden: boolean;
  watchEnabled: boolean;
  scanIntervalMinutes: number;
  revision: number;
  status: LibraryStatus;
  lastScanAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  roots: StoredLibraryRoot[];
}

export interface NewStoredPhotoLibrary {
  id: string;
  ownerId: string;
  name: string;
  mode: LibraryMode;
  readOnly: boolean;
  exclusionPatterns: string[];
  includeHidden: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NewStoredLibraryRoot {
  id: string;
  path: string;
  canonicalPath: string;
  label: string;
  writable: boolean;
}

export interface StoredLibraryUpdate {
  name: string;
  exclusionPatterns: string[];
  includeHidden: boolean;
  scanIntervalMinutes: number;
  updatedAt: number;
}

export class LibraryRepository {
  constructor(private readonly db: Database) {}

  list(ownerId: string): StoredPhotoLibrary[] {
    const stmt = this.db.prepare(
      `SELECT * FROM server_libraries
       WHERE ownerId = ?
       ORDER BY name COLLATE NOCASE, id`,
    );
    stmt.bind([ownerId]);
    const libraries: StoredPhotoLibrary[] = [];
    while (stmt.step()) {
      libraries.push(this.mapLibrary(stmt.getAsObject(), ownerId));
    }
    stmt.free();
    return libraries;
  }

  get(ownerId: string, libraryId: string): StoredPhotoLibrary | null {
    const stmt = this.db.prepare(
      'SELECT * FROM server_libraries WHERE ownerId = ? AND id = ?',
    );
    stmt.bind([ownerId, libraryId]);
    const library = stmt.step()
      ? this.mapLibrary(stmt.getAsObject(), ownerId)
      : null;
    stmt.free();
    return library;
  }

  listDueForScan(now: number): Array<{ ownerId: string; libraryId: string }> {
    const stmt = this.db.prepare(
      `SELECT ownerId, id FROM server_libraries
       WHERE scanIntervalMinutes > 0
         AND status <> 'scanning'
         AND (lastScanAt IS NULL OR lastScanAt <= ? - scanIntervalMinutes * 60000)`,
    );
    stmt.bind([now]);
    const due: Array<{ ownerId: string; libraryId: string }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      due.push({ ownerId: stringValue(row.ownerId), libraryId: stringValue(row.id) });
    }
    stmt.free();
    return due;
  }

  create(
    library: NewStoredPhotoLibrary,
    roots: readonly NewStoredLibraryRoot[],
  ): StoredPhotoLibrary {
    this.db.exec('BEGIN');
    try {
      this.db.run(
        `INSERT INTO server_libraries (
          id, ownerId, name, mode, readOnly, exclusionPatterns, includeHidden,
          watchEnabled, scanIntervalMinutes, revision, status,
          lastScanAt, lastError, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'idle', NULL, NULL, ?, ?)`,
        [
          library.id,
          library.ownerId,
          library.name,
          library.mode,
          library.readOnly ? 1 : 0,
          JSON.stringify(library.exclusionPatterns),
          library.includeHidden ? 1 : 0,
          library.createdAt,
          library.updatedAt,
        ],
      );

      for (const root of roots) {
        this.db.run(
          `INSERT INTO server_library_roots (
            id, libraryId, ownerId, path, canonicalPath, label, writable,
            lastSeenAt, lastError, createdAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
          [
            root.id,
            library.id,
            library.ownerId,
            root.path,
            root.canonicalPath,
            root.label,
            root.writable ? 1 : 0,
            library.createdAt,
          ],
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.rollback();
      throw error;
    }

    const created = this.get(library.ownerId, library.id);
    if (!created) throw new Error('Created library could not be loaded');
    return created;
  }

  update(
    ownerId: string,
    libraryId: string,
    update: StoredLibraryUpdate,
  ): StoredPhotoLibrary | null {
    this.db.run(
      `UPDATE server_libraries SET
        name = ?, exclusionPatterns = ?, includeHidden = ?,
        scanIntervalMinutes = ?, updatedAt = ?
       WHERE ownerId = ? AND id = ?`,
      [
        update.name,
        JSON.stringify(update.exclusionPatterns),
        update.includeHidden ? 1 : 0,
        update.scanIntervalMinutes,
        update.updatedAt,
        ownerId,
        libraryId,
      ],
    );
    return this.get(ownerId, libraryId);
  }

  hasActiveOperations(ownerId: string, libraryId: string): boolean {
    const stmt = this.db.prepare(
      `SELECT
        EXISTS(
          SELECT 1 FROM server_library_scans
          WHERE ownerId = ? AND libraryId = ? AND status IN ('queued', 'running')
        ) OR EXISTS(
          SELECT 1 FROM server_library_imports
          WHERE ownerId = ? AND libraryId = ? AND status IN ('pending', 'uploading', 'uploaded')
        ) AS active`,
    );
    stmt.bind([ownerId, libraryId, ownerId, libraryId]);
    const active = stmt.step() && Number(stmt.getAsObject().active) === 1;
    stmt.free();
    return active;
  }

  delete(ownerId: string, libraryId: string): boolean {
    if (!this.get(ownerId, libraryId)) return false;

    this.db.exec('BEGIN');
    try {
      this.db.run(
        'DELETE FROM server_library_imports WHERE ownerId = ? AND libraryId = ?',
        [ownerId, libraryId],
      );
      this.db.run(
        'DELETE FROM server_library_assets WHERE ownerId = ? AND libraryId = ?',
        [ownerId, libraryId],
      );
      this.db.run(
        'DELETE FROM server_library_scans WHERE ownerId = ? AND libraryId = ?',
        [ownerId, libraryId],
      );
      this.db.run(
        'DELETE FROM server_library_roots WHERE ownerId = ? AND libraryId = ?',
        [ownerId, libraryId],
      );
      this.db.run(
        'DELETE FROM server_libraries WHERE ownerId = ? AND id = ?',
        [ownerId, libraryId],
      );
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.rollback();
      throw error;
    }
  }

  private mapLibrary(row: Record<string, unknown>, ownerId: string): StoredPhotoLibrary {
    const id = stringValue(row.id);
    return {
      id,
      ownerId: stringValue(row.ownerId),
      name: stringValue(row.name),
      mode: row.mode as LibraryMode,
      readOnly: booleanValue(row.readOnly),
      exclusionPatterns: parsePatterns(row.exclusionPatterns),
      includeHidden: booleanValue(row.includeHidden),
      watchEnabled: booleanValue(row.watchEnabled),
      scanIntervalMinutes: numberValue(row.scanIntervalMinutes),
      revision: numberValue(row.revision),
      status: row.status as LibraryStatus,
      lastScanAt: nullableNumber(row.lastScanAt),
      lastError: nullableString(row.lastError),
      createdAt: numberValue(row.createdAt),
      updatedAt: numberValue(row.updatedAt),
      roots: this.listRoots(ownerId, id),
    };
  }

  private listRoots(ownerId: string, libraryId: string): StoredLibraryRoot[] {
    const stmt = this.db.prepare(
      `SELECT * FROM server_library_roots
       WHERE ownerId = ? AND libraryId = ?
       ORDER BY label COLLATE NOCASE, id`,
    );
    stmt.bind([ownerId, libraryId]);
    const roots: StoredLibraryRoot[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      roots.push({
        id: stringValue(row.id),
        libraryId: stringValue(row.libraryId),
        ownerId: stringValue(row.ownerId),
        path: stringValue(row.path),
        canonicalPath: stringValue(row.canonicalPath),
        label: stringValue(row.label),
        writable: booleanValue(row.writable),
        lastSeenAt: nullableNumber(row.lastSeenAt),
        lastError: nullableString(row.lastError),
        createdAt: numberValue(row.createdAt),
      });
    }
    stmt.free();
    return roots;
  }

  private rollback(): void {
    try {
      this.db.exec('ROLLBACK');
    } catch {
      // Preserve the original database error.
    }
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === 1;
}

function parsePatterns(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}
