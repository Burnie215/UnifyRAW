import fs from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express, { type RequestHandler } from 'express';
import initSqlJs from 'sql.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SYNC_LIMITS, type SyncTableName } from '@photolib/shared';
import { bodyTooLargeHandler } from '../middleware/body-errors.js';
import { closeDb, getDb, initDb } from '../services/db.js';
import { syncRouter } from './sync.js';

let temporaryRoot: string;
let databasePath: string;
let server: Server;
let baseUrl: string;

type Row = Record<string, unknown>;

interface SyncResponseBody {
  [key: string]: unknown;
  sources?: Row[];
  presets?: Row[];
  exports?: Row[];
  collections?: Row[];
  edits?: Row[];
  nextRevision?: number;
  hasMore?: boolean;
}

/** Stands in for requireAuth, which puts the token's user on the request. */
const asTestUser: RequestHandler = (req, _res, next) => {
  const userId = req.header('x-test-user');
  if (userId) Object.assign(req, { user: { userId, username: userId, role: 'user', exp: Number.MAX_SAFE_INTEGER } });
  next();
};

beforeAll(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-sync-api-'));
  databasePath = path.join(temporaryRoot, 'photolib.db');
  await initDb(databasePath);

  const app = express();
  app.use('/api/sync', asTestUser, syncRouter);
  app.use(bodyTooLargeHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  closeDb();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('sync API wire contract', () => {
  it('warns once per process when a client still pulls with ?since=', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await get('/presets?since=0', 'legacy-a');
    await get('/edits?since=0', 'legacy-b');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[sync] legacy since-cursor used by', 'legacy-a');
  });

  it('never stores or returns source credentials', async () => {
    const pushed = await post('/sources', { sources: [{
      id: 'source',
      type: 'webdav',
      label: 'DAV',
      config: { url: 'https://dav.example', username: 'alice', password: 'secret' },
      addedAt: 1,
      updatedAt: 10,
    }] });
    expect(pushed.status).toBe(200);

    const stored = String(getDb().exec(
      "SELECT config FROM sources WHERE userId='_anon' AND id='source'",
    )[0].values[0][0]);
    expect(JSON.parse(stored)).toEqual({ url: 'https://dav.example', username: 'alice' });

    const pulled = await get('/sources');
    expect(pulled.body.sources?.[0]?.config).toEqual({ url: 'https://dav.example', username: 'alice' });
  });

  it('uses stable IDs for presets and collections and drops the device-local undo stack', async () => {
    expect((await post('/presets', { presets: [{
      syncId: 'preset-sync', name: 'Film', adjustments: { contrast: 10 },
      createdAt: 1, updatedAt: 20,
    }] })).status).toBe(200);
    expect((await post('/presets', { presets: [{
      syncId: 'preset-sync', name: 'Film Updated', adjustments: { contrast: 20 },
      createdAt: 1, updatedAt: 21,
    }] })).status).toBe(200);

    expect((await post('/collections', { collections: [{
      syncId: 'collection-sync', name: 'Favorites', type: 'manual',
      parentSyncId: null,
      photoRefs: [{ sourceId: 'source', sourcePhotoId: 'photo-a' }],
      createdAt: 1, updatedAt: 30,
    }] })).status).toBe(200);

    expect((await post('/edits', { edits: [{
      contentHash: 'hash', copyIndex: 0, adjustments: {}, document: { version: 1 },
      history: [], documentHistory: [{ version: 1 }], createdAt: 1, updatedAt: 40,
    }] })).status).toBe(200);

    const presets = await get('/presets');
    expect(presets.body.presets).toHaveLength(1);
    expect(presets.body.presets?.[0]).toMatchObject({ syncId: 'preset-sync', name: 'Film Updated' });
    const collections = await get('/collections');
    expect(collections.body.collections?.[0]).toMatchObject({
      syncId: 'collection-sync',
      photoRefs: [{ sourceId: 'source', sourcePhotoId: 'photo-a' }],
    });
    const edits = await get('/edits');
    // An older client may still send documentHistory: it is accepted, dropped,
    // and never handed back out. The rest of the row survives untouched.
    expect(edits.body.edits?.[0]).toMatchObject({ contentHash: 'hash', document: { version: 1 } });
    expect(Object.keys(edits.body.edits?.[0] ?? {})).not.toContain('documentHistory');
    expect(JSON.stringify(edits.body.edits)).not.toContain('documentHistory');
    expect(getDb().exec("SELECT documentHistory FROM edits WHERE contentHash='hash'")[0].values[0][0])
      .toBeNull();
    // The per-hash lookup had no client; the table route is the only way in (F116).
    expect((await fetch(`${baseUrl}/api/sync/edits/hash`)).status).toBe(404);
  });

  it('hands the export ledger back whole, so the other device knows what left the app', async () => {
    const entry = {
      syncId: 'hash/0/source/stack/jpg', contentHash: 'hash', copyIndex: 0,
      targetSourceId: 'source', targetAssetId: 'asset-1', targetUrl: 'https://photos.example/asset-1',
      format: 'jpg', editStackHash: 'stack', filename: 'p_edit_stack.jpg',
      bytes: 4242, status: 'ok', uploadedAt: 90, updatedAt: 90,
    };
    expect((await post('/exports', { exports: [entry] }, 'ledger')).body).toMatchObject({ merged: 1 });

    const pulled = await get('/exports', 'ledger');
    expect(rowsOf(pulled.body, 'exports')).toEqual([{ ...entry, deletedAt: null }]);
    // Another account's hub rows are its own.
    expect(rowsOf((await get('/exports', 'ledger-other')).body, 'exports')).toEqual([]);
  });

  it('persists successful pushes before acknowledging them', async () => {
    closeDb();
    await initDb(databasePath);
    const sources = await get('/sources');
    expect(sources.body.sources).toHaveLength(1);
    expect(sources.body.sources?.[0]?.id).toBe('source');
  });

  it('answers a push only after its snapshot is on disk', async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      markWriteStarted();
      await writeGate;
      return realOpen(...args);
    });

    let answered = false;
    const push = post('/presets', { presets: [{
      syncId: 'durable', name: 'Durable', adjustments: {}, createdAt: 1, updatedAt: 70,
    }] }).then((result) => {
      answered = true;
      return result;
    });
    await writeStarted;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);

    releaseWrite();
    expect((await push).status).toBe(200);
    expect(await rowsOnDisk("SELECT name FROM presets WHERE syncId = 'durable'")).toEqual([['Durable']]);
  });

  it('answers 500 when the snapshot cannot be written and persists it with the retry', async () => {
    vi.spyOn(fs, 'open').mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
    const preset = { presets: [{
      syncId: 'retried', name: 'Retried', adjustments: {}, createdAt: 1, updatedAt: 80,
    }] };

    expect((await post('/presets', preset)).status).toBe(500);
    // The row is already merged in memory, so the retry merges nothing new.
    expect((await post('/presets', preset)).status).toBe(200);
    expect(await rowsOnDisk("SELECT name FROM presets WHERE syncId = 'retried'")).toEqual([['Retried']]);
  });

  it('rejects oversized push batches', async () => {
    const sources = Array.from({ length: 1001 }, (_, index) => ({
      id: `source-${index}`,
      type: 'local',
      label: 'Source',
      config: {},
      addedAt: 1,
      updatedAt: 50,
    }));
    const response = await post('/sources', { sources });
    expect(response.status).toBe(413);
    expect(response.body.code).toBe('batch-too-large');
  });

  it('pages a 1200-row first pull in pages of at most SYNC_LIMITS.pullPageRows', async () => {
    const user = 'first-pull';
    const edits = Array.from({ length: 1200 }, (_, index) => ({
      contentHash: `h${index}`, copyIndex: 0, adjustments: {}, createdAt: 1, updatedAt: 5000 + index,
    }));
    expect((await post('/edits', { edits: edits.slice(0, 600) }, user)).body).toMatchObject({ merged: 600 });
    expect((await post('/edits', { edits: edits.slice(600) }, user)).body).toMatchObject({ merged: 600 });

    const pages = await pullAll('edits', user);
    expect(pages.map((page) => rowsOf(page, 'edits').length)).toEqual([500, 500, 200]);
    expect(new Set(pages.flatMap((page) => rowsOf(page, 'edits').map((row) => row.contentHash))).size).toBe(1200);

    const clamped = await get('/edits?afterRevision=0&limit=5000', user);
    expect(rowsOf(clamped.body, 'edits')).toHaveLength(SYNC_LIMITS.pullPageRowsMax);
    expect(clamped.body.hasMore).toBe(true);
  });

  it('refuses a cursor that is not a revision', async () => {
    const response = await get('/edits?afterRevision=-1');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid-query');
  });
});

