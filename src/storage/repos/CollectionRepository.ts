import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import type { RevisionTable } from './types';
import type { CollectionRow, CollectionRule } from './types';

export class CollectionRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;
  private readonly onWrite: () => void;

  constructor(storage: CatalogStorage, onWrite: (table: RevisionTable) => void) {
    this.storage = storage;
    this.db = storage.db;
    this.onWrite = () => onWrite('collections');
  }

  list(): CollectionRow[] {
    const stmt = this.db.prepare('SELECT * FROM collections WHERE deletedAt IS NULL ORDER BY name');
    const out: CollectionRow[] = [];
    while (stmt.step()) out.push(parse(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  get(id: number): CollectionRow | null {
    const stmt = this.db.prepare('SELECT * FROM collections WHERE id = ?');
    stmt.bind([id]);
    const row = stmt.step() ? parse(stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    return row;
  }

  add(args: {
    name: string;
    type: 'manual' | 'smart' | string;
    parentId?: number | null;
    rules?: CollectionRule[] | null;
    photoIds?: number[] | null;
  }): number {
    const now = Date.now();
    const syncId = crypto.randomUUID();
    this.db.run(
      `INSERT INTO collections (syncId, name, type, parentId, rules, photoIds, createdAt, updatedAt, deletedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        syncId, args.name, args.type, args.parentId ?? null,
        args.rules ? JSON.stringify(args.rules) : null,
        args.photoIds ? JSON.stringify(args.photoIds) : null,
        now, now, null,
      ],
    );
    const stmt = this.db.prepare('SELECT last_insert_rowid() AS id');
    stmt.step();
    const id = (stmt.getAsObject() as { id: number }).id;
    stmt.free();
    this.storage.flush();
    this.onWrite();
    return id;
  }

  update(id: number, patch: Partial<Pick<CollectionRow, 'name' | 'type' | 'parentId' | 'rules' | 'photoIds'>>): void {
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); params.push(patch.name); }
    if (patch.type !== undefined) { fields.push('type = ?'); params.push(patch.type); }
    if (patch.parentId !== undefined) { fields.push('parentId = ?'); params.push(patch.parentId); }
    if (patch.rules !== undefined) { fields.push('rules = ?'); params.push(patch.rules ? JSON.stringify(patch.rules) : null); }
    if (patch.photoIds !== undefined) { fields.push('photoIds = ?'); params.push(patch.photoIds ? JSON.stringify(patch.photoIds) : null); }
    if (fields.length === 0) return;
    fields.push('updatedAt = ?');
    params.push(Date.now(), id);
    this.db.run(`UPDATE collections SET ${fields.join(', ')} WHERE id = ?`, params);
    this.storage.flush();
    this.onWrite();
  }

  softDelete(id: number): void {
    const now = Date.now();
    this.db.run('UPDATE collections SET deletedAt = ?, updatedAt = ? WHERE id = ?', [now, now, id]);
    this.storage.flush();
    this.onWrite();
  }

  bulkSoftDelete(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const now = Date.now();
    this.db.run(
      `UPDATE collections SET deletedAt = ?, updatedAt = ? WHERE id IN (${placeholders})`,
      [now, now, ...ids],
    );
    this.storage.flush();
    this.onWrite();
  }
}

function parse(r: Record<string, unknown>): CollectionRow {
  return {
    id: r.id as number,
    syncId: r.syncId as string,
    name: r.name as string,
    type: r.type as string,
    parentId: (r.parentId as number | null) ?? null,
    rules: r.rules ? JSON.parse(r.rules as string) : null,
    photoIds: r.photoIds ? JSON.parse(r.photoIds as string) : null,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
    deletedAt: (r.deletedAt as number | null) ?? null,
  };
}
