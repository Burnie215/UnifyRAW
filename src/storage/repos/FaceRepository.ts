import type { Database } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import type { RevisionTable } from './types';
import type { FaceRow } from './types';

export class FaceRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;
  private readonly onWrite: () => void;

  constructor(storage: CatalogStorage, onWrite: (table: RevisionTable) => void) {
    this.storage = storage;
    this.db = storage.db;
    this.onWrite = () => onWrite('faces');
  }

  listForPhoto(photoId: number): FaceRow[] {
    const stmt = this.db.prepare('SELECT * FROM faces WHERE photoId = ? ORDER BY confidence DESC');
    stmt.bind([photoId]);
    const out: FaceRow[] = [];
    while (stmt.step()) out.push(parse(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  listByCluster(clusterId: number): FaceRow[] {
    const stmt = this.db.prepare('SELECT * FROM faces WHERE clusterId = ? ORDER BY confidence DESC');
    stmt.bind([clusterId]);
    const out: FaceRow[] = [];
    while (stmt.step()) out.push(parse(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  listAll(): FaceRow[] {
    const stmt = this.db.prepare('SELECT * FROM faces ORDER BY confidence DESC');
    const out: FaceRow[] = [];
    while (stmt.step()) out.push(parse(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  bulkAdd(faces: Array<Omit<FaceRow, 'id'>>): number[] {
    if (faces.length === 0) return [];
    const ids: number[] = [];
    this.db.run('BEGIN');
    try {
      for (const f of faces) {
        this.db.run(
          `INSERT INTO faces (photoId, x, y, width, height, confidence, embedding, clusterId, name, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            f.photoId, f.x, f.y, f.width, f.height, f.confidence,
            f.embedding ? JSON.stringify(f.embedding) : null,
            f.clusterId, f.name, f.createdAt,
          ],
        );
        const stmt = this.db.prepare('SELECT last_insert_rowid() AS id');
        stmt.step();
        ids.push((stmt.getAsObject() as { id: number }).id);
        stmt.free();
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.storage.flush();
    this.onWrite();
    return ids;
  }

  updateName(id: number, name: string | null): void {
    this.db.run('UPDATE faces SET name = ? WHERE id = ?', [name, id]);
    this.storage.flush();
    this.onWrite();
  }

  updateCluster(id: number, clusterId: number | null): void {
    this.db.run('UPDATE faces SET clusterId = ? WHERE id = ?', [clusterId, id]);
    this.storage.flush();
    this.onWrite();
  }

  bulkUpdateCluster(updates: Array<{ id: number; clusterId: number | null }>): void {
    if (updates.length === 0) return;
    this.db.run('BEGIN');
    try {
      for (const u of updates) {
        this.db.run('UPDATE faces SET clusterId = ? WHERE id = ?', [u.clusterId, u.id]);
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.storage.flush();
    this.onWrite();
  }
}

function parse(r: Record<string, unknown>): FaceRow {
  return {
    id: r.id as number,
    photoId: r.photoId as number,
    x: r.x as number,
    y: r.y as number,
    width: r.width as number,
    height: r.height as number,
    confidence: r.confidence as number,
    embedding: r.embedding ? JSON.parse(r.embedding as string) as number[] : null,
    clusterId: (r.clusterId as number | null) ?? null,
    name: (r.name as string | null) ?? null,
    createdAt: r.createdAt as number,
  };
}
