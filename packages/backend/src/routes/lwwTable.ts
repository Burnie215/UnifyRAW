import { Router } from 'express';
import type { Database, Statement } from 'sql.js';
import { SYNC_LIMITS, type SyncPushResponse, type SyncTableName } from '@photolib/shared';
import { getDb, markDirty, persistSoon } from '../services/db.js';
import { getRequestUserId } from '../middleware/auth.js';

export type SyncRow = Record<string, unknown>;
type SqlParam = string | number | null;

/** Hard cap of one push; the client batches below it (SYNC_LIMITS.pushBatchRows). */
const MAX_PUSH_ROWS = 1_000;

export interface LwwTableSpec<TWire extends object> {
  table: SyncTableName;
  /** Path segment under /api/sync and the JSON key of the row array. */
  urlKey: string;
  /** Columns that identify a row within one user's rows. */
  identity: readonly string[];
  /** Columns exchanged with the client, identity included. */
  columns: readonly string[];
  /** Creation time: written on insert (updatedAt when missing) and kept when a newer row replaces it. */
  createdColumn?: string;
  /** Columns stored as JSON text, each with the value that stands for an empty one. */
  json?: Readonly<Record<string, unknown>>;
  validate(row: TWire): boolean;
  /** Wire fields that differ from the stored columns. */
  toWire?(row: SyncRow): SyncRow;
  /** Column values that differ from the wire fields. */
  fromWire?(row: TWire): SyncRow;
}

export interface LwwTable {
  router: Router;
}

type Outcome = 'merged' | 'skipped' | 'invalid' | 'row-too-large';

interface PushStatements {
  lookup: Statement;
  update: Statement;
  insert: Statement;
}

let legacyCursorWarned = false;

/**
 * GET and POST /<urlKey> for one sync table. Pull pages over the hub's
 * revision; push merges a row only when its updatedAt beats the stored one
 * and then gives it the next revision, so a row reaches every other device
 * whatever its clock said.
 */