interface TableCase {
  urlKey: string;
  table: SyncTableName;
  /** Wire field that tells the rows of these tests apart. */
  key: string;
  row(id: string, updatedAt: number): Row;
}

const TABLE_CASES: TableCase[] = [
  {
    urlKey: 'edits', table: 'edits', key: 'contentHash',
    row: (id, updatedAt) => ({ contentHash: id, copyIndex: 0, adjustments: { exposure: 1 }, createdAt: 1, updatedAt }),
  },
  {
    urlKey: 'meta', table: 'photoMeta', key: 'contentHash',
    row: (id, updatedAt) => ({ contentHash: id, rating: 3, keywords: ['k'], updatedAt }),
  },
  {
    urlKey: 'sources', table: 'sources', key: 'id',
    row: (id, updatedAt) => ({ id, type: 'local', label: 'Local', config: {}, addedAt: 1, updatedAt }),
  },
  {
    urlKey: 'photos', table: 'photos', key: 'sourcePhotoId',
    row: (id, updatedAt) => ({ sourceId: 'source', sourcePhotoId: id, name: `${id}.jpg`, updatedAt }),
  },
  {
    urlKey: 'presets', table: 'presets', key: 'syncId',
    row: (id, updatedAt) => ({ syncId: id, name: 'Preset', adjustments: {}, createdAt: 1, updatedAt }),
  },
  {
    urlKey: 'developProfiles', table: 'developProfiles', key: 'syncId',
    row: (id, updatedAt) => ({
      syncId: id, name: 'X-T5', scope: 'camera', key: 'fujifilm x-t5', adjustments: {}, createdAt: 1, updatedAt,
    }),
  },
  {
    urlKey: 'lensProfiles', table: 'lensProfiles', key: 'syncId',
    row: (id, updatedAt) => ({ syncId: id, name: 'XF 23', key: 'xf23', coefficients: {}, createdAt: 1, updatedAt }),
  },
  {
    urlKey: 'collections', table: 'collections', key: 'syncId',
    row: (id, updatedAt) => ({ syncId: id, name: 'Picks', type: 'manual', photoRefs: [], createdAt: 1, updatedAt }),
  },
  {
    urlKey: 'exports', table: 'exports', key: 'syncId',
    row: (id, updatedAt) => ({
      syncId: id, contentHash: 'hash', copyIndex: 0, targetSourceId: 'source', targetAssetId: 'asset',
      targetUrl: null, format: 'jpg', editStackHash: 'stack', filename: 'p_edit_stack.jpg',
      bytes: 42, status: 'ok', uploadedAt: 1, updatedAt,
    }),
  },
];

