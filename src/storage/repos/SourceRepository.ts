import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import type { RevisionTable } from './types';
import type { SourceRow } from './types';

export class SourceRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;
  private readonly onWrite: () => void;

  constructor(storage: CatalogStorage, onWrite: (table: RevisionTable) => void) {
    this.storage = storage;
    this.db = storage.db;
    this.onWrite = () => onWrite('sources');
  }

  list(includeDeleted = false): SourceRow[] {
    const stmt = this.db.prepare(
      includeDeleted
        ? 'SELECT * FROM sources ORDER BY addedAt'
        : 'SELECT * FROM sources WHERE deletedAt IS NULL ORDER BY addedAt',
    );
    const out: SourceRow[] = [];
    while (stmt.step()) out.push(parseRow(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  get(id: string): SourceRow | null {
    const stmt = this.db.prepare('SELECT * FROM sources WHERE id = ?');
    stmt.bind([id]);
    const row = stmt.step() ? parseRow(stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    return row;
  }

  put(row: Omit<SourceRow, 'updatedAt' | 'deletedAt'> & Partial<Pick<SourceRow, 'updatedAt' | 'deletedAt'>>): void {
    const now = row.updatedAt ?? Date.now();
    this.db.run(
      `INSERT INTO sources (id, type, label, config, addedAt, updatedAt, deletedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         label = excluded.label,
         config = excluded.config,
         updatedAt = excluded.updatedAt,
         deletedAt = excluded.deletedAt`,
      [row.id, row.type, row.label, JSON.stringify(row.config ?? {}), row.addedAt, now, row.deletedAt ?? null],
    );
    this.storage.flush();
    this.onWrite();
  }

  update(id: string, patch: Partial<Pick<SourceRow, 'label' | 'config'>>): void {
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.label !== undefined) { fields.push('label = ?'); params.push(patch.label); }
    if (patch.config !== undefined) { fields.push('config = ?'); params.push(JSON.stringify(patch.config)); }
    if (fields.length === 0) return;
    fields.push('updatedAt = ?');
    params.push(Date.now(), id);
    this.db.run(`UPDATE sources SET ${fields.join(', ')} WHERE id = ?`, params);
    this.storage.flush();
    this.onWrite();
  }

  /** Tombstone the source and its cached photos so removal propagates via sync. */
  softDelete(id: string): void {
    const now = Date.now();
    this.db.run('BEGIN');
    try {
      this.db.run('UPDATE sources SET deletedAt = ?, updatedAt = ? WHERE id = ?', [now, now, id]);
      this.db.run(
        'UPDATE photos SET deletedAt = ?, updatedAt = ? WHERE sourceId = ? AND deletedAt IS NULL',
        [now, now, id],
      );
      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
    this.storage.flush();
    this.onWrite();
  }

  /** Hard-delete: drop the source row and cascade through the photo cache. */
  hardDelete(id: string): void {
    this.db.run('DELETE FROM photos WHERE sourceId = ?', [id]);
    this.db.run('DELETE FROM sources WHERE id = ?', [id]);
    this.storage.flush();
    this.onWrite();
  }

  count(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) AS c FROM sources WHERE deletedAt IS NULL');
    stmt.step();
    const n = (stmt.getAsObject() as { c: number }).c;
    stmt.free();
    return n;
  }
}

function parseRow(row: Record<string, unknown>): SourceRow {
  return {
    id: row.id as string,
    type: row.type as string,
    label: row.label as string,
    config: row.config ? JSON.parse(row.config as string) : {},
    addedAt: row.addedAt as number,
    updatedAt: row.updatedAt as number,
    deletedAt: (row.deletedAt as number | null) ?? null,
  };
}
