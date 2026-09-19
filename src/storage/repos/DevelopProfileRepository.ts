import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import type { RevisionTable } from './types';
import type { Adjustments } from '../../types';
import type { DevelopProfile, DevelopProfileScope } from '../../engine/developProfile';

export interface DevelopProfileRow extends DevelopProfile {
  id: number;
  createdAt: number;
  deletedAt: number | null;
}

export class DevelopProfileRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;
  private readonly onWrite: () => void;

  constructor(storage: CatalogStorage, onWrite: (table: RevisionTable) => void) {
    this.storage = storage;
    this.db = storage.db;
    this.onWrite = () => onWrite('developProfiles');
  }

  list(): DevelopProfileRow[] {
    const stmt = this.db.prepare(
      'SELECT * FROM developProfiles WHERE deletedAt IS NULL ORDER BY scope, key',
    );
    const out: DevelopProfileRow[] = [];
    while (stmt.step()) out.push(parse(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  /**
   * Write the profile for one scope+key+band, replacing any profile already
   * covering it.
   *
   * Upsert rather than insert because a profile is identified by what it
   * covers, not by when it was made: saving the bench twice for the same
   * camera has to refine that camera's profile, not stack a second one behind
   * it that only a tie-break decides between.
   */
  save(args: {
    name: string;
    scope: DevelopProfileScope;
    key: string;
    isoFrom?: number | null;
    isoTo?: number | null;
    adjustments: Partial<Adjustments>;
  }): DevelopProfileRow {
    const now = Date.now();
    const isoFrom = args.isoFrom ?? null;
    const isoTo = args.isoTo ?? null;
    const existing = this.find(args.scope, args.key, isoFrom, isoTo);

    if (existing) {
      this.db.run(
        `UPDATE developProfiles SET name = ?, adjustments = ?, updatedAt = ?, deletedAt = NULL
         WHERE id = ?`,
        [args.name, JSON.stringify(args.adjustments), now, existing.id],
      );
    } else {
      this.db.run(
        `INSERT INTO developProfiles
           (syncId, name, scope, key, isoFrom, isoTo, adjustments, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          crypto.randomUUID(), args.name, args.scope, args.key,
          isoFrom, isoTo, JSON.stringify(args.adjustments), now, now,
        ],
      );
    }
    this.storage.flush();
    this.onWrite();
    return this.find(args.scope, args.key, isoFrom, isoTo)!;
  }

  softDelete(id: number): void {
    const now = Date.now();
    this.db.run('UPDATE developProfiles SET deletedAt = ?, updatedAt = ? WHERE id = ?', [now, now, id]);
    this.storage.flush();
    this.onWrite();
  }

  private find(
    scope: DevelopProfileScope, key: string, isoFrom: number | null, isoTo: number | null,
  ): DevelopProfileRow | null {
    const stmt = this.db.prepare(
      `SELECT * FROM developProfiles
       WHERE scope = ? AND key = ? AND isoFrom IS ? AND isoTo IS ? AND deletedAt IS NULL`,
    );
    stmt.bind([scope, key, isoFrom, isoTo]);
    const row = stmt.step() ? parse(stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    return row;
  }
}

function parse(r: Record<string, unknown>): DevelopProfileRow {
  return {
    id: r.id as number,
    syncId: r.syncId as string,
    name: r.name as string,
    scope: r.scope as DevelopProfileScope,
    key: r.key as string,
    isoFrom: (r.isoFrom as number | null) ?? null,
    isoTo: (r.isoTo as number | null) ?? null,
    adjustments: r.adjustments ? JSON.parse(r.adjustments as string) : {},
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
    deletedAt: (r.deletedAt as number | null) ?? null,
  };
}
