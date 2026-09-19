import type { Database } from 'sql.js';
import type { CatalogStorage } from './CatalogStorage';
import {
  mergeSourceConfigFromSync,
  redactSourceConfigForSync,
  SYNC_LIMITS,
  SYNC_TABLES,
  type SyncPushResponse,
  type SyncTableName,
} from '@photolib/shared';
import type { Adjustments } from '../types';
import type { PhotoDocument } from '../engine/DocumentModel';
import { markAllForPush } from './sqljs-init';
import { jsonBytes, splitPushBatches } from './syncBatches';

export interface SyncSettings {
  serverUrl: string;
  token?: string;
}

export interface PulledEdit {
  contentHash: string;
  adjustments: Adjustments;
  document: PhotoDocument | null;
}

export interface SyncedStorageCallbacks {
  onAfterPull?: (merged: Partial<Record<SyncTableName, number>>) => void;
  /** Fired for each freshly-merged (non-deleted) edits row pulled from the
   *  server. Lets the consumer trigger a background thumbnail render so
   *  the library tile on the receiving device shows the edit without the
   *  user having to open the editor. */
  onEditPulled?: (edit: PulledEdit) => void;
  /** The hub refused this device's token (revoked on another device, or
   *  expired). The session is over: the consumer drops the stored token and
   *  asks the user to sign in again. */
  onUnauthorized?: () => void;
}

export interface SyncCycleError {
  phase: 'pull' | 'push';
  table: SyncTableName;
  error: string;
  /** Set when one row was left out (row-too-large, invalid); the rest of the table went through. */
  key?: string;
  code?: string;
}

export interface SyncCycleResult {
  pulled: Partial<Record<SyncTableName, number>>;
  pushed: Partial<Record<SyncTableName, number>>;
  errors: SyncCycleError[];
  startedAt: number;
  finishedAt: number;
}

type Row = Record<string, unknown>;

interface PushRow {
  index: number;
  seq: number;
  wire: Row;
}

/** Wire fields that identify a row, joined with '/' the way the hub reports a refused row. */
const ROW_IDENTITY: Record<SyncTableName, readonly string[]> = {
  sources: ['id'],
  photos: ['sourceId', 'sourcePhotoId'],
  photoMeta: ['contentHash'],
  edits: ['contentHash', 'copyIndex'],
  presets: ['syncId'],
  developProfiles: ['syncId'],
  lensProfiles: ['syncId'],
  collections: ['syncId'],
  exports: ['syncId'],
};

const WATERMARK_KEY = { pull: 'pullRev', push: 'pushSeq' } as const;

/**
 * The hub answered 401 to a request this device sent with a token: it is
 * revoked or expired, so the session is over and the rest of the cycle is
 * pointless. Only /api/sync answers become this error — a 401 from a source
 * provider or from the backend proxy never travels through here.
 */
class SyncUnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncUnauthorizedError';
  }
}

/**
 * SyncedStorage wraps any CatalogStorage and adds two-way LWW sync against a
 * Sync-Hub backend. Pull pages over the hub's revision (sync.<table>.pullRev),
 * push sends the rows written here since the last push in localSeq order
 * (sync.<table>.pushSeq); updatedAt only decides conflicts. Both watermarks
 * live in schema_meta, so they travel with the catalog file.
 *
 * No worker thread, no polling — callers invoke sync() on the cadence that
 * fits them (e.g. on user action + once per minute).
 */
export class SyncedStorage {
  private readonly storage: CatalogStorage;
  private settings: SyncSettings;
  private inflight: Promise<SyncCycleResult> | null = null;
  private readonly callbacks: SyncedStorageCallbacks;

  constructor(storage: CatalogStorage, settings: SyncSettings, callbacks?: SyncedStorageCallbacks) {
    this.storage = storage;
    this.settings = settings;
    this.callbacks = callbacks ?? {};
  }

  get db(): Database { return this.storage.db; }

  /** Run one full pull+push cycle across all sync tables. Concurrent calls coalesce. */
  async sync(): Promise<SyncCycleResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runCycle().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /**
   * Mark every row of the catalog as written here and run a cycle, so the
   * whole catalog goes to the hub again; the hub keeps whichever copy is
   * newer. Repairs rows an older client never pushed because its push cursor
   * followed updatedAt (F006).
   */
  async resendAll(): Promise<SyncCycleResult> {
    await this.inflight?.catch(() => undefined);
    markAllForPush(this.db);
    return this.sync();
  }