describe.each(TABLE_CASES)('/api/sync/$urlKey', (table) => {
  const { urlKey } = table;
  const push = (rows: Row[], user: string) => post(`/${urlKey}`, { [urlKey]: rows }, user);
  const keysOf = (body: SyncResponseBody) => rowsOf(body, urlKey).map((row) => row[table.key]);

  it('gives every merged row the next revision, in push order', async () => {
    const user = `${urlKey}-order`;
    // Equal and falling updatedAt: the order has to come from the hub, not from the rows.
    const first = await push([table.row('a', 500), table.row('b', 500), table.row('c', 400)], user);
    expect(first.body).toEqual({ merged: 3, skipped: 0, errors: [] });
    expect((await push([table.row('d', 100)], user)).body).toMatchObject({ merged: 1 });

    const revisions = getDb().exec(
      `SELECT revision FROM ${table.table} WHERE userId = ? ORDER BY rowid`, [user],
    )[0].values.map(([revision]) => Number(revision));
    expect(revisions).toHaveLength(4);
    for (let index = 1; index < revisions.length; index += 1) {
      expect(revisions[index]).toBeGreaterThan(revisions[index - 1]);
    }
    expect(keysOf((await get(`/${urlKey}?afterRevision=0`, user)).body)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('pages with limit, nextRevision and hasMore, the next page starting after the last', async () => {
    const user = `${urlKey}-pages`;
    await push([table.row('k2', 700), table.row('k0', 700), table.row('k1', 700)], user);
    await push([table.row('k4', 700), table.row('k3', 700)], user);
    // Rewriting the oldest row moves it to the end: neither rowid nor key order is revision order.
    await push([table.row('k2', 701)], user);

    const pages = await pullAll(urlKey, user, 2);
    expect(pages.map((page) => keysOf(page))).toEqual([['k0', 'k1'], ['k4', 'k3'], ['k2']]);
    expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
    const last = pages[pages.length - 1];
    const empty = await get(`/${urlKey}?afterRevision=${last.nextRevision}&limit=2`, user);
    expect(empty.body).toEqual({ [urlKey]: [], nextRevision: last.nextRevision, hasMore: false });
  });

  it('keeps the stored row when an older or equally old one arrives', async () => {
    const user = `${urlKey}-lww`;
    await push([table.row('x', 900)], user);
    const before = await get(`/${urlKey}`, user);

    const stale = await push([table.row('x', 800), table.row('x', 900)], user);

    expect(stale.body).toEqual({ merged: 0, skipped: 2, errors: [] });
    const after = await get(`/${urlKey}`, user);
    expect(rowsOf(after.body, urlKey).map((row) => row.updatedAt)).toEqual([900]);
    expect(after.body.nextRevision).toBe(before.body.nextRevision);
  });

  it('hands a device the rows pushed after its last pull, whatever their clock said', async () => {
    const user = `${urlKey}-drift`;
    await push([table.row('from-a', 2_000_000)], user);
    const pulledByA = await get(`/${urlKey}?afterRevision=0`, user);
    const own = Number(pulledByA.body.nextRevision);
    expect(keysOf((await get(`/${urlKey}?afterRevision=${own - 1}`, user)).body)).toEqual(['from-a']);
    expect(keysOf((await get(`/${urlKey}?afterRevision=${own}`, user)).body)).toEqual([]);

    // Device B's clock runs 30 minutes behind device A's.
    await push([table.row('from-b', 2_000_000 - 30 * 60 * 1000)], user);

    expect(keysOf((await get(`/${urlKey}?afterRevision=${own}`, user)).body)).toEqual(['from-b']);
  });

  it('reports a row above SYNC_LIMITS.rowBytes and merges the rest of the batch', async () => {
    const user = `${urlKey}-row-limit`;
    const big = { ...table.row('big', 1000), padding: 'x'.repeat(SYNC_LIMITS.rowBytes) };

    const response = await push([big, table.row('small', 1000)], user);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ merged: 1, skipped: 1 });
    expect(response.body.errors).toEqual([{ key: expect.stringContaining('big'), code: 'row-too-large' }]);
    expect(keysOf((await get(`/${urlKey}`, user)).body)).toEqual(['small']);
  });

  it('answers 413 body-too-large above SYNC_LIMITS.bodyBytes', async () => {
    const huge = { ...table.row('huge', 1000), padding: 'x'.repeat(SYNC_LIMITS.bodyBytes) };
    const response = await push([huge], `${urlKey}-body-limit`);
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ error: 'payload too large', code: 'body-too-large' });
  });

  it('still serves the legacy ?since= cursor, unpaginated', async () => {
    const user = `${urlKey}-legacy`;
    await push([table.row('old-client', 3000)], user);

    const since = await get(`/${urlKey}?since=2999`, user);
    expect(keysOf(since.body)).toEqual(['old-client']);
    expect(since.body).not.toHaveProperty('nextRevision');
    expect(since.body).not.toHaveProperty('hasMore');
    expect(keysOf((await get(`/${urlKey}?since=3000`, user)).body)).toEqual([]);
  });
});

