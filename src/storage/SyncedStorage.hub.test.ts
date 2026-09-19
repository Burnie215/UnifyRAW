// Two device catalogs against the real sync hub, in-process (AP02 acceptance).
import fs from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express, { type ErrorRequestHandler, type RequestHandler, type Router } from 'express';
import { SYNC_LIMITS } from '@photolib/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Adjustments } from '../types';
import { MemoryStorage } from './MemoryStorage';
import { buildRepositories } from './repos';
import { SyncedStorage } from './SyncedStorage';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

interface Hub {
  syncRouter: Router;
  bodyTooLargeHandler: ErrorRequestHandler;
  initDb(filePath: string): Promise<void>;
  closeDb(): void;
}

// Imported by a computed path so tsconfig.test.json does not take in the
// backend: it compiles under its own tsconfig, and this one
// (erasableSyntaxOnly) refuses the parameter properties of its library code.
async function loadHub(): Promise<Hub> {
  const backend = '../../packages/backend/src';
  const [routes, middleware, services] = await Promise.all([
    import(/* @vite-ignore */ `${backend}/routes/sync`),
    import(/* @vite-ignore */ `${backend}/middleware/body-errors`),
    import(/* @vite-ignore */ `${backend}/services/db`),
  ]) as [Pick<Hub, 'syncRouter'>, Pick<Hub, 'bodyTooLargeHandler'>, Pick<Hub, 'initDb' | 'closeDb'>];
  return { ...routes, ...middleware, ...services };
}

const realFetch = globalThis.fetch;
let hub: Hub;
let temporaryRoot: string;
let server: Server;
let hubUrl: string;

/** Stands in for requireAuth: the bearer token is the user. */
const bearerIsUser: RequestHandler = (req, _res, next) => {
  const userId = req.header('authorization')?.replace(/^Bearer /, '');
  if (userId) Object.assign(req, { user: { userId, username: userId, role: 'user', exp: Number.MAX_SAFE_INTEGER } });
  next();
};

beforeAll(async () => {
  hub = await loadHub();
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-sync-devices-'));
  await hub.initDb(path.join(temporaryRoot, 'photolib.db'));
  const app = express();
  app.use('/api/sync', bearerIsUser, hub.syncRouter);
  app.use(hub.bodyTooLargeHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  hub.closeDb();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

async function device(user: string) {
  const storage = await MemoryStorage.create();
  const repos = buildRepositories(storage, () => undefined);
  const synced = new SyncedStorage(storage, { serverUrl: hubUrl, token: user });
  return { storage, repos, synced };
}

/** Write on a device whose clock reads `clock`. */
function at(clock: number, write: () => void): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  try {
    write();
  } finally {
    vi.useRealTimers();
  }
}

function recordPushes(): string[][] {
  const pushes: string[][] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const body = JSON.parse(init.body) as Record<string, Array<Record<string, unknown>>>;
      pushes.push(Object.values(body).flat().map((row) => String(row.contentHash ?? row.syncId ?? row.id)));
    }
    return realFetch(input, init);
  });
  return pushes;
}

function editCount(storage: MemoryStorage): number {
  return Number(storage.db.exec('SELECT COUNT(*) FROM edits')[0].values[0][0]);
}

describe('two devices against the hub', () => {
  it('hands each device the rows of the other whatever their clocks say, and never echoes a pulled row', async () => {
    const user = 'clock-drift';
    const a = await device(user);
    const b = await device(user);
    const noon = Date.UTC(2026, 8, 11, 12);
    const minutes = (n: number) => n * 60 * 1000;
    // Device B's clock runs 30 minutes behind device A's.
    const bClock = (realTime: number) => realTime - minutes(30);
    const pushes = recordPushes();

    at(noon, () => a.repos.edits.upsert({ contentHash: 'from-a', adjustments: { exposure: 1 } as Adjustments }));
    expect((await a.synced.sync()).pushed.edits).toBe(1);
    expect((await b.synced.sync()).pulled.edits).toBe(1);
    expect(pushes).toEqual([['from-a']]);

    // B edits offline five minutes later, stamped 11:35: below the 12:00 it
    // pulled, which the old push cursor (max updatedAt sent) would have skipped.
    at(bClock(noon + minutes(5)), () => b.repos.edits.upsert({ contentHash: 'from-b', adjustments: { exposure: 2 } as Adjustments }));
    const bPush = await b.synced.sync();
    expect(bPush.errors).toEqual([]);
    expect(bPush.pushed.edits).toBe(1);

    // A pulled up to its own 12:00 row; the old pull cursor (max updatedAt
    // seen) would never have handed it B's 11:35 row.
    const aPull = await a.synced.sync();
    expect(aPull.pulled.edits).toBe(1);
    expect(a.repos.edits.getMaster('from-b')?.adjustments).toEqual({ exposure: 2 });

    // A's next write reaches B, and no cycle sent a pulled row back.
    at(noon + minutes(6), () => a.repos.edits.upsert({ contentHash: 'from-a-2', adjustments: { exposure: 3 } as Adjustments }));
    await a.synced.sync();
    expect((await b.synced.sync()).pulled.edits).toBe(1);
    expect(b.repos.edits.getMaster('from-a-2')).not.toBeNull();
    expect(pushes).toEqual([['from-a'], ['from-b'], ['from-a-2']]);
  });

  it('pages a 1200-row first pull and resumes at the last watermark after an abort between pages', async () => {
    const user = 'first-pull';
    const a = await device(user);
    for (let index = 0; index < 1200; index += 1) {
      a.repos.edits.upsert({ contentHash: `h${index}`, adjustments: { exposure: index } as Adjustments });
    }
    const aPush = await a.synced.sync();
    expect(aPush.errors).toEqual([]);
    expect(aPush.pushed.edits).toBe(1200);

    const c = await device(user);
    const pages: Array<{ afterRevision: string | null; limit: string | null; rows: number; nextRevision: number }> = [];
    let aborted = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/edits') && (init?.method ?? 'GET') === 'GET') {
        if (pages.length === 1 && !aborted) {
          aborted = true;
          throw new TypeError('network down');
        }
        const response = await realFetch(input, init);
        const body = await response.clone().json() as { edits: unknown[]; nextRevision: number };
        pages.push({
          afterRevision: url.searchParams.get('afterRevision'),
          limit: url.searchParams.get('limit'),
          rows: body.edits.length,
          nextRevision: body.nextRevision,
        });
        return response;
      }
      return realFetch(input, init);
    });

    const first = await c.synced.sync();
    expect(first.errors).toEqual([{ phase: 'pull', table: 'edits', error: 'network down' }]);
    expect(editCount(c.storage)).toBe(500);

    const second = await c.synced.sync();
    expect(second.errors).toEqual([]);
    expect(second.pulled.edits).toBe(700);
    expect(second.pushed.edits).toBe(0);
    expect(editCount(c.storage)).toBe(1200);

    expect(pages.map((page) => page.rows)).toEqual([500, 500, 200]);
    for (const page of pages) {
      expect(page.limit).toBe(String(SYNC_LIMITS.pullPageRows));
      expect(page.rows).toBeLessThanOrEqual(SYNC_LIMITS.pullPageRows);
    }
    expect(pages.map((page) => page.afterRevision)).toEqual([
      '0', String(pages[0].nextRevision), String(pages[1].nextRevision),
    ]);
  });
});