  private async runCycle(): Promise<SyncCycleResult> {
    const startedAt = Date.now();
    const pulled: Partial<Record<SyncTableName, number>> = {};
    const pushed: Partial<Record<SyncTableName, number>> = {};
    const errors: SyncCycleError[] = [];

    // Pull first (server -> local), then push (local -> server). A
    // freshly-empty local DB pulls the full server state before pushing
    // nothing back.
    let sessionOver = false;
    for (const table of SYNC_TABLES) {
      try { await this.pullTable(table, pulled, errors); }
      catch (e) {
        errors.push(cycleError('pull', table, e));
        if (e instanceof SyncUnauthorizedError) { sessionOver = true; break; }
      }
    }
    if (!sessionOver) {
      for (const table of SYNC_TABLES) {
        try { await this.pushTable(table, pushed, errors); }
        catch (e) {
          errors.push(cycleError('push', table, e));
          if (e instanceof SyncUnauthorizedError) { sessionOver = true; break; }
        }
      }
    }

    this.storage.flush();
    // Fire post-pull callback so the consumer (StorageContext) can bump
    // the React revision counter + reconnect newly-pulled sources.
    const pulledAnything = Object.values(pulled).some((n) => (n ?? 0) > 0);
    if (pulledAnything) this.callbacks.onAfterPull?.(pulled);
    if (sessionOver) this.callbacks.onUnauthorized?.();
    return { pulled, pushed, errors, startedAt, finishedAt: Date.now() };
  }

  // ───────────────────────────────────────────────────────────────────
  // Pull
  // ───────────────────────────────────────────────────────────────────

  /** Pull page after page; each page and its watermark land together, so an abort resumes at the last page. */
  private async pullTable(
    table: SyncTableName,
    pulled: Partial<Record<SyncTableName, number>>,
    errors: SyncCycleError[],
  ): Promise<void> {
    const key = urlFor(table);
    // Collection references are resolved once all pages are in: a parent can
    // arrive on a later page than its child. Only the rows the merge applied
    // go in — where the local row won LWW it keeps its own parent and photos.
    const mergedCollections: Row[] = [];
    pulled[table] = 0;
    try {
      for (;;) {
        const afterRevision = this.getWatermark(table, 'pull');
        const url = `${this.settings.serverUrl}/api/sync/${key}?afterRevision=${afterRevision}&limit=${SYNC_LIMITS.pullPageRows}`;
        const res = await fetch(url, { headers: this.authHeaders() });
        if (!res.ok) throw this.httpError(table, 'pull', res.status);
        const body = await res.json() as Row;
        const rows = Array.isArray(body[key]) ? body[key] as Row[] : [];
        // A hub from before revisions answers with every row and no cursor.
        const nextRevision = Number.isSafeInteger(body.nextRevision) ? Number(body.nextRevision) : null;
        const merged = this.mergePage(table, rows, nextRevision, errors);
        pulled[table] = (pulled[table] ?? 0) + merged.length;
        if (table === 'collections') mergedCollections.push(...merged);
        if (nextRevision === null || body.hasMore !== true) return;
        if (nextRevision <= afterRevision) throw new Error(`${table} pull made no progress after revision ${afterRevision}`);
      }
    } finally {
      if (mergedCollections.length > 0) reconcileCollectionReferences(this.db, mergedCollections);
    }
  }