function rowsOf(body: SyncResponseBody, urlKey: string): Row[] {
  return (body[urlKey] as Row[] | undefined) ?? [];
}

async function pullAll(urlKey: string, user: string, limit?: number): Promise<SyncResponseBody[]> {
  const pages: SyncResponseBody[] = [];
  let afterRevision = 0;
  for (let request = 0; request < 10; request += 1) {
    const query = limit === undefined ? '' : `&limit=${limit}`;
    const page = await get(`/${urlKey}?afterRevision=${afterRevision}${query}`, user);
    expect(page.status).toBe(200);
    pages.push(page.body);
    if (!page.body.hasMore) return pages;
    afterRevision = Number(page.body.nextRevision);
  }
  throw new Error(`${urlKey} pull did not end after 10 pages`);
}

async function get(segment: string, user?: string): Promise<{ status: number; body: SyncResponseBody }> {
  const response = await fetch(`${baseUrl}/api/sync${segment}`, {
    headers: user ? { 'x-test-user': user } : {},
  });
  return { status: response.status, body: await response.json() as SyncResponseBody };
}

async function post(
  segment: string,
  body: unknown,
  user?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/sync${segment}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function rowsOnDisk(sql: string): Promise<unknown[][]> {
  const SQL = await initSqlJs();
  const onDisk = new SQL.Database(await fs.readFile(databasePath));
  try {
    return onDisk.exec(sql)[0]?.values ?? [];
  } finally {
    onDisk.close();
  }
}
