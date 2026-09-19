// AP02 (F006/F007): pull pages over the hub's revision, push sends the rows
// written here (localSeq) in byte-bounded batches and halves a batch on 413.
// SyncedStorage.hub.test.ts runs the same client against the real hub.
import type { Database } from 'sql.js';
import { SYNC_LIMITS, SYNC_TABLES } from '@photolib/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from './MemoryStorage';
import { SyncedStorage } from './SyncedStorage';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

const SERVER = 'https://hub.test';
const TOKEN = 'test-token';

type Row = Record<string, unknown>;
type HubReply = Response | Row | undefined;

interface HubCall {
  method: string;
  segment: string;
  url: URL;
  headers: Headers;
  body: Record<string, Row[]> | null;
  bytes: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A hub that answers every pull with an empty last page and accepts every push, unless told otherwise. */
function stubHub(hub: {
  pull?: (segment: string, url: URL) => HubReply;
  push?: (segment: string, rows: Row[]) => HubReply;
} = {}) {
  const calls: HubCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const segment = url.pathname.split('/').pop() ?? '';
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : null;
    const body = raw === null ? null : JSON.parse(raw) as Record<string, Row[]>;
    calls.push({
      method, segment, url, headers: new Headers(init?.headers), body,
      bytes: raw === null ? 0 : new TextEncoder().encode(raw).byteLength,
    });
    const rows = body?.[segment] ?? [];
    const reply = method === 'POST'
      ? hub.push?.(segment, rows) ?? { merged: rows.length, skipped: 0, errors: [] }
      : hub.pull?.(segment, url) ?? { [segment]: [], nextRevision: 0, hasMore: false };
    return reply instanceof Response ? reply : json(reply);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function pushedKeys(calls: HubCall[], segment: string, key: string): unknown[] {
  return calls
    .filter((call) => call.method === 'POST' && call.segment === segment)
    .flatMap((call) => call.body![segment].map((row) => row[key]));
}

function insertPreset(db: Database, syncId: string, name: string, updatedAt: number): void {
  db.run(
    `INSERT INTO presets (syncId, name, adjustments, category, createdAt, updatedAt, deletedAt)
     VALUES (?, ?, '{}', NULL, 1, ?, NULL)`,
    [syncId, name, updatedAt],
  );
}

function insertEdits(db: Database, hashes: string[], padBytes = 0): void {
  db.run('BEGIN');
  hashes.forEach((hash, index) => {
    db.run(
      `INSERT INTO edits (contentHash, copyIndex, adjustments, createdAt, updatedAt) VALUES (?, 0, ?, 1, ?)`,
      [hash, JSON.stringify({ pad: 'x'.repeat(padBytes) }), 1000 + index],
    );
  });
  db.run('COMMIT');
}

function readPreset(db: Database, syncId: string): Row | null {
  const result = db.exec('SELECT name, adjustments, updatedAt FROM presets WHERE syncId = ?', [syncId]);
  if (result.length === 0) return null;
  const [name, adjustments, updatedAt] = result[0].values[0];
  return { name, adjustments: JSON.parse(String(adjustments)), updatedAt };
}

function meta(db: Database, key: string): string | null {
  const value = db.exec('SELECT value FROM schema_meta WHERE key = ?', [key])[0]?.values[0]?.[0];
  return value == null ? null : String(value);
}

function maxLocalSeq(db: Database, table: string): number {
  return Number(db.exec(`SELECT MAX(localSeq) FROM ${table}`)[0].values[0][0]);
}

function count(db: Database, table: string): number {
  return Number(db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]);
}

const hashes = (n: number, prefix = 'h') => Array.from({ length: n }, (_, index) => `${prefix}${index}`);

describe('SyncedStorage.sync', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('applies newer remote rows, keeps newer local rows and pushes only the rows written here since the last push', async () => {
    const storage = await MemoryStorage.create();
    const db = storage.db;
    insertPreset(db, 'untouched', 'Untouched', 120);
    db.run("INSERT INTO schema_meta(key, value) VALUES ('sync.presets.pushSeq', ?)", [String(maxLocalSeq(db, 'presets'))]);
    insertPreset(db, 'local-wins', 'Local edit', 300);
    insertPreset(db, 'remote-wins', 'Local stale', 100);

    const remotePreset = (syncId: string, name: string, updatedAt: number, adjustments: Row = {}): Row =>
      ({ syncId, name, adjustments, category: null, createdAt: 1, updatedAt, deletedAt: null });
    // A hub from before revisions: rows without a cursor.
    const { calls } = stubHub({
      pull: (segment) => segment === 'presets'
        ? { presets: [remotePreset('remote-wins', 'Remote edit', 200, { exposure: 1 }), remotePreset('local-wins', 'Remote stale', 250)] }
        : undefined,
    });
    const onAfterPull = vi.fn();
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN }, { onAfterPull });

    const result = await synced.sync();

    expect(result.errors).toEqual([]);
    expect(result.pulled.presets).toBe(1);
    expect(onAfterPull).toHaveBeenCalledOnce();
    expect(readPreset(db, 'remote-wins')).toEqual({ name: 'Remote edit', adjustments: { exposure: 1 }, updatedAt: 200 });
    expect(readPreset(db, 'local-wins')).toEqual({ name: 'Local edit', adjustments: {}, updatedAt: 300 });
    expect(readPreset(db, 'untouched')).toEqual({ name: 'Untouched', adjustments: {}, updatedAt: 120 });

    const pulls = calls.filter((c) => c.method === 'GET');
    expect(pulls).toHaveLength(SYNC_TABLES.length);
    const presetPull = pulls.find((c) => c.segment === 'presets')!;
    expect(presetPull.url.origin + presetPull.url.pathname).toBe(`${SERVER}/api/sync/presets`);
    expect(Object.fromEntries(presetPull.url.searchParams)).toEqual({
      afterRevision: '0', limit: String(SYNC_LIMITS.pullPageRows),
    });
    // Without a cursor in the answer the watermark stays where it was.
    expect(meta(db, 'sync.presets.pullRev')).toBeNull();

    const pushes = calls.filter((c) => c.method === 'POST');
    expect(pushes.map((c) => c.segment)).toEqual(['presets']);
    expect(pushes[0].headers.get('Content-Type')).toBe('application/json');
    // Before AP02 the pulled 'remote-wins' went straight back to the hub (F006 echo).
    expect(pushes[0].body!.presets).toEqual([{
      syncId: 'local-wins', name: 'Local edit', adjustments: {}, category: null,
      createdAt: 1, updatedAt: 300, deletedAt: null,
    }]);
    expect(result.pushed.presets).toBe(1);
    expect(meta(db, 'sync.presets.pushSeq')).toBe(String(maxLocalSeq(db, 'presets')));

    for (const call of calls) expect(call.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    await storage.close();
  });