export function lwwTable<TWire extends object>(spec: LwwTableSpec<TWire>): LwwTable {
  const { table, urlKey, identity, columns } = spec;
  const json = Object.entries(spec.json ?? {});
  const updatable = columns.filter((column) => !identity.includes(column) && column !== spec.createdColumn);
  const columnList = columns.join(', ');
  const sql = {
    page: `SELECT ${columnList}, revision FROM ${table} WHERE userId = ? AND revision > ? ORDER BY revision LIMIT ?`,
    legacy: `SELECT ${columnList} FROM ${table} WHERE userId = ? AND updatedAt > ?`,
    lookup: `SELECT rowid AS lwwRowId, updatedAt FROM ${table}
             WHERE userId = ? AND ${identity.map((column) => `${column} = ?`).join(' AND ')} LIMIT 1`,
    update: `UPDATE ${table} SET ${updatable.map((column) => `${column} = ?`).join(', ')}, revision = ? WHERE rowid = ?`,
    insert: `INSERT INTO ${table} (userId, ${columnList}, revision)
             VALUES (${Array.from({ length: columns.length + 2 }, () => '?').join(', ')})`,
  };

  function toWire(stored: SyncRow): SyncRow {
    const row: SyncRow = { ...stored };
    for (const [column, empty] of json) {
      row[column] = stored[column] ? JSON.parse(String(stored[column])) as unknown : empty;
    }
    return { ...row, ...spec.toWire?.(stored) };
  }

  function fromWire(wire: TWire): SyncRow {
    const source = wire as SyncRow;
    const values: SyncRow = {};
    for (const column of columns) values[column] = source[column] ?? null;
    for (const [column, empty] of json) {
      const value = source[column] ? source[column] : empty;
      values[column] = value === null ? null : JSON.stringify(value);
    }
    if (spec.createdColumn) values[spec.createdColumn] = source[spec.createdColumn] ?? source.updatedAt;
    return { ...values, ...spec.fromWire?.(wire) };
  }

  function mergeRow(db: Database, userId: string, wire: unknown, statements: PushStatements): Outcome {
    if (typeof wire !== 'object' || wire === null || Array.isArray(wire)) return 'invalid';
    if (!validTimestamp((wire as SyncRow).updatedAt) || !spec.validate(wire as TWire)) return 'invalid';
    const values = fromWire(wire as TWire);
    if (!isBindable(values)) return 'invalid';
    if (Buffer.byteLength(JSON.stringify(wire)) > SYNC_LIMITS.rowBytes) return 'row-too-large';

    const existing = firstRow(statements.lookup, [userId, ...identity.map((column) => values[column])]);
    if (existing && Number(values.updatedAt) <= Number(existing.updatedAt)) return 'skipped';
    const revision = nextRevision(db);
    if (existing) {
      statements.update.run([...updatable.map((column) => values[column]), revision, Number(existing.lwwRowId)]);
    } else {
      statements.insert.run([userId, ...columns.map((column) => values[column]), revision]);
    }
    return 'merged';
  }

  function mergeBatch(db: Database, userId: string, rows: unknown[]): Required<SyncPushResponse> {
    const result: Required<SyncPushResponse> = { merged: 0, skipped: 0, errors: [] };
    const statements = { lookup: db.prepare(sql.lookup), update: db.prepare(sql.update), insert: db.prepare(sql.insert) };
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const outcome = mergeRow(db, userId, row, statements);
        if (outcome === 'merged') {
          result.merged += 1;
          continue;
        }
        result.skipped += 1;
        if (outcome !== 'skipped') result.errors.push({ key: keyOf(identity, row), code: outcome });
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      statements.lookup.free();
      statements.update.free();
      statements.insert.free();
    }
    return result;
  }

  const router = Router();

  router.get(`/${urlKey}`, (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const db = getDb();
      if (req.query.since !== undefined && req.query.afterRevision === undefined) {
        warnLegacyCursor(userId);
        res.json({ [urlKey]: selectRows(db, sql.legacy, [userId, parseSince(req.query.since)]).map(toWire) });
        return;
      }
      const afterRevision = parseAfterRevision(req.query.afterRevision);
      if (afterRevision === null) {
        res.status(400).json({ error: 'afterRevision must be a non-negative integer', code: 'invalid-query' });
        return;
      }
      const limit = parseLimit(req.query.limit);
      const found = selectRows(db, sql.page, [userId, afterRevision, limit + 1]);
      const page = found.slice(0, limit);
      res.json({
        [urlKey]: page.map(({ revision: _revision, ...row }) => toWire(row)),
        nextRevision: page.length > 0 ? Number(page[page.length - 1].revision) : afterRevision,
        hasMore: found.length > limit,
      });
    } catch {
      res.status(500).json({ error: `${urlKey} fetch failed`, code: 'internal' });
    }
  });

  router.post(`/${urlKey}`, async (req, res) => {
    try {
      const userId = getRequestUserId(req);
      const rows: unknown = (req.body as SyncRow | undefined)?.[urlKey];
      if (!Array.isArray(rows)) {
        res.status(400).json({ error: `${urlKey} must be an array`, code: 'invalid-body' });
        return;
      }
      if (rows.length > MAX_PUSH_ROWS) {
        res.status(413).json({
          error: `${urlKey} batch exceeds the ${MAX_PUSH_ROWS} row limit`,
          code: 'batch-too-large',
        });
        return;
      }
      const result = mergeBatch(getDb(), userId, rows);
      if (result.merged > 0) markDirty();
      await persistSoon();
      res.json(result);
    } catch {
      res.status(500).json({ error: `${urlKey} push failed`, code: 'internal' });
    }
  });

  return { router };
}

function nextRevision(db: Database): number {
  const value = db.exec('UPDATE sync_counter SET value = value + 1 WHERE id = 1 RETURNING value')[0]?.values[0]?.[0];
  if (typeof value !== 'number') throw new Error('sync_counter is missing; migration 7 has not run');
  return value;
}

function selectRows(db: Database, sql: string, params: SqlParam[]): SyncRow[] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows: SyncRow[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as SyncRow);
    return rows;
  } finally {
    stmt.free();
  }
}

function firstRow(stmt: Statement, params: SqlParam[]): SyncRow | null {
  try {
    stmt.bind(params);
    return stmt.step() ? stmt.getAsObject() as SyncRow : null;
  } finally {
    stmt.reset();
  }
}

function isBindable(values: SyncRow): values is Record<string, SqlParam> {
  return Object.values(values).every((value) =>
    value === null || typeof value === 'string' || typeof value === 'number');
}

function keyOf(identity: readonly string[], row: unknown): string {
  const source = typeof row === 'object' && row !== null ? row as SyncRow : {};
  return identity.map((column) => String(source[column] ?? '')).join('/');
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseSince(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseAfterRevision(value: unknown): number | null {
  if (value === undefined) return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function parseLimit(value: unknown): number {
  const n = Number(value);
  if (value === undefined || !Number.isSafeInteger(n) || n < 1) return SYNC_LIMITS.pullPageRows;
  return Math.min(n, SYNC_LIMITS.pullPageRowsMax);
}

function warnLegacyCursor(userId: string): void {
  if (legacyCursorWarned) return;
  legacyCursorWarned = true;
  console.warn('[sync] legacy since-cursor used by', userId);
}
