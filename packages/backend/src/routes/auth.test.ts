import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express, { type Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getAuthMode,
  hashPassword,
  requireAdmin,
  requireAuth,
  type TokenPayload,
  validateAuthConfiguration,
} from '../middleware/auth.js';
import { initializeAuthAccounts } from '../services/auth-accounts.js';
import { closeDb, getDb, initDb } from '../services/db.js';
import { bodyTooLargeHandler } from '../middleware/body-errors.js';
import { authRouter } from './auth.js';

const ENV_KEYS = [
  'MODE', 'SYNC_ONLY', 'AUTH_MODE', 'AUTH_SECRET',
  'AUTH_BOOTSTRAP_USERNAME', 'AUTH_BOOTSTRAP_PASSWORD',
  'AUTH_REGISTRATION_ENABLED',
] as const;
const AUTH_SECRET = 'test-secret-that-is-deliberately-longer-than-32-characters';
// Each failed login runs one scrypt; fifty of them outlast the default timeout.
const SLOW_TEST_MS = 60_000;

let previousEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;
let temporaryRoot: string;
let server: Server;
let baseUrl: string;
let adminToken: string;

beforeAll(async () => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.MODE = 'hosted';
  delete process.env.SYNC_ONLY;
  process.env.AUTH_MODE = 'required';
  process.env.AUTH_SECRET = AUTH_SECRET;
  process.env.AUTH_BOOTSTRAP_USERNAME = 'admin';
  process.env.AUTH_BOOTSTRAP_PASSWORD = 'correct horse battery staple';
  process.env.AUTH_REGISTRATION_ENABLED = 'false';

  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-auth-api-'));
  await initDb(path.join(temporaryRoot, 'photolib.db'));
  expect(initializeAuthAccounts().createdAdmin).toBe(true);

  const app = express();
  // One reverse proxy in front: X-Forwarded-For names the client.
  app.set('trust proxy', 1);
  app.use('/api/auth', authRouter);
  app.use(bodyTooLargeHandler);
  app.get('/api/admin-only', requireAdmin, (_req, res) => res.json({ ok: true }));
  // Token validity is a property of requireAuth, not of a route. /api/auth/me
  // was the only endpoint that showed it and had no client (F116), so the
  // revocation tests probe the guard here instead.
  app.get('/api/session', requireAuth, (req: Request, res) => {
    res.json((req as Request & { user?: TokenPayload }).user ?? null);
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  adminToken = await login('admin', 'correct horse battery staple');
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  closeDb();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('authentication policy', () => {
  it('fails closed for hosted and sync-only modes', () => {
    expect(getAuthMode({ MODE: 'hosted' })).toBe('required');
    expect(getAuthMode({ SYNC_ONLY: 'true' })).toBe('required');
    expect(() => getAuthMode({ SYNC_ONLY: 'true', AUTH_MODE: 'disabled' })).toThrow();
    expect(() => validateAuthConfiguration({ MODE: 'hosted' })).toThrow('AUTH_SECRET');
    expect(getAuthMode({ MODE: 'local', AUTH_MODE: 'disabled' })).toBe('disabled');
  });

  it('keeps registration closed and exposes that capability to the client', async () => {
    const config = await fetch(`${baseUrl}/api/auth/config`);
    expect(await config.json()).toEqual({ authRequired: true, registrationEnabled: false });

    const registration = await post('/api/auth/register', {
      username: 'attacker',
      password: 'long-enough-password',
    });
    expect(registration.response.status).toBe(403);
    expect(registration.body.code).toBe('REGISTRATION_DISABLED');
  });

  it('authenticates the bootstrap administrator and protects admin routes', async () => {
    const anonymous = await fetch(`${baseUrl}/api/admin-only`);
    expect(anonymous.status).toBe(401);

    const identified = await session(adminToken);
    expect(identified.response.status).toBe(200);
    expect(identified.body).toMatchObject({ username: 'admin', role: 'admin' });
    // The dead /me route is gone; the guard behind it still answers.
    expect((await fetch(`${baseUrl}/api/auth/me`, { headers: bearer(adminToken) })).status).toBe(404);

    const allowed = await fetch(`${baseUrl}/api/admin-only`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(allowed.status).toBe(200);
  });

  it('allows explicit sync-hub registration without granting admin access', async () => {
    process.env.AUTH_REGISTRATION_ENABLED = 'true';
    try {
      const registration = await post('/api/auth/register', {
        username: 'sync-user',
        password: 'long-enough-password',
      });
      expect(registration.response.status).toBe(200);
      expect(registration.body.role).toBe('user');

      const denied = await fetch(`${baseUrl}/api/admin-only`, {
        headers: { Authorization: `Bearer ${String(registration.body.token)}` },
      });
      expect(denied.status).toBe(403);
    } finally {
      process.env.AUTH_REGISTRATION_ENABLED = 'false';
    }
  });

  it('refuses a login body over 8 KB before it reads the credentials', async () => {
    const login = await post('/api/auth/login', { username: 'admin', password: 'x'.repeat(20 * 1024) });
    expect(login.response.status).toBe(413);
    expect(login.body).toEqual({ error: 'payload too large', code: 'body-too-large' });
  });
});

describe('login rate limits', () => {
  it('locks a username after ten failures from any address, and only that username', async () => {
    createUser('limited-user', 'limited-user-password');
    createUser('bystander', 'bystander-password');

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const from = attempt % 2 === 0 ? '10.0.1.1' : '10.0.1.2';
      const failed = await post('/api/auth/login', { username: 'limited-user', password: 'wrong' }, forwardedFor(from));
      statuses.push(failed.response.status);
    }
    expect(statuses).toEqual(Array(10).fill(401));

    const eleventh = await post('/api/auth/login', { username: 'limited-user', password: 'wrong' }, forwardedFor('10.0.1.2'));
    expect(eleventh.response.status).toBe(429);
    expect(Number(eleventh.response.headers.get('retry-after'))).toBeGreaterThan(0);

    // The lock is on the name: the right password from a fresh address is refused too,
    // and so is the name spelled with other case and surrounding blanks.
    const rightPassword = await post('/api/auth/login', { username: 'limited-user', password: 'limited-user-password' }, forwardedFor('10.0.1.3'));
    expect(rightPassword.response.status).toBe(429);
    const respelled = await post('/api/auth/login', { username: ' LIMITED-USER ', password: 'wrong' }, forwardedFor('10.0.1.4'));
    expect(respelled.response.status).toBe(429);

    const bystander = await post('/api/auth/login', { username: 'bystander', password: 'bystander-password' }, forwardedFor('10.0.1.1'));
    expect(bystander.response.status).toBe(200);
  }, SLOW_TEST_MS);

  it('locks an address after fifty failures across usernames, and only that address', async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const failed = await post('/api/auth/login', { username: `sprayed-${attempt}`, password: 'Summer2026!' }, forwardedFor('10.0.2.1'));
      expect(failed.response.status).toBe(401);
    }

    const blocked = await post('/api/auth/login', { username: 'sprayed-50', password: 'Summer2026!' }, forwardedFor('10.0.2.1'));
    expect(blocked.response.status).toBe(429);
    expect(Number(blocked.response.headers.get('retry-after'))).toBeGreaterThan(0);

    const elsewhere = await post('/api/auth/login', { username: 'sprayed-51', password: 'Summer2026!' }, forwardedFor('10.0.2.2'));
    expect(elsewhere.response.status).toBe(401);
  }, SLOW_TEST_MS);
});

describe('password change and token revocation', () => {
  it('changes the password only against the current one and revokes every older token', async () => {
    createUser('changer', 'old-password-123');
    const thisDevice = await login('changer', 'old-password-123');
    const otherDevice = await login('changer', 'old-password-123');

    const wrong = await post('/api/auth/password', {
      currentPassword: 'not-the-password',
      newPassword: 'new-password-456',
    }, bearer(thisDevice));
    expect(wrong.response.status).toBe(401);
    expect(await sessionStatus(thisDevice)).toBe(200);

    const tooShort = await post('/api/auth/password', {
      currentPassword: 'old-password-123',
      newPassword: 'short',
    }, bearer(thisDevice));
    expect(tooShort.response.status).toBe(400);

    const changed = await post('/api/auth/password', {
      currentPassword: 'old-password-123',
      newPassword: 'new-password-456',
    }, bearer(thisDevice));
    expect(changed.response.status).toBe(200);
    const fresh = String(changed.body.token);
    expect(fresh).not.toBe(thisDevice);

    const revoked = await session(thisDevice);
    expect(revoked.response.status).toBe(401);
    expect(revoked.body.error).toBe('Token revoked');
    expect(await sessionStatus(otherDevice)).toBe(401);
    expect(await sessionStatus(fresh)).toBe(200);

    const oldPassword = await post('/api/auth/login', { username: 'changer', password: 'old-password-123' });
    expect(oldPassword.response.status).toBe(401);
    expect(await sessionStatus(await login('changer', 'new-password-456'))).toBe(200);
  }, SLOW_TEST_MS);

  it('counts wrong current passwords against the login limit of the account', async () => {
    createUser('guessed', 'guessed-password');
    const token = await login('guessed', 'guessed-password');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const guess = await post('/api/auth/password', {
        currentPassword: `guess-${attempt}`,
        newPassword: 'attacker-password',
      }, { ...bearer(token), ...forwardedFor(`10.0.3.${attempt}`) });
      statuses.push(guess.response.status);
    }
    expect(statuses).toEqual([...Array(10).fill(401), 429]);
    expect(await sessionStatus(token)).toBe(200);
  }, SLOW_TEST_MS);

  it('signs out every device on logout-all until the next login', async () => {
    createUser('leaver', 'leaver-password');
    const first = await login('leaver', 'leaver-password');
    const second = await login('leaver', 'leaver-password');

    const out = await post('/api/auth/logout-all', undefined, bearer(first));
    expect(out.response.status).toBe(204);

    expect(await sessionStatus(first)).toBe(401);
    expect(await sessionStatus(second)).toBe(401);
    const again = await post('/api/auth/logout-all', undefined, bearer(first));
    expect(again.response.status).toBe(401);

    expect(await sessionStatus(await login('leaver', 'leaver-password'))).toBe(200);
  }, SLOW_TEST_MS);

  it('keeps a token from before token versions valid until the account revokes', async () => {
    createUser('veteran', 'veteran-password');
    const userId = String(getDb().exec("SELECT id FROM users WHERE username = 'veteran'")[0].values[0][0]);
    const legacy = signLegacyToken({ userId, username: 'veteran', role: 'user', exp: Date.now() + 60_000 });

    expect(await sessionStatus(legacy)).toBe(200);

    const current = await login('veteran', 'veteran-password');
    expect((await post('/api/auth/logout-all', undefined, bearer(current))).response.status).toBe(204);
    expect(await sessionStatus(legacy)).toBe(401);
  }, SLOW_TEST_MS);
});

function createUser(username: string, password: string): void {
  getDb().run(
    `INSERT INTO users (id, username, passwordHash, salt, role, createdAt)
     VALUES (?, ?, ?, '', 'user', ?)`,
    [crypto.randomUUID(), username, hashPassword(password), Date.now()],
  );
}

/** A token as the backend signed it before tokens carried a version. */
function signLegacyToken(payload: Record<string, unknown>): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

async function login(username: string, password: string): Promise<string> {
  const result = await post('/api/auth/login', { username, password });
  expect(result.response.status).toBe(200);
  return String(result.body.token);
}

async function session(token: string): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/session`, { headers: bearer(token) });
  return { response, body: await readBody(response) };
}

async function sessionStatus(token: string): Promise<number> {
  return (await session(token)).response.status;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function forwardedFor(address: string): Record<string, string> {
  return { 'X-Forwarded-For': address };
}

async function post(endpoint: string, body: unknown, headers: Record<string, string> = {}): Promise<{
  response: Response;
  body: Record<string, unknown>;
}> {
  const response = await fetch(baseUrl + endpoint, {
    method: 'POST',
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, body: await readBody(response) };
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? JSON.parse(text) as Record<string, unknown> : {};
}