  it('sends the whole catalog again on resendAll, pulled rows included, and nothing more afterwards', async () => {
    const storage = await MemoryStorage.create();
    insertPreset(storage.db, 'local', 'Local', 300);
    const { calls } = stubHub({
      pull: (segment) => segment === 'presets'
        ? { presets: [{ syncId: 'pulled', name: 'Pulled', adjustments: {}, createdAt: 1, updatedAt: 200 }], nextRevision: 1, hasMore: false }
        : undefined,
    });
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });
    await synced.sync();
    expect(pushedKeys(calls, 'presets', 'syncId')).toEqual(['local']);

    const result = await synced.resendAll();

    expect(result.errors).toEqual([]);
    expect(pushedKeys(calls, 'presets', 'syncId')).toEqual(['local', 'pulled', 'local']);
    await synced.sync();
    expect(pushedKeys(calls, 'presets', 'syncId')).toHaveLength(3);
    await storage.close();
  });

  it('coalesces concurrent sync() calls into one cycle and starts a new one afterwards', async () => {
    const storage = await MemoryStorage.create();
    const { fetchMock } = stubHub();
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });

    const [first, second] = await Promise.all([synced.sync(), synced.sync()]);

    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(SYNC_TABLES.length);

    await synced.sync();
    expect(fetchMock).toHaveBeenCalledTimes(2 * SYNC_TABLES.length);
    await storage.close();
  });
});