  /**
   * Merge one page and return the rows it applied — the ones that won LWW. A
   * row this catalog refuses (a NOT NULL column the hub left empty) is reported
   * and passed over: letting it throw would roll the page and its watermark
   * back, and the table would never get past that revision again.
   */
  private mergePage(
    table: SyncTableName,
    rows: Row[],
    nextRevision: number | null,
    errors: SyncCycleError[],
  ): Row[] {
    const pulledEdits: PulledEdit[] = [];
    const applied: Row[] = [];
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        try {
          if (!mergeRemoteRow(this.db, table, row)) continue;
        } catch {
          errors.push(skippedRow('pull', table, rowKey(table, row), 'invalid'));
          continue;
        }
        applied.push(row);
        if (table === 'edits' && typeof row.contentHash === 'string' && row.deletedAt == null) {
          pulledEdits.push({
            contentHash: row.contentHash,
            adjustments: row.adjustments as Adjustments,
            document: (row.document ?? null) as PhotoDocument | null,
          });
        }
      }
      if (nextRevision !== null) this.setWatermark(table, 'pull', nextRevision);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (this.callbacks.onEditPulled) {
      for (const edit of pulledEdits) {
        try { this.callbacks.onEditPulled(edit); } catch { /* consumer-side issues must not break sync */ }
      }
    }
    return applied;
  }

  // ───────────────────────────────────────────────────────────────────
  // Push
  // ───────────────────────────────────────────────────────────────────

  /**
   * Send the rows written here since the last push, in localSeq order, in
   * byte-bounded batches. A 413 halves the batch size for the rest of the
   * table; a row the hub refuses even alone, or one above SYNC_LIMITS.rowBytes,
   * is reported and passed over, and goes out again with its next local write.
   * The watermark follows every batch, so a failure resends only what was lost.
   */
  private async pushTable(
    table: SyncTableName,
    pushed: Partial<Record<SyncTableName, number>>,
    errors: SyncCycleError[],
  ): Promise<void> {
    pushed[table] = 0;
    const rows: PushRow[] = selectLocalSince(this.db, table, this.getWatermark(table, 'push'))
      .map(({ localSeq, ...wire }, index) => ({ index, seq: Number(localSeq), wire }));
    if (rows.length === 0) return;

    const key = urlFor(table);
    const url = `${this.settings.serverUrl}/api/sync/${key}`;
    const envelopeBytes = jsonBytes({ [key]: [] }) - jsonBytes([]);
    const { batches, oversized } = splitPushBatches(rows, {
      maxBytes: SYNC_LIMITS.pushBatchBytes - envelopeBytes,
      maxRows: SYNC_LIMITS.pushBatchRows,
      rowBytesLimit: SYNC_LIMITS.rowBytes,
    }, (row) => jsonBytes(row.wire));

    const settled = new Set<number>();
    let settledPrefix = 0;
    const settle = (batch: PushRow[]) => {
      for (const row of batch) settled.add(row.index);
      const before = settledPrefix;
      while (settledPrefix < rows.length && settled.has(settledPrefix)) settledPrefix++;
      if (settledPrefix > before) this.setWatermark(table, 'push', rows[settledPrefix - 1].seq);
    };

    for (const row of oversized) errors.push(skippedRow('push', table, rowKey(table, row.wire), 'row-too-large'));
    settle(oversized);

    let rowCap: number = SYNC_LIMITS.pushBatchRows;
    const queue = [...batches];
    while (queue.length > 0) {
      let batch = queue.shift()!;
      if (batch.length > rowCap) {
        queue.unshift(batch.slice(rowCap));
        batch = batch.slice(0, rowCap);
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ [key]: batch.map((row) => row.wire) }),
      });
      if (res.status === 413) {
        if (batch.length === 1) {
          errors.push(skippedRow('push', table, rowKey(table, batch[0].wire), 'row-too-large'));
          settle(batch);
        } else {
          rowCap = Math.ceil(batch.length / 2);
          queue.unshift(batch);
        }
        continue;
      }
      if (!res.ok) throw this.httpError(table, 'push', res.status);
      const refused = refusedRows(await res.json().catch(() => null));
      for (const { key: refusedKey, code } of refused) errors.push(skippedRow('push', table, refusedKey, code));
      pushed[table] = (pushed[table] ?? 0) + batch.length - refused.length;
      settle(batch);
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────

  private authHeaders(): Record<string, string> {
    return this.settings.token ? { Authorization: `Bearer ${this.settings.token}` } : {};
  }

  /** A refused hub answer. 401 on a request that carried a token ends the session. */
  private httpError(table: SyncTableName, phase: 'pull' | 'push', status: number): Error {
    const message = `${table} ${phase} HTTP ${status}`;
    return status === 401 && this.settings.token ? new SyncUnauthorizedError(message) : new Error(message);
  }

  private getWatermark(table: SyncTableName, dir: 'pull' | 'push'): number {
    const stmt = this.db.prepare('SELECT value FROM schema_meta WHERE key = ?');
    stmt.bind([`sync.${table}.${WATERMARK_KEY[dir]}`]);
    const found = stmt.step();
    const value = found ? Number(stmt.getAsObject().value) : 0;
    stmt.free();
    return Number.isFinite(value) ? value : 0;
  }

  private setWatermark(table: SyncTableName, dir: 'pull' | 'push', value: number): void {
    this.db.run(
      'INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)',
      [`sync.${table}.${WATERMARK_KEY[dir]}`, String(value)],
    );
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function cycleError(phase: 'pull' | 'push', table: SyncTableName, e: unknown): SyncCycleError {
  const error = errMsg(e);
  return e instanceof SyncUnauthorizedError
    ? { phase, table, error, code: 'unauthorized' }
    : { phase, table, error };
}

/** Map a table name to its /api/sync/<segment> URL piece (and JSON key). */
function urlFor(table: SyncTableName): string {
  if (table === 'photoMeta') return 'meta';
  return table;
}

function rowKey(table: SyncTableName, row: Row): string {
  return ROW_IDENTITY[table].map((column) => String(row[column] ?? '')).join('/');
}

function skippedRow(phase: 'pull' | 'push', table: SyncTableName, key: string, code: string): SyncCycleError {
  const error = code === 'row-too-large' ? `row too large: ${key}` : `${code} row: ${key}`;
  return { phase, table, error, key, code };
}

function refusedRows(body: unknown): Array<{ key: string; code: string }> {
  const errors = (body as Partial<SyncPushResponse> | null)?.errors;
  if (!Array.isArray(errors)) return [];
  return errors.filter((entry) => typeof entry?.key === 'string' && typeof entry.code === 'string');
}

// ───────────────────────────────────────────────────────────────────────
// Local SELECT (push)
// ───────────────────────────────────────────────────────────────────────

/** Rows written locally after `sinceSeq`, in localSeq order, as wire rows plus their `localSeq`. */
export function selectLocalSince(db: Database, table: SyncTableName, sinceSeq: number): Row[] {
  switch (table) {
    case 'sources': return queryRows(db,
      `SELECT id, type, label, config, addedAt, updatedAt, deletedAt, localSeq
       FROM sources WHERE localSeq > ? ORDER BY localSeq`, [sinceSeq],
      (r) => ({ ...r, config: redactSourceConfigForSync(r.config) }));
    // `sourceBits` is deliberately absent: every device that can read the
    // original measures it for itself, and a device that has not probed yet
    // would push a null that LWW writes over another device's measurement.
    case 'photos': return queryRows(db,
      `SELECT sourceId, sourcePhotoId, contentHash, name, mimeType, sizeBytes,
              dateTaken, dateModified, sourcePath, availability, sourceRevision,
              indexedAt, updatedAt, deletedAt,
              width, height, camera, lens, iso, focalLength, aperture, shutterSpeed,
              latitude, longitude, blurHash, stackId, stackPosition, localSeq
       FROM photos WHERE localSeq > ? ORDER BY localSeq`, [sinceSeq]);
    case 'photoMeta': return queryRows(db,
      `SELECT contentHash, rating, flag, colorLabel, keywords, updatedAt, deletedAt, localSeq
       FROM photoMeta WHERE localSeq > ? ORDER BY localSeq`, [sinceSeq],
      (r) => ({ ...r, keywords: r.keywords ? safeParse(r.keywords) : [] }));
    // `documentHistory` is deliberately absent: the undo stack is device state
    // and never leaves this device (up to 50 documents per row, a megabyte for
    // a graph-led photo). The local column keeps its full depth.
    case 'edits': return queryRows(db,
      `SELECT contentHash, copyIndex, copyName, adjustments, document, history,
              createdAt, updatedAt, deletedAt, localSeq
       FROM edits WHERE localSeq > ? ORDER BY localSeq`, [sinceSeq],
      (r) => ({
        ...r,
        adjustments: r.adjustments ? safeParse(r.adjustments) : null,
        document: r.document ? safeParse(r.document) : null,
        history: r.history ? safeParse(r.history) : [],
      }));
    case 'presets': return queryRows(db,
      `SELECT syncId, name, adjustments, category, createdAt, updatedAt, deletedAt, localSeq
       FROM presets WHERE localSeq > ? ORDER BY localSeq`, [sinceSeq],
      (r) => ({ ...r, adjustments: r.adjustments ? safeParse(r.adjustments) : {} }));
    case 'developProfiles': return queryRows(db,
      `SELECT syncId, name, scope, key, isoFrom, isoTo, adjustments, createdAt, updatedAt, deletedAt, localSeq
       FROM developProfiles WHERE localSeq > ? ORDER BY localSeq`, [sinceSeq],
      (r) => ({ ...r, adjustments: r.adjustments ? safeParse(r.adjustments) : {} }));
    case 'lensProfiles': return queryRows(db,
      `SELECT syncId, name, key, focalFrom, focalTo, coefficients, createdAt, updatedAt, deletedAt, localSeq
       FROM lensProfiles WHERE localSeq > ? ORDER BY localSeq`, [sinceSeq],
      (r) => ({ ...r, coefficients: r.coefficients ? safeParse(r.coefficients) : {} }));
    case 'collections': return queryRows(db,
      `SELECT syncId, name, type, parentId, rules, photoIds, createdAt, updatedAt, deletedAt, localSeq
       FROM collections WHERE localSeq > ? ORDER BY localSeq`, [sinceSeq],
      (r) => collectionToWire(db, r));
    // The ledger of what has left the app for a source, so the other device
    // stops asking to export a photo this one already exported. `id` stays
    // behind: it is this catalog's row number, and `syncId` carries the
    // identity the hub and every device agree on.
    case 'exports': return queryRows(db,
      `SELECT syncId, contentHash, copyIndex, targetSourceId, targetAssetId, targetUrl,
              format, editStackHash, filename, bytes, status, uploadedAt, updatedAt, deletedAt, localSeq
       FROM exports WHERE localSeq > ? ORDER BY localSeq`, [sinceSeq]);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Remote → local merge (pull)
// ───────────────────────────────────────────────────────────────────────

// A pull has to change localSeq, or the update trigger takes it for a local
// write and pushes the row straight back. -1 and -2 alternate so it always
// changes; both stay below every push watermark.
const PULLED_SEQ = -1;
const PULLED_SEQ_ON_UPDATE = 'CASE localSeq WHEN -1 THEN -2 ELSE -1 END';

/**
 * Apply a server row to the local DB if and only if its updatedAt beats the
 * local row's. Returns true if a write was made. The row is marked as pulled
 * (localSeq < 0), so push never sends it back.
 */
export function mergeRemoteRow(db: Database, table: SyncTableName, row: Row): boolean {
  const remoteAt = Number(row.updatedAt ?? 0);
  if (!remoteAt) return false;

  switch (table) {
    case 'sources': {
      const id = row.id as string | undefined;
      if (!id) return false;
      const local = oneRow(db, 'SELECT updatedAt, config FROM sources WHERE id = ?', [id]);
      if (local && Number(local.updatedAt) >= remoteAt) return false;
      db.run(
        `INSERT INTO sources (id, type, label, config, addedAt, updatedAt, deletedAt, localSeq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${PULLED_SEQ})
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type, label = excluded.label, config = excluded.config,
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt,
           localSeq = ${PULLED_SEQ_ON_UPDATE}`,
        [
          id,
          (row.type as string) ?? 'unknown',
          (row.label as string) ?? id,
          JSON.stringify(mergeSourceConfigFromSync(row.config, local?.config)),
          Number(row.addedAt ?? remoteAt),
          remoteAt,
          row.deletedAt != null ? Number(row.deletedAt) : null,
        ],
      );
      return true;
    }
    case 'photos': {
      const sourceId = row.sourceId as string | undefined;
      const sourcePhotoId = row.sourcePhotoId as string | undefined;
      if (!sourceId || !sourcePhotoId) return false;
      const local = oneRow(db,
        'SELECT id, updatedAt FROM photos WHERE sourceId = ? AND sourcePhotoId = ?',
        [sourceId, sourcePhotoId]);
      if (local && Number(local.updatedAt) >= remoteAt) return false;

      const baseParams: SqlParam[] = [
        sql(row.contentHash), sql(row.name), sql(row.mimeType), sql(row.sizeBytes),
        sql(row.dateTaken), sql(row.dateModified), sql(row.sourcePath),
        sql(row.availability ?? 'online'), sql(row.sourceRevision ?? 0),
        sql(row.indexedAt ?? remoteAt),
        remoteAt, row.deletedAt != null ? Number(row.deletedAt) : null,
        sql(row.width), sql(row.height), sql(row.camera), sql(row.lens), sql(row.iso),
        sql(row.focalLength), sql(row.aperture), sql(row.shutterSpeed),
        sql(row.latitude), sql(row.longitude),
        sql(row.blurHash), sql(row.stackId), sql(row.stackPosition),
      ];
      if (local) {
        db.run(
          `UPDATE photos SET
             contentHash=?, name=?, mimeType=?, sizeBytes=?,
             dateTaken=?, dateModified=?, sourcePath=?, availability=?, sourceRevision=?, indexedAt=?,
             updatedAt=?, deletedAt=?,
             width=?, height=?, camera=?, lens=?, iso=?,
             focalLength=?, aperture=?, shutterSpeed=?,
             latitude=?, longitude=?,
             blurHash=?, stackId=?, stackPosition=?,
             localSeq=${PULLED_SEQ_ON_UPDATE}
           WHERE id = ?`,
          [...baseParams, local.id as number],
        );
      } else {
        db.run(
          `INSERT INTO photos
             (sourceId, sourcePhotoId, contentHash, name, mimeType, sizeBytes,
              dateTaken, dateModified, sourcePath, availability, sourceRevision,
              indexedAt, updatedAt, deletedAt,
              width, height, camera, lens, iso, focalLength, aperture, shutterSpeed,
              latitude, longitude, blurHash, stackId, stackPosition, localSeq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${PULLED_SEQ})`,
          [sourceId, sourcePhotoId, ...baseParams],
        );
      }
      return true;
    }
    case 'photoMeta': {
      const ch = row.contentHash as string | undefined;
      if (!ch) return false;
      // LWW per-row (not per-field) on the client; the backend already does
      // per-field LWW on push. This is simpler and correct: server-side meta
      // is the source of truth for any single sync exchange.
      const local = oneRow(db, 'SELECT updatedAt FROM photoMeta WHERE contentHash = ?', [ch]);
      if (local && Number(local.updatedAt) >= remoteAt) return false;
      db.run(
        `INSERT INTO photoMeta (contentHash, rating, flag, colorLabel, keywords, updatedAt, deletedAt, localSeq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ${PULLED_SEQ})
         ON CONFLICT(contentHash) DO UPDATE SET
           rating = excluded.rating, flag = excluded.flag, colorLabel = excluded.colorLabel,
           keywords = excluded.keywords, updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt,
           localSeq = ${PULLED_SEQ_ON_UPDATE}`,
        [
          ch,
          sql(row.rating),
          sql(row.flag),
          sql(row.colorLabel),
          row.keywords !== undefined ? JSON.stringify(row.keywords) : null,
          remoteAt,
          row.deletedAt != null ? Number(row.deletedAt) : null,
        ],
      );
      return true;
    }
    case 'edits': {
      const ch = row.contentHash as string | undefined;
      if (!ch) return false;
      const copyIndex = Number(row.copyIndex ?? 0);
      const local = oneRow(db,
        'SELECT updatedAt FROM edits WHERE contentHash = ? AND copyIndex = ?',
        [ch, copyIndex]);
      if (local && Number(local.updatedAt) >= remoteAt) return false;
      // `documentHistory` is left out of both the insert and the update: it is
      // this device's undo stack. A row a remote device wrote must not overwrite
      // it, and an old client that still sends one must not resurrect it.
      db.run(
        `INSERT INTO edits (contentHash, copyIndex, copyName, adjustments, document, history, createdAt, updatedAt, deletedAt, localSeq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${PULLED_SEQ})
         ON CONFLICT(contentHash, copyIndex) DO UPDATE SET
           copyName = excluded.copyName, adjustments = excluded.adjustments,
           document = excluded.document, history = excluded.history,
           updatedAt = excluded.updatedAt, deletedAt = excluded.deletedAt,
           localSeq = ${PULLED_SEQ_ON_UPDATE}`,
        [
          ch, copyIndex,
          sql(row.copyName),
          row.adjustments !== undefined ? JSON.stringify(row.adjustments) : '{}',
          row.document !== undefined ? JSON.stringify(row.document) : null,
          row.history !== undefined ? JSON.stringify(row.history) : '[]',
          Number(row.createdAt ?? remoteAt),
          remoteAt,
          row.deletedAt != null ? Number(row.deletedAt) : null,
        ],
      );
      return true;
    }
    case 'presets': {
      const syncId = row.syncId as string | undefined;
      const name = row.name as string | undefined;
      if (!syncId || !name) return false;
      const category = (row.category as string | null | undefined) ?? null;
      const local = oneRow(db, 'SELECT id, updatedAt FROM presets WHERE syncId = ?', [syncId]);
      if (local && Number(local.updatedAt) >= remoteAt) return false;
      if (local) {
        db.run(
          `UPDATE presets SET name = ?, adjustments = ?, category = ?, updatedAt = ?, deletedAt = ?,
             localSeq = ${PULLED_SEQ_ON_UPDATE}
           WHERE id = ?`,
          [
            name,
            row.adjustments !== undefined ? JSON.stringify(row.adjustments) : '{}',
            category,
            remoteAt,
            row.deletedAt != null ? Number(row.deletedAt) : null,
            local.id as number,
          ],
        );
      } else {
        db.run(
          `INSERT INTO presets (syncId, name, adjustments, category, createdAt, updatedAt, deletedAt, localSeq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ${PULLED_SEQ})`,
          [
            syncId,
            name,
            row.adjustments !== undefined ? JSON.stringify(row.adjustments) : '{}',
            category,
            Number(row.createdAt ?? remoteAt),
            remoteAt,
            row.deletedAt != null ? Number(row.deletedAt) : null,
          ],
        );
      }
      return true;
    }
    case 'developProfiles': {
      const syncId = row.syncId as string | undefined;
      const name = row.name as string | undefined;
      const scope = row.scope as string | undefined;
      const key = row.key as string | undefined;
      if (!syncId || !name || !scope || !key) return false;
      const isoFrom = row.isoFrom != null ? Number(row.isoFrom) : null;
      const isoTo = row.isoTo != null ? Number(row.isoTo) : null;
      const adjustments = row.adjustments !== undefined ? JSON.stringify(row.adjustments) : '{}';
      const local = oneRow(db, 'SELECT id, updatedAt FROM developProfiles WHERE syncId = ?', [syncId]);
      if (local && Number(local.updatedAt) >= remoteAt) return false;
      if (local) {
        db.run(
          `UPDATE developProfiles
             SET name = ?, scope = ?, key = ?, isoFrom = ?, isoTo = ?, adjustments = ?,
                 updatedAt = ?, deletedAt = ?, localSeq = ${PULLED_SEQ_ON_UPDATE}
           WHERE id = ?`,
          [name, scope, key, isoFrom, isoTo, adjustments, remoteAt,
           row.deletedAt != null ? Number(row.deletedAt) : null, local.id as number],
        );
      } else {
        db.run(
          `INSERT INTO developProfiles
             (syncId, name, scope, key, isoFrom, isoTo, adjustments, createdAt, updatedAt, deletedAt, localSeq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${PULLED_SEQ})`,
          [syncId, name, scope, key, isoFrom, isoTo, adjustments,
           Number(row.createdAt ?? remoteAt), remoteAt,
           row.deletedAt != null ? Number(row.deletedAt) : null],
        );
      }
      return true;
    }
    case 'lensProfiles': {
      const syncId = row.syncId as string | undefined;
      const name = row.name as string | undefined;
      const key = row.key as string | undefined;
      if (!syncId || !name || !key) return false;
      const focalFrom = row.focalFrom != null ? Number(row.focalFrom) : null;
      const focalTo = row.focalTo != null ? Number(row.focalTo) : null;
      const coefficients = row.coefficients !== undefined ? JSON.stringify(row.coefficients) : '{}';
      const local = oneRow(db, 'SELECT id, updatedAt FROM lensProfiles WHERE syncId = ?', [syncId]);
      if (local && Number(local.updatedAt) >= remoteAt) return false;
      if (local) {
        db.run(
          `UPDATE lensProfiles
             SET name = ?, key = ?, focalFrom = ?, focalTo = ?, coefficients = ?,
                 updatedAt = ?, deletedAt = ?, localSeq = ${PULLED_SEQ_ON_UPDATE}
           WHERE id = ?`,
          [name, key, focalFrom, focalTo, coefficients, remoteAt,
           row.deletedAt != null ? Number(row.deletedAt) : null, local.id as number],
        );
      } else {
        db.run(
          `INSERT INTO lensProfiles
             (syncId, name, key, focalFrom, focalTo, coefficients, createdAt, updatedAt, deletedAt, localSeq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${PULLED_SEQ})`,
          [syncId, name, key, focalFrom, focalTo, coefficients,
           Number(row.createdAt ?? remoteAt), remoteAt,
           row.deletedAt != null ? Number(row.deletedAt) : null],
        );
      }
      return true;
    }
    case 'collections': {
      const syncId = row.syncId as string | undefined;
      const name = row.name as string | undefined;
      if (!syncId || !name) return false;
      const local = oneRow(db, 'SELECT id, updatedAt FROM collections WHERE syncId = ?', [syncId]);
      if (local && Number(local.updatedAt) >= remoteAt) return false;
      if (local) {
        db.run(
          `UPDATE collections SET name = ?, type = ?, rules = ?, updatedAt = ?, deletedAt = ?,
             localSeq = ${PULLED_SEQ_ON_UPDATE}
           WHERE id = ?`,
          [
            name,
            (row.type as string) ?? 'manual',
            row.rules !== undefined ? JSON.stringify(row.rules) : null,
            remoteAt,
            row.deletedAt != null ? Number(row.deletedAt) : null,
            local.id as number,
          ],
        );
      } else {
        db.run(
          `INSERT INTO collections (syncId, name, type, parentId, rules, photoIds, createdAt, updatedAt, deletedAt, localSeq)
           VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?, ${PULLED_SEQ})`,
          [
            syncId,
            name,
            (row.type as string) ?? 'manual',
            row.rules !== undefined ? JSON.stringify(row.rules) : null,
            Number(row.createdAt ?? remoteAt),
            remoteAt,
            row.deletedAt != null ? Number(row.deletedAt) : null,
          ],
        );
      }
      return true;
    }
    case 'exports': {
      const syncId = row.syncId as string | undefined;
      const contentHash = row.contentHash as string | undefined;
      const targetSourceId = row.targetSourceId as string | undefined;
      if (!syncId || !contentHash || !targetSourceId) return false;
      const local = oneRow(db, 'SELECT id, updatedAt FROM exports WHERE syncId = ?', [syncId]);
      if (local && Number(local.updatedAt) >= remoteAt) return false;
      // The five identity columns are what syncId is made of, so an update
      // rewrites them with the values they already hold; only the outcome of
      // the export itself can change.
      const outcome: SqlParam[] = [
        sql(row.targetAssetId ?? ''), sql(row.targetUrl), sql(row.filename ?? ''),
        Number(row.bytes ?? 0), sql(row.status ?? 'ok'),
        Number(row.uploadedAt ?? remoteAt), remoteAt,
        row.deletedAt != null ? Number(row.deletedAt) : null,
      ];
      if (local) {
        db.run(
          `UPDATE exports
             SET targetAssetId = ?, targetUrl = ?, filename = ?, bytes = ?, status = ?,
                 uploadedAt = ?, updatedAt = ?, deletedAt = ?, localSeq = ${PULLED_SEQ_ON_UPDATE}
           WHERE id = ?`,
          [...outcome, local.id as number],
        );
      } else {
        db.run(
          `INSERT INTO exports
             (syncId, contentHash, copyIndex, targetSourceId, editStackHash, format,
              targetAssetId, targetUrl, filename, bytes, status, uploadedAt, updatedAt, deletedAt, localSeq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${PULLED_SEQ})`,
          [
            syncId, contentHash, Number(row.copyIndex ?? 0), targetSourceId,
            sql(row.editStackHash ?? ''), sql(row.format ?? ''),
            ...outcome,
          ],
        );
      }
      return true;
    }
  }
}

interface StablePhotoRef {
  sourceId: string;
  sourcePhotoId: string;
}

function collectionToWire(
  db: Database,
  row: Row,
): Row {
  let parentSyncId: string | null = null;
  if (row.parentId != null) {
    const parent = oneRow(db, 'SELECT syncId FROM collections WHERE id = ?', [Number(row.parentId)]);
    parentSyncId = typeof parent?.syncId === 'string' ? parent.syncId : null;
  }

  const photoRefs: StablePhotoRef[] = [];
  const photoIds = Array.isArray(safeParse(row.photoIds))
    ? safeParse(row.photoIds) as unknown[]
    : [];
  for (const rawId of photoIds) {
    const id = Number(rawId);
    if (!Number.isSafeInteger(id)) continue;
    const photo = oneRow(db, 'SELECT sourceId, sourcePhotoId FROM photos WHERE id = ?', [id]);
    if (typeof photo?.sourceId === 'string' && typeof photo.sourcePhotoId === 'string') {
      photoRefs.push({ sourceId: photo.sourceId, sourcePhotoId: photo.sourcePhotoId });
    }
  }

  return {
    syncId: row.syncId,
    name: row.name,
    type: row.type,
    parentSyncId,
    rules: row.rules ? safeParse(row.rules) : null,
    photoRefs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    localSeq: row.localSeq,
  };
}

/** Translate stable wire references back to this catalog's local integer IDs. */
export function reconcileCollectionReferences(
  db: Database,
  rows: Array<Record<string, unknown>>,
): void {
  for (const row of rows) {
    const syncId = typeof row.syncId === 'string' ? row.syncId : null;
    if (!syncId) continue;
    const collection = oneRow(db, 'SELECT id, updatedAt FROM collections WHERE syncId = ?', [syncId]);
    if (!collection) continue;
    if (Number(collection.updatedAt) > Number(row.updatedAt ?? 0)) continue;

    let parentId: number | null = null;
    if (typeof row.parentSyncId === 'string') {
      const parent = oneRow(db, 'SELECT id FROM collections WHERE syncId = ?', [row.parentSyncId]);
      if (typeof parent?.id === 'number') parentId = parent.id;
    }

    // Photos arriving in a later sync cycle are not backfilled here; a future
    // collection revision must carry their stable references again.
    const photoIds: number[] = [];
    if (Array.isArray(row.photoRefs)) {
      for (const value of row.photoRefs) {
        if (typeof value !== 'object' || value === null) continue;
        const ref = value as Partial<StablePhotoRef>;
        if (typeof ref.sourceId !== 'string' || typeof ref.sourcePhotoId !== 'string') continue;
        const photo = oneRow(
          db,
          'SELECT id FROM photos WHERE sourceId = ? AND sourcePhotoId = ?',
          [ref.sourceId, ref.sourcePhotoId],
        );
        if (typeof photo?.id === 'number') photoIds.push(photo.id);
      }
    }

    db.run(
      'UPDATE collections SET parentId = ?, photoIds = ? WHERE id = ?',
      [parentId, JSON.stringify(photoIds), collection.id as number],
    );
  }
}

// ───────────────────────────────────────────────────────────────────────
// sql.js helpers
// ───────────────────────────────────────────────────────────────────────

type SqlParam = string | number | null;

function queryRows(
  db: Database,
  sql: string,
  params: SqlParam[],
  transform?: (row: Row) => Row,
): Row[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const out: Row[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as Row;
      out.push(transform ? transform(row) : row);
    }
    return out;
  } finally {
    stmt.free();
  }
}

function oneRow(db: Database, sql: string, params: SqlParam[]): Row | null {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (!stmt.step()) return null;
    return stmt.getAsObject() as Row;
  } finally {
    stmt.free();
  }
}

function safeParse(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

/** Coerce an arbitrary JSON-decoded value to a sql.js-bindable scalar. */
function sql(v: unknown): SqlParam {
  if (v == null) return null;
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return String(v);
}
