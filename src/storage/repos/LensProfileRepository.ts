import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import type { RevisionTable } from './types';
import type { LensCoefficients, MeasuredLensProfile } from '../../engine/lensProfile';
import { NEUTRAL_LENS_COEFFICIENTS } from '../../engine/lensProfile';

export interface LensProfileRow extends MeasuredLensProfile {
  id: number;
  createdAt: number;
  deletedAt: number | null;
}

export class LensProfileRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;
  private readonly onWrite: () => void;

  constructor(storage: CatalogStorage, onWrite: (table: RevisionTable) => void) {
    this.storage = storage;
    this.db = storage.db;
    this.onWrite = () => onWrite('lensProfiles');
  }

  list(): LensProfileRow[] {
    const stmt = this.db.prepare(
      'SELECT * FROM lensProfiles WHERE deletedAt IS NULL ORDER BY key, focalFrom',
    );
    const out: LensProfileRow[] = [];
    while (stmt.step()) out.push(parse(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  /**
   * Write the profile for one lens and focal band, replacing what covers it.
   *
   * Upsert for the same reason the develop profiles use one: a profile is
   * identified by what it covers, so measuring the same lens twice has to
   * refine it rather than leave two behind for a tie-break to choose between.
   */
  save(args: {
    name: string;
    key: string;
    focalFrom?: number | null;
    focalTo?: number | null;
    coefficients: LensCoefficients;
  }): LensProfileRow {
    const now = Date.now();
    const focalFrom = args.focalFrom ?? null;
    const focalTo = args.focalTo ?? null;
    const existing = this.find(args.key, focalFrom, focalTo);

    if (existing) {
      this.db.run(
        'UPDATE lensProfiles SET name = ?, coefficients = ?, updatedAt = ?, deletedAt = NULL WHERE id = ?',
        [args.name, JSON.stringify(args.coefficients), now, existing.id],
      );
    } else {
      this.db.run(
        `INSERT INTO lensProfiles
           (syncId, name, key, focalFrom, focalTo, coefficients, createdAt, updatedAt, deletedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          crypto.randomUUID(), args.name, args.key, focalFrom, focalTo,
          JSON.stringify(args.coefficients), now, now,
        ],
      );
    }
    this.storage.flush();
    this.onWrite();
    return this.find(args.key, focalFrom, focalTo)!;
  }

  softDelete(id: number): void {
    const now = Date.now();
    this.db.run('UPDATE lensProfiles SET deletedAt = ?, updatedAt = ? WHERE id = ?', [now, now, id]);
    this.storage.flush();
    this.onWrite();
  }

  private find(key: string, focalFrom: number | null, focalTo: number | null): LensProfileRow | null {
    const stmt = this.db.prepare(
      `SELECT * FROM lensProfiles
       WHERE key = ? AND focalFrom IS ? AND focalTo IS ? AND deletedAt IS NULL`,
    );
    stmt.bind([key, focalFrom, focalTo]);
    const row = stmt.step() ? parse(stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    return row;
  }
}

function parse(r: Record<string, unknown>): LensProfileRow {
  const coefficients = {
    ...NEUTRAL_LENS_COEFFICIENTS,
    ...(r.coefficients ? JSON.parse(r.coefficients as string) : {}),
  } as LensCoefficients;
  return {
    id: r.id as number,
    syncId: r.syncId as string,
    name: r.name as string,
    key: r.key as string,
    focalFrom: (r.focalFrom as number | null) ?? null,
    focalTo: (r.focalTo as number | null) ?? null,
    ...coefficients,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
    deletedAt: (r.deletedAt as number | null) ?? null,
  };
}