describe('SyncedStorage pull pages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const edit = (contentHash: string, updatedAt: number): Row => ({ contentHash, copyIndex: 0, adjustments: {}, updatedAt });

  it('stores the watermark after every page and resumes at it after an abort between pages', async () => {
    const storage = await MemoryStorage.create();
    const pages: Record<string, Row> = {
      0: { edits: [edit('a', 10), edit('b', 11)], nextRevision: 7, hasMore: true },
      7: { edits: [edit('c', 12)], nextRevision: 9, hasMore: true },
      9: { edits: [edit('d', 13)], nextRevision: 12, hasMore: false },
    };
    let failOnce: string | null = '7';
    const { calls } = stubHub({
      pull: (segment, url) => {
        if (segment !== 'edits') return undefined;
        const afterRevision = url.searchParams.get('afterRevision')!;
        if (afterRevision === failOnce) {
          failOnce = null;
          return json({ error: 'upstream', code: 'internal' }, 502);
        }
        return pages[afterRevision];
      },
    });
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });

    const first = await synced.sync();
    expect(first.errors).toEqual([{ phase: 'pull', table: 'edits', error: 'edits pull HTTP 502' }]);
    expect(first.pulled.edits).toBe(2);
    expect(meta(storage.db, 'sync.edits.pullRev')).toBe('7');
    expect(count(storage.db, 'edits')).toBe(2);

    const second = await synced.sync();
    expect(second.errors).toEqual([]);
    expect(second.pulled.edits).toBe(2);
    expect(meta(storage.db, 'sync.edits.pullRev')).toBe('12');
    expect(count(storage.db, 'edits')).toBe(4);

    const editPulls = calls.filter((c) => c.method === 'GET' && c.segment === 'edits');
    expect(editPulls.map((c) => c.url.searchParams.get('afterRevision'))).toEqual(['0', '7', '7', '9']);
    expect(new Set(editPulls.map((c) => c.url.searchParams.get('limit')))).toEqual(new Set([String(SYNC_LIMITS.pullPageRows)]));
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    await storage.close();
  });

  it('stops a pull whose hub reports more pages without moving its cursor', async () => {
    const storage = await MemoryStorage.create();
    const { calls } = stubHub({
      pull: (segment) => segment === 'edits' ? { edits: [], nextRevision: 0, hasMore: true } : undefined,
    });
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });

    const result = await synced.sync();

    expect(result.errors).toEqual([{ phase: 'pull', table: 'edits', error: 'edits pull made no progress after revision 0' }]);
    expect(calls.filter((c) => c.segment === 'edits')).toHaveLength(1);
    await storage.close();
  });
});

