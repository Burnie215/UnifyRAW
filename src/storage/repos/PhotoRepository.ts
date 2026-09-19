import type { Database, Statement } from 'sql.js';
import type { CatalogStorage } from '../CatalogStorage';
import type { RevisionTable } from './types';
import { reserveLocalSeqs } from '../sqljs-init';
import type { PhotoColorLabel, PhotoFlag, PhotoRow, PhotoView } from './types';

export interface PhotoListOpts {
  sourceId?: string;
  contentHash?: string;
  stackId?: string;
  /** Only photos with stackPosition=0 or NULL (stack-collapsed view). */
  collapseStacks?: boolean;
  /**
   * Also return rows the user removed from the catalog (`deletedAt` set).
   * Only `listRaw` honours it: `list` feeds the library and must not show them.
   */
  includeDeleted?: boolean;
  /** ORDER BY clause shorthand. */
  orderBy?: 'dateTaken' | 'indexedAt' | 'name';
  order?: 'ASC' | 'DESC';
  limit?: number;
  offset?: number;
}

const COLUMNS = `id, sourceId, sourcePhotoId, contentHash, name, mimeType, sizeBytes,
  dateTaken, dateModified, sourcePath, availability, sourceRevision, indexedAt, updatedAt, deletedAt,
  width, height, sourceBits, camera, lens, iso, focalLength, aperture, shutterSpeed,
  latitude, longitude, blurHash, stackId, stackPosition`;

const VIEW_SELECT = `SELECT p.id, p.sourceId, p.sourcePhotoId, p.contentHash, p.name, p.mimeType, p.sizeBytes,
  p.dateTaken, p.dateModified, p.sourcePath, p.availability, p.sourceRevision, p.indexedAt, p.updatedAt, p.deletedAt,
  p.width, p.height, p.sourceBits, p.camera, p.lens, p.iso, p.focalLength, p.aperture, p.shutterSpeed,
  p.latitude, p.longitude, p.blurHash, p.stackId, p.stackPosition,
  m.rating AS m_rating, m.flag AS m_flag, m.colorLabel AS m_colorLabel, m.keywords AS m_keywords
  FROM photos p LEFT JOIN photoMeta m ON p.contentHash = m.contentHash AND (m.deletedAt IS NULL)`;

const LISTING_CHANGED = `photos.name IS NOT excluded.name
      OR photos.mimeType IS NOT excluded.mimeType
      OR photos.sizeBytes IS NOT excluded.sizeBytes
      OR photos.dateTaken IS NOT excluded.dateTaken
      OR photos.dateModified IS NOT excluded.dateModified
      OR photos.sourcePath IS NOT excluded.sourcePath
      OR photos.availability IS NOT excluded.availability
      OR photos.sourceRevision IS NOT excluded.sourceRevision
      OR photos.contentHash IS NOT COALESCE(excluded.contentHash, photos.contentHash)
      OR photos.width IS NOT COALESCE(excluded.width, photos.width)
      OR photos.height IS NOT COALESCE(excluded.height, photos.height)
      OR photos.sourceBits IS NOT COALESCE(excluded.sourceBits, photos.sourceBits)`;

// deletedAt is left alone on conflict: whether a listing may bring back a
// soft-deleted photo is a separate decision. updatedAt only moves when a field
// really changed, because photos are synced and a rescan of an unchanged
// library would otherwise push every row again. Hash and dimensions are only
// filled in, never erased by a listing that does not know them.
//
// localSeq comes from bulkAdd, not from the triggers: one trigger run per row
// made a listing of 10k photos 30 % slower and a changed rescan twice as slow
// (measured 2026-09-11). A row takes its number only when the listing changed it.
const UPSERT_PHOTO = `INSERT INTO photos (
    sourceId, sourcePhotoId, contentHash, name, mimeType, sizeBytes,
    dateTaken, dateModified, sourcePath, availability, sourceRevision, indexedAt, updatedAt, deletedAt,
    width, height, sourceBits, camera, lens, iso, focalLength, aperture, shutterSpeed,
    latitude, longitude, blurHash, stackId, stackPosition, localSeq
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(sourceId, sourcePhotoId) DO UPDATE SET
    name = excluded.name,
    mimeType = excluded.mimeType,
    sizeBytes = excluded.sizeBytes,
    dateTaken = excluded.dateTaken,
    dateModified = excluded.dateModified,
    sourcePath = excluded.sourcePath,
    availability = excluded.availability,
    sourceRevision = excluded.sourceRevision,
    contentHash = COALESCE(excluded.contentHash, photos.contentHash),
    width = COALESCE(excluded.width, photos.width),
    height = COALESCE(excluded.height, photos.height),
    sourceBits = COALESCE(excluded.sourceBits, photos.sourceBits),
    updatedAt = CASE WHEN ${LISTING_CHANGED} THEN excluded.updatedAt ELSE photos.updatedAt END,
    localSeq = CASE WHEN ${LISTING_CHANGED} THEN excluded.localSeq ELSE photos.localSeq END
  RETURNING id`;

