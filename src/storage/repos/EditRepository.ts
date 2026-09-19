import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import type { RevisionTable } from './types';
import type { EditRow } from './types';
import type { Adjustments } from '../../types';
import type { PhotoDocument } from '../../engine/DocumentModel';

export class EditRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;
  private readonly onWrite: () => void;

  constructor(storage: CatalogStorage, onWrite: (table: RevisionTable) => void) {
    this.storage = storage;
    this.db = storage.db;
    this.onWrite = () => onWrite('edits');
  }

  /** Master edit (copyIndex=0) for a contentHash. */
  getMaster(contentHash: string): EditRow | null {
    return this.getCopy(contentHash, 0);
  }

  getCopy(contentHash: string, copyIndex: number): EditRow | null {
    const stmt = this.db.prepare(
      'SELECT * FROM edits WHERE contentHash = ? AND copyIndex = ? AND deletedAt IS NULL',
    );
    stmt.bind([contentHash, copyIndex]);
    const row = stmt.step() ? parse(stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    return row;
  }

  listForHash(contentHash: string): EditRow[] {
    const stmt = this.db.prepare(
      'SELECT * FROM edits WHERE contentHash = ? AND deletedAt IS NULL ORDER BY copyIndex',
    );
    stmt.bind([contentHash]);
    const out: EditRow[] = [];
    while (stmt.step()) out.push(parse(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  /**
   * contentHash -> when its edits were last touched.
   *
   * Feeds the RAW+JPEG grid representative: when one half of a pair has been
   * worked on, that half is the one worth looking at in the library.
   */
  editedAtByHash(): Map<string, number> {
    const stmt = this.db.prepare(
      `SELECT contentHash, MAX(updatedAt) AS updatedAt FROM edits
       WHERE deletedAt IS NULL GROUP BY contentHash`,
    );
    const out = new Map<string, number>();
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>;
      const hash = row.contentHash as string | null;
      const updatedAt = Number(row.updatedAt ?? 0);
      if (hash && Number.isFinite(updatedAt)) out.set(hash, updatedAt);
    }
    stmt.free();
    return out;
  }

  upsert(args: {
    contentHash: string;
    copyIndex?: number;
    copyName?: string | null;
    adjustments: Adjustments;
    document?: PhotoDocument | null;
    history?: Adjustments[];
    documentHistory?: PhotoDocument[] | null;
  }): void {
    const existing = this.getCopy(args.contentHash, args.copyIndex ?? 0);
    const now = Date.now();
    this.db.run(
      `INSERT INTO edits (
         contentHash, copyIndex, copyName, adjustments, document, history, documentHistory,
         createdAt, updatedAt, deletedAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(contentHash, copyIndex) DO UPDATE SET
         copyName = excluded.copyName,
         adjustments = excluded.adjustments,
         document = excluded.document,
         history = excluded.history,
         documentHistory = excluded.documentHistory,
         updatedAt = excluded.updatedAt,
         deletedAt = excluded.deletedAt`,
      [
        args.contentHash,
        args.copyIndex ?? 0,
        args.copyName ?? null,
        JSON.stringify(args.adjustments),
        args.document ? JSON.stringify(args.document) : null,
        JSON.stringify(args.history ?? []),
        args.documentHistory ? JSON.stringify(args.documentHistory) : null,
        existing?.createdAt ?? now,
        now,
        null,
      ],
    );
    this.storage.flush();
    this.onWrite();
  }

  /** Append a new virtual copy. Returns the assigned copyIndex. */
  appendCopy(args: {
    contentHash: string;
    copyName: string;
    adjustments: Adjustments;
    document?: PhotoDocument | null;
  }): number {
    const existing = this.listForHash(args.contentHash);
    const nextIdx = existing.length ? Math.max(...existing.map((e) => e.copyIndex)) + 1 : 1;
    this.upsert({ ...args, copyIndex: nextIdx });
    return nextIdx;
  }

  softDelete(contentHash: string, copyIndex: number): void {
    const now = Date.now();
    this.db.run(
      'UPDATE edits SET deletedAt = ?, updatedAt = ? WHERE contentHash = ? AND copyIndex = ?',
      [now, now, contentHash, copyIndex],
    );
    this.storage.flush();
    this.onWrite();
  }

  hardDelete(contentHash: string, copyIndex: number): void {
    this.db.run(
      'DELETE FROM edits WHERE contentHash = ? AND copyIndex = ?',
      [contentHash, copyIndex],
    );
    this.storage.flush();
    this.onWrite();
  }
}

function parse(r: Record<string, unknown>): EditRow {
  return {
    contentHash: r.contentHash as string,
    copyIndex: r.copyIndex as number,
    copyName: (r.copyName as string | null) ?? null,
    adjustments: JSON.parse(r.adjustments as string) as Adjustments,
    document: r.document ? JSON.parse(r.document as string) as PhotoDocument : null,
    history: r.history ? JSON.parse(r.history as string) as Adjustments[] : [],
    documentHistory: r.documentHistory ? JSON.parse(r.documentHistory as string) as PhotoDocument[] : null,
    createdAt: r.createdAt as number,
    updatedAt: r.updatedAt as number,
    deletedAt: (r.deletedAt as number | null) ?? null,
  };
}