describe('SyncedStorage push batches', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cuts a 500-row push of 100 KB rows into batches under SYNC_LIMITS.pushBatchBytes', async () => {
    const storage = await MemoryStorage.create();
    const rows = hashes(500);
    insertEdits(storage.db, rows, 100 * 1024);
    const { calls } = stubHub();
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });

    const result = await synced.sync();

    expect(result.errors).toEqual([]);
    expect(result.pushed.edits).toBe(500);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(Math.ceil((500 * 100 * 1024) / SYNC_LIMITS.pushBatchBytes));
    for (const post of posts) expect(post.bytes).toBeLessThanOrEqual(SYNC_LIMITS.pushBatchBytes);
    expect(pushedKeys(calls, 'edits', 'contentHash')).toEqual(rows);
    expect(posts.every((post) => post.body!.edits.every((row) => !('localSeq' in row)))).toBe(true);
    expect(meta(storage.db, 'sync.edits.pushSeq')).toBe(String(maxLocalSeq(storage.db, 'edits')));

    await synced.sync();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(posts.length);
    await storage.close();
  });

  it('halves a batch on 413 and ends after at most log2(500)+1 refusals', async () => {
    const storage = await MemoryStorage.create();
    insertEdits(storage.db, hashes(500));
    let refusals = 0;
    const { calls } = stubHub({
      push: (_segment, rows) => {
        if (rows.length === 1) return undefined;
        refusals += 1;
        return json({ error: 'payload too large', code: 'body-too-large' }, 413);
      },
    });
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });

    const result = await synced.sync();

    expect(result.errors).toEqual([]);
    expect(result.pushed.edits).toBe(500);
    expect(refusals).toBeGreaterThan(0);
    expect(refusals).toBeLessThanOrEqual(Math.log2(500) + 1);
    const accepted = calls.filter((c) => c.method === 'POST' && c.body!.edits.length === 1);
    expect(accepted.map((c) => c.body!.edits[0].contentHash)).toEqual(hashes(500));

    const postsBefore = calls.filter((c) => c.method === 'POST').length;
    await synced.sync();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(postsBefore);
    await storage.close();
  });

  it('reports a row the hub refuses even alone, passes over it and sends it again only after its next local write', async () => {
    const storage = await MemoryStorage.create();
    insertEdits(storage.db, ['a', 'b', 'c']);
    const { calls } = stubHub({
      push: (_segment, rows) => rows.some((row) => row.contentHash === 'b')
        ? json({ error: 'payload too large', code: 'body-too-large' }, 413)
        : undefined,
    });
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });

    const first = await synced.sync();
    expect(first.errors).toEqual([
      { phase: 'push', table: 'edits', key: 'b/0', code: 'row-too-large', error: 'row too large: b/0' },
    ]);
    expect(first.pushed.edits).toBe(2);
    const accepted = () => calls
      .filter((c) => c.method === 'POST' && !c.body!.edits.some((row) => row.contentHash === 'b'))
      .flatMap((c) => c.body!.edits.map((row) => row.contentHash));
    expect(accepted()).toEqual(['a', 'c']);
    expect(meta(storage.db, 'sync.edits.pushSeq')).toBe(String(maxLocalSeq(storage.db, 'edits')));

    const posts = () => calls.filter((c) => c.method === 'POST');
    const postsAfterFirst = posts().length;
    const second = await synced.sync();
    expect(second.errors).toEqual([]);
    expect(posts()).toHaveLength(postsAfterFirst);

    storage.db.run("UPDATE edits SET updatedAt = updatedAt + 1 WHERE contentHash = 'b'");
    const third = await synced.sync();
    expect(third.errors.map((e) => e.key)).toEqual(['b/0']);
    expect(posts().slice(postsAfterFirst).map((c) => c.body!.edits.map((row) => row.contentHash))).toEqual([['b']]);
    await storage.close();
  });

  it('leaves a row above SYNC_LIMITS.rowBytes out of every push and reports it', async () => {
    const storage = await MemoryStorage.create();
    insertEdits(storage.db, ['small-1']);
    insertEdits(storage.db, ['huge'], SYNC_LIMITS.rowBytes);
    insertEdits(storage.db, ['small-2']);
    const { calls } = stubHub();
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });

    const result = await synced.sync();

    expect(result.errors).toEqual([
      { phase: 'push', table: 'edits', key: 'huge/0', code: 'row-too-large', error: 'row too large: huge/0' },
    ]);
    expect(pushedKeys(calls, 'edits', 'contentHash')).toEqual(['small-1', 'small-2']);
    expect(meta(storage.db, 'sync.edits.pushSeq')).toBe(String(maxLocalSeq(storage.db, 'edits')));
    await storage.close();
  });

  it('reports rows the hub refused inside an accepted batch', async () => {
    const storage = await MemoryStorage.create();
    insertEdits(storage.db, ['good', 'bad']);
    stubHub({ push: () => ({ merged: 1, skipped: 1, errors: [{ key: 'bad/0', code: 'invalid' }] }) });
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });

    const result = await synced.sync();

    expect(result.errors).toEqual([
      { phase: 'push', table: 'edits', key: 'bad/0', code: 'invalid', error: 'invalid row: bad/0' },
    ]);
    expect(result.pushed.edits).toBe(1);
    await storage.close();
  });
});

