import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import type { ExportRow, RevisionTable } from './types';

/** What identifies a ledger entry: the export it describes. */
export type ExportIdentity = Pick<
  ExportRow, 'contentHash' | 'copyIndex' | 'targetSourceId' | 'editStackHash' | 'format'
>;

/**
 * The identity of a ledger entry as one string, the form `exports.syncId`
 * carries and /api/sync identifies the row by.
 *
 * Derived, not drawn: an export is the same export on every device that made
 * it, so two devices have to arrive at the same syncId or the pull would try
 * to add a second row for it and the unique key would refuse it forever. The
 * separator cannot appear inside a part - two hex hashes, an integer, a source
 * UUID and a format token - so distinct identities give distinct strings.
 */
export function exportSyncId(identity: ExportIdentity): string {
  const { contentHash, copyIndex, targetSourceId, editStackHash, format } = identity;
  return [contentHash, copyIndex, targetSourceId, editStackHash, format].join('/');
}

export class ExportRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;
  private readonly onWrite: () => void;

  constructor(storage: CatalogStorage, onWrite: (table: RevisionTable) => void) {
    this.storage = storage;
    this.db = storage.db;
    this.onWrite = () => onWrite('exports');
  }

  record(entry: Omit<ExportRow, 'id' | 'syncId' | 'updatedAt'>): void {
    const now = Date.now();
    this.db.run(
      `INSERT INTO exports (
         syncId, contentHash, copyIndex, targetSourceId, targetAssetId, targetUrl,
         format, editStackHash, filename, bytes, status, uploadedAt, updatedAt, deletedAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(syncId) DO UPDATE SET
         targetAssetId = excluded.targetAssetId,
         targetUrl = excluded.targetUrl,
         filename = excluded.filename,
         bytes = excluded.bytes,
         status = excluded.status,
         uploadedAt = excluded.uploadedAt,
         updatedAt = excluded.updatedAt,
         deletedAt = excluded.deletedAt`,
      [
        exportSyncId(entry),
        entry.contentHash,
        entry.copyIndex,
        entry.targetSourceId,
        entry.targetAssetId,
        entry.targetUrl,
        entry.format,
        entry.editStackHash,
        entry.filename,
        entry.bytes,
        entry.status,
        entry.uploadedAt,
        now,
        entry.deletedAt,
      ],
    );
    this.storage.flush();
    this.onWrite();
  }

  listForHash(contentHash: string, copyIndex?: number): ExportRow[] {
    const sql = copyIndex === undefined
      ? `SELECT * FROM exports
         WHERE contentHash = ? AND deletedAt IS NULL
         ORDER BY uploadedAt DESC, updatedAt DESC, id DESC`
      : `SELECT * FROM exports
         WHERE contentHash = ? AND copyIndex = ? AND deletedAt IS NULL
         ORDER BY uploadedAt DESC, updatedAt DESC, id DESC`;
    const stmt = this.db.prepare(sql);
    stmt.bind(copyIndex === undefined ? [contentHash] : [contentHash, copyIndex]);
    const rows: ExportRow[] = [];
    while (stmt.step()) rows.push(parse(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return rows;
  }

  latestFor(contentHash: string, copyIndex: number, targetSourceId: string): ExportRow | null {
    const stmt = this.db.prepare(
      `SELECT * FROM exports
       WHERE contentHash = ? AND copyIndex = ? AND targetSourceId = ? AND deletedAt IS NULL
       ORDER BY uploadedAt DESC, updatedAt DESC, id DESC
       LIMIT 1`,
    );
    stmt.bind([contentHash, copyIndex, targetSourceId]);
    const row = stmt.step() ? parse(stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    return row;
  }

  markMissing(id: number): void {
    this.db.run(
      `UPDATE exports SET status = 'missing', updatedAt = ? WHERE id = ? AND deletedAt IS NULL`,
      [Date.now(), id],
    );
    this.storage.flush();
    this.onWrite();
  }
}

function parse(row: Record<string, unknown>): ExportRow {
  return {
    id: Number(row.id),
    syncId: row.syncId as string,
    contentHash: row.contentHash as string,
    copyIndex: Number(row.copyIndex),
    targetSourceId: row.targetSourceId as string,
    targetAssetId: row.targetAssetId as string,
    targetUrl: (row.targetUrl as string | null) ?? null,
    format: row.format as ExportRow['format'],
    editStackHash: row.editStackHash as string,
    filename: row.filename as string,
    bytes: Number(row.bytes),
    status: row.status as ExportRow['status'],
    uploadedAt: Number(row.uploadedAt),
    updatedAt: Number(row.updatedAt),
    deletedAt: (row.deletedAt as number | null) ?? null,
  };
}