const PHOTO_UPDATE_COLUMNS: ReadonlySet<string> = new Set([
  'sourceId', 'sourcePhotoId', 'contentHash', 'name', 'mimeType', 'sizeBytes',
  'dateTaken', 'dateModified', 'sourcePath', 'availability', 'sourceRevision',
  'indexedAt', 'deletedAt', 'width', 'height', 'sourceBits', 'camera', 'lens', 'iso',
  'focalLength', 'aperture', 'shutterSpeed', 'latitude', 'longitude',
  'blurHash', 'stackId', 'stackPosition',
] satisfies Array<Exclude<keyof PhotoRow, 'id' | 'updatedAt'>>);

function compilePhotoPatch(patch: Partial<Omit<PhotoRow, 'id'>>): {
  fields: string[];
  params: Array<string | number | null>;
} {
  const fields: string[] = [];
  const params: Array<string | number | null> = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!PHOTO_UPDATE_COLUMNS.has(key)) {
      throw new Error(`Unsupported photo update column: ${key}`);
    }
    fields.push(`${key} = ?`);
    params.push(value as string | number | null);
  }
  return { fields, params };
}

export class PhotoRepository {
  private readonly db: Database;
  private readonly storage: CatalogStorage;
  private readonly onWrite: () => void;

  constructor(storage: CatalogStorage, onWrite: (table: RevisionTable) => void) {
    this.storage = storage;
    this.db = storage.db;
    this.onWrite = () => onWrite('photos');
  }