describe('SyncedStorage pulls a row the catalog refuses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes over the row, reports it with its key and moves the watermark on', async () => {
    const storage = await MemoryStorage.create();
    const db = storage.db;
    db.run(`INSERT INTO sources (id, type, label, config, addedAt, updatedAt) VALUES ('s', 'local', 'S', '{}', 1, 1)`);
    const photo = (sourcePhotoId: string, extra: Row = {}): Row =>
      ({ sourceId: 's', sourcePhotoId, name: `${sourcePhotoId}.jpg`, indexedAt: 1, updatedAt: 10, ...extra });
    // photos.name is NOT NULL; the hub's middle row has none.
    const pages: Record<string, Row> = {
      0: { photos: [photo('ok-1'), photo('broken', { name: null }), photo('ok-2')], nextRevision: 4, hasMore: false },
      4: { photos: [], nextRevision: 4, hasMore: false },
    };
    const { calls } = stubHub({
      pull: (segment, url) => segment === 'photos' ? pages[url.searchParams.get('afterRevision')!] : undefined,
    });
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });

    const result = await synced.sync();

    expect(result.errors).toEqual([
      { phase: 'pull', table: 'photos', key: 's/broken', code: 'invalid', error: 'invalid row: s/broken' },
    ]);
    expect(result.pulled.photos).toBe(2);
    expect(db.exec('SELECT sourcePhotoId FROM photos ORDER BY sourcePhotoId')[0].values.flat()).toEqual(['ok-1', 'ok-2']);
    expect(meta(db, 'sync.photos.pullRev')).toBe('4');

    // The watermark moved, so the next cycle asks past the refused row
    // instead of running into it again forever.
    const second = await synced.sync();
    expect(second.errors).toEqual([]);
    expect(calls
      .filter((c) => c.method === 'GET' && c.segment === 'photos')
      .map((c) => c.url.searchParams.get('afterRevision'))).toEqual(['0', '4']);
    await storage.close();
  });
});

