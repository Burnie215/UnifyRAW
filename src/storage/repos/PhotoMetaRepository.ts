import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import type { RevisionTable } from './types';
import type { PhotoMetaRow, PhotoFlag, PhotoColorLabel } from './types';

export class PhotoMetaRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;
  private readonly onWrite: () => void;

  constructor(storage: CatalogStorage, onWrite: (table: RevisionTable) => void) {
    this.storage = storage;
    this.db = storage.db;
    this.onWrite = () => onWrite('photoMeta');
  }

  get(contentHash: string): PhotoMetaRow | null {
    const stmt = this.db.prepare('SELECT * FROM photoMeta WHERE contentHash = ?');
    stmt.bind([contentHash]);
    const row = stmt.step() ? parse(stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    return row;
  }

  bulkGet(hashes: string[]): Map<string, PhotoMetaRow> {
    if (hashes.length === 0) return new Map();
    const placeholders = hashes.map(() => '?').join(',');
    const stmt = this.db.prepare(`SELECT * FROM photoMeta WHERE contentHash IN (${placeholders})`);
    stmt.bind(hashes);
    const out = new Map<string, PhotoMetaRow>();
    while (stmt.step()) {
      const row = parse(stmt.getAsObject() as Record<string, unknown>);
      out.set(row.contentHash, row);
    }
    stmt.free();
    return out;
  }

  set(contentHash: string, patch: Partial<Pick<PhotoMetaRow, 'rating' | 'flag' | 'colorLabel' | 'keywords'>>): void {
    const now = Date.now();
    const existing = this.get(contentHash);
    const merged: PhotoMetaRow = {
      contentHash,
      rating: patch.rating !== undefined ? patch.rating : (existing?.rating ?? null),
      flag: patch.flag !== undefined ? patch.flag : (existing?.flag ?? null),
      colorLabel: patch.colorLabel !== undefined ? patch.colorLabel : (existing?.colorLabel ?? null),
      keywords: patch.keywords !== undefined ? patch.keywords : (existing?.keywords ?? []),
      updatedAt: now,
      deletedAt: null,
    };
    this.db.run(
      `INSERT INTO photoMeta (contentHash, rating, flag, colorLabel, keywords, updatedAt, deletedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contentHash) DO UPDATE SET
         rating = excluded.rating,
         flag = excluded.flag,
         colorLabel = excluded.colorLabel,
         keywords = excluded.keywords,
         updatedAt = excluded.updatedAt,
         deletedAt = excluded.deletedAt`,
      [
        merged.contentHash,
        merged.rating,
        merged.flag,
        merged.colorLabel,
        merged.keywords.length ? JSON.stringify(merged.keywords) : null,
        merged.updatedAt,
        null,
      ],
    );
    this.storage.flush();
    this.onWrite();
  }

  /** Tombstone the meta row (so sync propagates the delete). */
  softDelete(contentHash: string): void {
    const now = Date.now();
    this.db.run(
      'UPDATE photoMeta SET deletedAt = ?, updatedAt = ? WHERE contentHash = ?',
      [now, now, contentHash],
    );
    this.storage.flush();
    this.onWrite();
  }
}

function parse(r: Record<string, unknown>): PhotoMetaRow {
  return {
    contentHash: r.contentHash as string,
    rating: (r.rating as number | null) ?? null,
    flag: ((r.flag as string | null) ?? null) as PhotoFlag,
    colorLabel: ((r.colorLabel as string | null) ?? null) as PhotoColorLabel,
    keywords: r.keywords ? JSON.parse(r.keywords as string) as string[] : [],
    updatedAt: r.updatedAt as number,
    deletedAt: (r.deletedAt as number | null) ?? null,
  };
}
