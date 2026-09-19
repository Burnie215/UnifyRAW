import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import type { RevisionTable } from './types';
import type { PresetRow } from './types';
import { withoutLensCorrection, type Adjustments } from '../../types';
import { DEFAULT_PRESETS_STAMP } from '../../data/defaultPresets';

export class PresetRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;
  private readonly onWrite: () => void;

  constructor(storage: CatalogStorage, onWrite: (table: RevisionTable) => void) {
    this.storage = storage;
    this.db = storage.db;
    this.onWrite = () => onWrite('presets');
  }

  list(): PresetRow[] {
    const stmt = this.db.prepare('SELECT * FROM presets WHERE deletedAt IS NULL ORDER BY category, name');
    const out: PresetRow[] = [];
    while (stmt.step()) out.push(parse(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  get(id: number): PresetRow | null {
    const stmt = this.db.prepare('SELECT * FROM presets WHERE id = ?');
    stmt.bind([id]);
    const row = stmt.step() ? parse(stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    return row;
  }

  /** A preset row never stores the lens correction, whoever hands it in. */
  add(args: { name: string; adjustments: Partial<Adjustments>; category?: string | null }): number {
    const now = Date.now();
    const syncId = crypto.randomUUID();
    this.db.run(
      `INSERT INTO presets (syncId, name, adjustments, category, createdAt, updatedAt, deletedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [syncId, args.name, JSON.stringify(withoutLensCorrection(args.adjustments)), args.category ?? null, now, now, null],
    );
    const stmt = this.db.prepare('SELECT last_insert_rowid() AS id');
    stmt.step();
    const id = (stmt.getAsObject() as { id: number }).id;
    stmt.free();
    this.storage.flush();
    this.onWrite();
    return id;
  }

  /** Seed versioned PhotoLib defaults exactly once per catalog. A soft-deleted
   * default still counts as present, so a user's deletion is respected. */
  ensureDefaults(definitions: ReadonlyArray<{
    syncId: string;
    name: string;
    adjustments: Partial<Adjustments>;
    category?: string | null;
  }>, stamp = DEFAULT_PRESETS_STAMP): number {
    const existing = new Set<string>();
    const select = this.db.prepare('SELECT syncId FROM presets');
    while (select.step()) {
      const syncId = select.getAsObject().syncId;
      if (typeof syncId === 'string') existing.add(syncId);
    }
    select.free();

    const missing = definitions.filter((definition) => !existing.has(definition.syncId));
    if (missing.length === 0) return 0;

    const insert = this.db.prepare(
      `INSERT INTO presets (syncId, name, adjustments, category, createdAt, updatedAt, deletedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      for (const definition of missing) {
        insert.run([
          definition.syncId,
          definition.name,
          JSON.stringify(definition.adjustments),
          definition.category ?? null,
          stamp,
          stamp,
          null,
        ]);
      }
    } finally {
      insert.free();
    }
    this.storage.flush();
    this.onWrite();
    return missing.length;
  }

  update(id: number, patch: Partial<Pick<PresetRow, 'name' | 'adjustments' | 'category'>>): void {
    const fields: string[] = [];
    const params: (string | number | null)[] = [];
    if (patch.name !== undefined) { fields.push('name = ?'); params.push(patch.name); }
    if (patch.adjustments !== undefined) { fields.push('adjustments = ?'); params.push(JSON.stringify(withoutLensCorrection(patch.adjustments))); }
    if (patch.category !== undefined) { fields.push('category = ?'); params.push(patch.category); }
    if (fields.length === 0) return;
    fields.push('updatedAt = ?');
    params.push(Date.now(), id);
    this.db.run(`UPDATE presets SET ${fields.join(', ')} WHERE id = ?`, params);
    this.storage.flush();
    this.onWrite();
  }

  softDelete(id: number): void {
    const now = Date.now();
    this.db.run('UPDATE presets SET deletedAt = ?, updatedAt = ? WHERE id = ?', [now, now, id]);
    this.storage.flush();
    this.onWrite();
  }

  hardDelete(id: number): void {
    this.db.run('DELETE FROM presets WHERE id = ?', [id]);
    this.storage.flush();
    this.onWrite();
  }
}

function parse(r: Record<string, unknown>): PresetRow {
  return {
    id: r.id as number,
    syncId: r.syncId as string,
    name: r.name as string,
    adjustments: r.adjustments ? JSON.parse(r.adjustments as string) : {},
    category: (r.category as string | null) ?? null,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
    deletedAt: (r.deletedAt as number | null) ?? null,
  };
}