describe('SyncedStorage collection references', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const wire = (syncId: string, updatedAt: number, extra: Row = {}): Row => ({
    syncId, name: syncId, type: 'manual', parentSyncId: null, rules: null,
    photoRefs: [], createdAt: 1, updatedAt, deletedAt: null, ...extra,
  });

  function collection(db: Database, syncId: string): Row {
    const row = db.exec(
      `SELECT c.name, p.syncId, c.photoIds
       FROM collections c LEFT JOIN collections p ON p.id = c.parentId
       WHERE c.syncId = ?`,
      [syncId],
    )[0].values[0];
    return { name: row[0], parent: row[1], photoIds: row[2] == null ? null : JSON.parse(String(row[2])) };
  }

  it('leaves parent and photos alone where the local row won, and resolves a parent from a later page', async () => {
    const storage = await MemoryStorage.create();
    const db = storage.db;
    db.run(`INSERT INTO sources (id, type, label, config, addedAt, updatedAt) VALUES ('s', 'local', 'S', '{}', 1, 1)`);
    db.run(
      `INSERT INTO photos (sourceId, sourcePhotoId, contentHash, name, availability, sourceRevision, indexedAt, updatedAt)
       VALUES ('s', 'p1', NULL, 'p1.jpg', 'online', 0, 1, 1)`,
    );
    const photoId = Number(db.exec("SELECT id FROM photos WHERE sourcePhotoId = 'p1'")[0].values[0][0]);
    for (const syncId of ['home', 'elsewhere']) {
      db.run(`INSERT INTO collections (syncId, name, type, createdAt, updatedAt) VALUES (?, ?, 'manual', 1, 50)`, [syncId, syncId]);
    }
    const homeId = Number(db.exec("SELECT id FROM collections WHERE syncId = 'home'")[0].values[0][0]);
    db.run(
      `INSERT INTO collections (syncId, name, type, parentId, photoIds, createdAt, updatedAt)
       VALUES ('local-wins', 'Local', 'manual', ?, ?, 1, 300)`,
      [homeId, JSON.stringify([photoId])],
    );

    const pages: Record<string, Row> = {
      // The hub's copy of local-wins ties the local timestamp, so the local
      // row wins: it must not move to 'elsewhere' or become empty. remote-wins
      // is new here and names a parent that only arrives on the next page.
      0: {
        collections: [
          wire('local-wins', 300, { name: 'Remote', parentSyncId: 'elsewhere', photoRefs: [] }),
          wire('remote-wins', 500, { parentSyncId: 'late-parent', photoRefs: [{ sourceId: 's', sourcePhotoId: 'p1' }] }),
        ],
        nextRevision: 1,
        hasMore: true,
      },
      1: { collections: [wire('late-parent', 500)], nextRevision: 2, hasMore: false },
    };
    stubHub({ pull: (segment, url) => segment === 'collections' ? pages[url.searchParams.get('afterRevision')!] : undefined });
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN });

    const result = await synced.sync();

    expect(result.errors).toEqual([]);
    expect(collection(db, 'local-wins')).toEqual({ name: 'Local', parent: 'home', photoIds: [photoId] });
    expect(collection(db, 'remote-wins')).toEqual({ name: 'remote-wins', parent: 'late-parent', photoIds: [photoId] });
    await storage.close();
  });
});

describe('SyncedStorage session end', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('ends the session on a 401 from a pull: one error, no further request, consumer told once', async () => {
    const storage = await MemoryStorage.create();
    insertEdits(storage.db, ['a']);
    const { calls } = stubHub({ pull: () => json({ error: 'Token revoked' }, 401) });
    const onUnauthorized = vi.fn();
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN }, { onUnauthorized });

    const result = await synced.sync();

    expect(result.errors).toEqual([
      { phase: 'pull', table: 'sources', error: 'sources pull HTTP 401', code: 'unauthorized' },
    ]);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    // The token is dead for every table, so nothing else is tried and the
    // local write waits unpushed for the next session.
    expect(calls).toHaveLength(1);
    expect(meta(storage.db, 'sync.edits.pushSeq')).toBeNull();
    await storage.close();
  });

  it('ends the session on a 401 from a push, after the pulls went through', async () => {
    const storage = await MemoryStorage.create();
    insertEdits(storage.db, ['a']);
    const { calls } = stubHub({ push: () => json({ error: 'Token revoked' }, 401) });
    const onUnauthorized = vi.fn();
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN }, { onUnauthorized });

    const result = await synced.sync();

    expect(result.errors).toEqual([
      { phase: 'push', table: 'edits', error: 'edits push HTTP 401', code: 'unauthorized' },
    ]);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(meta(storage.db, 'sync.edits.pushSeq')).toBeNull();
    await storage.close();
  });

  it('keeps the session on any other refusal', async () => {
    const storage = await MemoryStorage.create();
    const { calls } = stubHub({
      pull: (segment) => segment === 'sources' ? json({ error: 'boom' }, 500) : undefined,
    });
    const onUnauthorized = vi.fn();
    const synced = new SyncedStorage(storage, { serverUrl: SERVER, token: TOKEN }, { onUnauthorized });

    const result = await synced.sync();

    expect(result.errors).toEqual([{ phase: 'pull', table: 'sources', error: 'sources pull HTTP 500' }]);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(SYNC_TABLES.length);
    await storage.close();
  });
});