  list(opts: PhotoListOpts = {}): PhotoView[] {
    const where: string[] = ['p.deletedAt IS NULL'];
    const params: (string | number)[] = [];
    if (opts.sourceId) { where.push('p.sourceId = ?'); params.push(opts.sourceId); }
    if (opts.contentHash) { where.push('p.contentHash = ?'); params.push(opts.contentHash); }
    if (opts.stackId) { where.push('p.stackId = ?'); params.push(opts.stackId); }
    if (opts.collapseStacks) where.push('(p.stackId IS NULL OR p.stackPosition = 0)');
    const orderCol = opts.orderBy ?? 'dateTaken';
    const dir = opts.order ?? 'DESC';
    let sql = `${VIEW_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.${orderCol} ${dir}`;
    if (opts.limit) { sql += ` LIMIT ${Number(opts.limit)}`; }
    if (opts.offset) { sql += ` OFFSET ${Number(opts.offset)}`; }

    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);
    const out: PhotoView[] = [];
    while (stmt.step()) out.push(parsePhotoView(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  /** Return only the photos table row (no meta join). Internal use. */
  listRaw(opts: PhotoListOpts = {}): PhotoRow[] {
    const where: string[] = opts.includeDeleted ? [] : ['deletedAt IS NULL'];
    const params: (string | number)[] = [];
    if (opts.sourceId) { where.push('sourceId = ?'); params.push(opts.sourceId); }
    if (opts.contentHash) { where.push('contentHash = ?'); params.push(opts.contentHash); }
    if (opts.stackId) { where.push('stackId = ?'); params.push(opts.stackId); }
    const orderCol = opts.orderBy ?? 'dateTaken';
    const dir = opts.order ?? 'DESC';
    const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    let sql = `SELECT ${COLUMNS} FROM photos ${filter} ORDER BY ${orderCol} ${dir}`;
    if (opts.limit) { sql += ` LIMIT ${Number(opts.limit)}`; }
    if (opts.offset) { sql += ` OFFSET ${Number(opts.offset)}`; }
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);
    const out: PhotoRow[] = [];
    while (stmt.step()) out.push(parsePhoto(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  getById(id: number): PhotoView | null {
    const stmt = this.db.prepare(`${VIEW_SELECT} WHERE p.id = ?`);
    stmt.bind([id]);
    const row = stmt.step() ? parsePhotoView(stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    return row;
  }

  bulkGet(ids: number[]): PhotoView[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`${VIEW_SELECT} WHERE p.id IN (${placeholders})`);
    stmt.bind(ids);
    const out: PhotoView[] = [];
    while (stmt.step()) out.push(parsePhotoView(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  findBySource(sourceId: string, sourcePhotoId: string): PhotoView | null {
    const stmt = this.db.prepare(`${VIEW_SELECT} WHERE p.sourceId = ? AND p.sourcePhotoId = ?`);
    stmt.bind([sourceId, sourcePhotoId]);
    const row = stmt.step() ? parsePhotoView(stmt.getAsObject() as Record<string, unknown>) : null;
    stmt.free();
    return row;
  }

  getByContentHash(hash: string): PhotoView[] {
    const stmt = this.db.prepare(`${VIEW_SELECT} WHERE p.contentHash = ?`);
    stmt.bind([hash]);
    const out: PhotoView[] = [];
    while (stmt.step()) out.push(parsePhotoView(stmt.getAsObject() as Record<string, unknown>));
    stmt.free();
    return out;
  }

  add(p: Omit<PhotoRow, 'id' | 'updatedAt' | 'deletedAt'> & Partial<Pick<PhotoRow, 'updatedAt' | 'deletedAt'>>): number {
    const now = p.updatedAt ?? Date.now();
    this.db.run(
      `INSERT INTO photos (
         sourceId, sourcePhotoId, contentHash, name, mimeType, sizeBytes,
         dateTaken, dateModified, sourcePath, availability, sourceRevision, indexedAt, updatedAt, deletedAt,
         width, height, sourceBits, camera, lens, iso, focalLength, aperture, shutterSpeed,
         latitude, longitude, blurHash, stackId, stackPosition
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.sourceId, p.sourcePhotoId, p.contentHash, p.name, p.mimeType, p.sizeBytes,
        p.dateTaken, p.dateModified, p.sourcePath, p.availability, p.sourceRevision,
        p.indexedAt, now, p.deletedAt ?? null,
        p.width, p.height, p.sourceBits, p.camera, p.lens, p.iso, p.focalLength, p.aperture, p.shutterSpeed,
        p.latitude, p.longitude, p.blurHash, p.stackId, p.stackPosition,
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

  /**
   * Insert listed photos; a photo the catalog already holds under the same
   * (sourceId, sourcePhotoId) gets its listing fields refreshed instead and
   * keeps its id.
   *
   * Two listings of one source can overlap (a rescan running into the
   * periodic sync), and each decides "new" from its own snapshot. A plain
   * INSERT then died on the UNIQUE constraint and rolled the whole batch back.
   */
  bulkAdd(photos: Array<Omit<PhotoRow, 'id' | 'updatedAt' | 'deletedAt'> & Partial<Pick<PhotoRow, 'updatedAt' | 'deletedAt'>>>): number[] {
    if (photos.length === 0) return [];
    const ids: number[] = [];
    this.db.run('BEGIN');
    const stmt = this.db.prepare(UPSERT_PHOTO);
    try {
      const firstSeq = reserveLocalSeqs(this.db, photos.length);
      photos.forEach((p, index) => ids.push(this._addNoFlush(stmt, p, firstSeq + index)));
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    } finally {
      stmt.free();
    }
    this.storage.flush();
    this.onWrite();
    return ids;
  }

  private _addNoFlush(
    stmt: Statement,
    p: Omit<PhotoRow, 'id' | 'updatedAt' | 'deletedAt'> & Partial<Pick<PhotoRow, 'updatedAt' | 'deletedAt'>>,
    localSeq: number,
  ): number {
    const now = p.updatedAt ?? Date.now();
    stmt.bind([
      p.sourceId, p.sourcePhotoId, p.contentHash, p.name, p.mimeType, p.sizeBytes,
      p.dateTaken, p.dateModified, p.sourcePath, p.availability, p.sourceRevision,
      p.indexedAt, now, p.deletedAt ?? null,
      p.width, p.height, p.sourceBits, p.camera, p.lens, p.iso, p.focalLength, p.aperture, p.shutterSpeed,
      p.latitude, p.longitude, p.blurHash, p.stackId, p.stackPosition, localSeq,
    ]);
    stmt.step();
    const id = (stmt.getAsObject() as { id: number }).id;
    stmt.reset();
    return id;
  }

  update(id: number, patch: Partial<Omit<PhotoRow, 'id'>>): void {
    const { fields, params } = compilePhotoPatch(patch);
    if (fields.length === 0) return;
    fields.push('updatedAt = ?');
    params.push(Date.now(), id);
    this.db.run(`UPDATE photos SET ${fields.join(', ')} WHERE id = ?`, params);
    this.storage.flush();
    this.onWrite();
  }

  bulkUpdate(updates: Array<{ id: number; patch: Partial<Omit<PhotoRow, 'id'>> }>): void {
    if (updates.length === 0) return;
    this.db.run('BEGIN');
    try {
      const now = Date.now();
      for (const u of updates) {
        const { fields, params } = compilePhotoPatch(u.patch);
        if (fields.length === 0) continue;
        fields.push('updatedAt = ?');
        params.push(now, u.id);
        this.db.run(`UPDATE photos SET ${fields.join(', ')} WHERE id = ?`, params);
      }
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    this.storage.flush();
    this.onWrite();
  }

  delete(id: number): void {
    this.db.run('DELETE FROM photos WHERE id = ?', [id]);
    this.storage.flush();
    this.onWrite();
  }

  bulkDelete(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.run(`DELETE FROM photos WHERE id IN (${placeholders})`, ids);
    this.storage.flush();
    this.onWrite();
  }

  bulkSoftDelete(ids: number[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');
    this.db.run(
      `UPDATE photos SET deletedAt = ?, updatedAt = ? WHERE id IN (${placeholders})`,
      [now, now, ...ids],
    );
    this.storage.flush();
    this.onWrite();
  }

  /**
   * Take back a soft delete. The row keeps its id, so every reference to it -
   * collection membership above all - survives the round trip.
   */
  bulkRestore(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.run(
      `UPDATE photos SET deletedAt = NULL, updatedAt = ? WHERE id IN (${placeholders})`,
      [Date.now(), ...ids],
    );
    this.storage.flush();
    this.onWrite();
  }

  count(filter?: { sourceId?: string }): number {
    let sql = 'SELECT COUNT(*) AS c FROM photos WHERE deletedAt IS NULL';
    const params: (string | number)[] = [];
    if (filter?.sourceId) { sql += ' AND sourceId = ?'; params.push(filter.sourceId); }
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);
    stmt.step();
    const n = (stmt.getAsObject() as { c: number }).c;
    stmt.free();
    return n;
  }
}

function parsePhotoView(r: Record<string, unknown>): PhotoView {
  const base = parsePhoto(r);
  return {
    ...base,
    rating: (r.m_rating as number | null) ?? null,
    flag: ((r.m_flag as string | null) ?? null) as PhotoFlag,
    colorLabel: ((r.m_colorLabel as string | null) ?? null) as PhotoColorLabel,
    keywords: r.m_keywords ? JSON.parse(r.m_keywords as string) as string[] : [],
  };
}

function parsePhoto(r: Record<string, unknown>): PhotoRow {
  return {
    id: r.id as number,
    sourceId: r.sourceId as string,
    sourcePhotoId: r.sourcePhotoId as string,
    contentHash: (r.contentHash as string | null) ?? null,
    name: r.name as string,
    mimeType: (r.mimeType as string | null) ?? null,
    sizeBytes: (r.sizeBytes as number | null) ?? null,
    dateTaken: (r.dateTaken as number | null) ?? null,
    dateModified: (r.dateModified as number | null) ?? null,
    sourcePath: (r.sourcePath as string | null) ?? null,
    availability: ((r.availability as PhotoRow['availability'] | null) ?? 'online'),
    sourceRevision: (r.sourceRevision as number | null) ?? 0,
    indexedAt: r.indexedAt as number,
    updatedAt: r.updatedAt as number,
    deletedAt: (r.deletedAt as number | null) ?? null,
    width: (r.width as number | null) ?? null,
    height: (r.height as number | null) ?? null,
    sourceBits: (r.sourceBits as number | null) ?? null,
    camera: (r.camera as string | null) ?? null,
    lens: (r.lens as string | null) ?? null,
    iso: (r.iso as number | null) ?? null,
    focalLength: (r.focalLength as number | null) ?? null,
    aperture: (r.aperture as number | null) ?? null,
    shutterSpeed: (r.shutterSpeed as string | null) ?? null,
    latitude: (r.latitude as number | null) ?? null,
    longitude: (r.longitude as number | null) ?? null,
    blurHash: (r.blurHash as string | null) ?? null,
    stackId: (r.stackId as string | null) ?? null,
    stackPosition: (r.stackPosition as number | null) ?? null,
  };
}
