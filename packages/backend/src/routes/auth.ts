import { Router, json as expressJson } from 'express';
import type { Request, Response } from 'express';
import { getDb, saveToFile } from '../services/db.js';
import {
  createToken,
  currentTokenVersion,
  hashPasswordAsync,
  isAuthRequired,
  isRegistrationEnabled,
  requireAuth,
  type AuthRole,
  type TokenPayload,
  verifyPasswordAsync,
} from '../middleware/auth.js';
import { tr } from '../util/i18n.js';
import crypto from 'crypto';

export const authRouter = Router();
authRouter.use(expressJson({ limit: '8kb' }));

const loginFailures = new Map<string, number[]>();
const registrationAttempts = new Map<string, number[]>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES_PER_USER = 10;
const LOGIN_MAX_FAILURES_PER_IP = 50;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const REGISTRATION_MAX_ATTEMPTS = 5;
const MAX_TRACKED_CLIENTS = 10_000;
const MAX_USERNAME_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 1024;
const MIN_PASSWORD_LENGTH = 8;
// Unknown accounts still perform one scrypt operation so response timing does
// not reveal whether a username exists. The expected bytes need not represent
// a real password; comparison will simply fail.
const DUMMY_SCRYPT_HASH = `scrypt$16384$8$1$${'00'.repeat(16)}$${'00'.repeat(64)}`;

interface UserRow {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  role: AuthRole;
  tokenVersion: number;
}

/** Legacy SHA-256 verifier for auto-migration of pre-scrypt accounts. */
function verifyLegacy(password: string, salt: string, storedHash: string): boolean {
  const hash = crypto.createHash('sha256').update(password + salt).digest('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Send generic error without leaking internal details. */
function sendError(res: Response, status: number, message: string, e?: unknown) {
  if (e) console.error('[auth]', message, e);
  res.status(status).json({ error: message });
}

/** Public capability discovery used by the account UI. */
authRouter.get('/config', (_req, res) => {
  res.json({
    authRequired: isAuthRequired(),
    registrationEnabled: isRegistrationEnabled(),
  });
});

/** POST /api/auth/register — disabled unless explicitly enabled for a sync hub. */
authRouter.post('/register', async (req: Request, res: Response) => {
  if (!isRegistrationEnabled()) {
    res.status(403).json({ error: 'Registration is disabled', code: 'REGISTRATION_DISABLED' });
    return;
  }

  const db = getDb();
  const { username, password } = req.body;
  const [rateLimitKey] = rateLimitKeys(req);
  const retryAfter = blockedForSeconds(
    registrationAttempts,
    rateLimitKey,
    Date.now(),
    REGISTRATION_WINDOW_MS,
    REGISTRATION_MAX_ATTEMPTS,
  );
  if (retryAfter > 0) {
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many registration attempts' });
    return;
  }
  recordAttempt(registrationAttempts, rateLimitKey, Date.now(), REGISTRATION_WINDOW_MS);

  if (!validCredentialShape(username, password)) {
    res.status(400).json({ error: tr(req, 'auth.userPassRequired') });
    return;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: tr(req, 'auth.passwordTooShort') });
    return;
  }

  try {
    if (usernameExists(username)) {
      res.status(409).json({ error: tr(req, 'auth.userExists') });
      return;
    }

    const id = crypto.randomUUID();
    // scrypt format already includes salt; keep salt column empty for new rows.
    const hash = await hashPasswordAsync(password);

    // Hashing yields the event loop. Re-check before the synchronous insert so
    // concurrent requests for the same username receive a clean conflict.
    if (usernameExists(username)) {
      res.status(409).json({ error: tr(req, 'auth.userExists') });
      return;
    }

    db.run(
      `INSERT INTO users (id, username, passwordHash, salt, role, createdAt)
       VALUES (?, ?, ?, ?, 'user', ?)`,
      [id, username, hash, '', Date.now()],
    );
    saveToFile();
    registrationAttempts.delete(rateLimitKey);

    const token = createToken(id, username, 'user', 0);
    res.json({ token, userId: id, username, role: 'user' });
  } catch (e) {
    sendError(res, 500, 'Registrierung fehlgeschlagen', e);
  }
});

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Auto-migrates legacy SHA-256 hashes to scrypt on successful login.
 */
authRouter.post('/login', async (req: Request, res: Response) => {
  const db = getDb();
  const { username, password } = req.body;

  if (!validCredentialShape(username, password)) {
    res.status(400).json({ error: tr(req, 'auth.userPassRequired') });
    return;
  }

  const keys = rateLimitKeys(req, username);
  const retryAfter = loginBlockedForSeconds(keys, Date.now());
  if (retryAfter > 0) {
    sendTooManyFailures(res, retryAfter);
    return;
  }

  try {
    const user = findUser('username', username);
    if (!user) {
      await verifyPasswordAsync(password, DUMMY_SCRYPT_HASH);
      recordLoginFailure(keys, Date.now());
      res.status(401).json({ error: tr(req, 'auth.invalidCredentials') });
      return;
    }

    const { ok, legacy } = await checkPassword(password, user);
    if (!ok) {
      recordLoginFailure(keys, Date.now());
      res.status(401).json({ error: tr(req, 'auth.invalidCredentials') });
      return;
    }

    // Transparent upgrade to scrypt.
    if (legacy) {
      const newHash = await hashPasswordAsync(password);
      db.run('UPDATE users SET passwordHash = ?, salt = ? WHERE id = ?',
        [newHash, '', user.id]);
      saveToFile();
    }

    // Only the name's counter: a login to an attacker's own account must not
    // reset the counter of the address it sprays from.
    loginFailures.delete(userRateLimitKey(username));
    const role: AuthRole = user.role === 'admin' ? 'admin' : 'user';
    const token = createToken(user.id, user.username, role, user.tokenVersion);
    res.json({ token, userId: user.id, username: user.username, role });
  } catch (e) {
    sendError(res, 500, 'Login fehlgeschlagen', e);
  }
});

/**
 * POST /api/auth/password
 * Body: { currentPassword, newPassword }
 * Revokes every token of the account and answers with a fresh one for the
 * calling device. Wrong current passwords count against the login limit.
 */
authRouter.post('/password', requireAuth, async (req: Request, res: Response) => {
  const tokenUser = (req as Request & { user?: TokenPayload }).user;
  if (!tokenUser) {
    res.status(401).json({ error: tr(req, 'auth.notAuthenticated') });
    return;
  }
  const { currentPassword, newPassword } = req.body ?? {};
  if (!validPassword(currentPassword) || !validPassword(newPassword)) {
    res.status(400).json({ error: tr(req, 'auth.userPassRequired') });
    return;
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: tr(req, 'auth.passwordTooShort') });
    return;
  }

  const keys = rateLimitKeys(req, tokenUser.username);
  const retryAfter = loginBlockedForSeconds(keys, Date.now());
  if (retryAfter > 0) {
    sendTooManyFailures(res, retryAfter);
    return;
  }

  try {
    const user = findUser('id', tokenUser.userId);
    if (!user) {
      res.status(401).json({ error: tr(req, 'auth.notAuthenticated') });
      return;
    }
    const { ok } = await checkPassword(currentPassword, user);
    if (!ok) {
      recordLoginFailure(keys, Date.now());
      res.status(401).json({ error: tr(req, 'auth.invalidCredentials') });
      return;
    }

    const hash = await hashPasswordAsync(newPassword);
    getDb().run(
      "UPDATE users SET passwordHash = ?, salt = '', tokenVersion = tokenVersion + 1 WHERE id = ?",
      [hash, user.id],
    );
    const tokenVersion = currentTokenVersion(user.id);
    if (tokenVersion === null) {
      res.status(401).json({ error: tr(req, 'auth.notAuthenticated') });
      return;
    }
    saveToFile();
    loginFailures.delete(userRateLimitKey(user.username));

    const role: AuthRole = user.role === 'admin' ? 'admin' : 'user';
    const token = createToken(user.id, user.username, role, tokenVersion);
    res.json({ token, userId: user.id, username: user.username, role });
  } catch (e) {
    sendError(res, 500, 'Passwortwechsel fehlgeschlagen', e);
  }
});

/** POST /api/auth/logout-all — revokes every token of the account, this one included. */
authRouter.post('/logout-all', requireAuth, (req: Request, res: Response) => {
  const tokenUser = (req as Request & { user?: TokenPayload }).user;
  if (!tokenUser) {
    res.status(401).json({ error: tr(req, 'auth.notAuthenticated') });
    return;
  }
  try {
    getDb().run('UPDATE users SET tokenVersion = tokenVersion + 1 WHERE id = ?', [tokenUser.userId]);
    saveToFile();
    res.status(204).end();
  } catch (e) {
    sendError(res, 500, 'Abmelden fehlgeschlagen', e);
  }
});

/**
 * The client address always; with a username also the name, so failures
 * against one account lock that account wherever they come from, and one
 * address spraying many names locks that address.
 */
function rateLimitKeys(req: Request, username?: string): string[] {
  const keys = [`ip:${req.ip || req.socket.remoteAddress || 'unknown'}`];
  if (username !== undefined) keys.push(userRateLimitKey(username));
  return keys;
}

function userRateLimitKey(username: string): string {
  return `user:${username.trim().toLowerCase()}`;
}

function loginBlockedForSeconds(keys: readonly string[], now: number): number {
  return Math.max(0, ...keys.map((key) => blockedForSeconds(
    loginFailures,
    key,
    now,
    LOGIN_WINDOW_MS,
    key.startsWith('user:') ? LOGIN_MAX_FAILURES_PER_USER : LOGIN_MAX_FAILURES_PER_IP,
  )));
}

function recordLoginFailure(keys: readonly string[], now: number): void {
  for (const key of keys) recordAttempt(loginFailures, key, now, LOGIN_WINDOW_MS);
}

function sendTooManyFailures(res: Response, retryAfter: number): void {
  res.set('Retry-After', String(retryAfter));
  res.status(429).json({ error: 'Too many failed login attempts' });
}

function findUser(column: 'id' | 'username', value: string): UserRow | null {
  const stmt = getDb().prepare(
    `SELECT id, username, passwordHash, salt, role, tokenVersion FROM users WHERE ${column} = ?`,
  );
  try {
    stmt.bind([value]);
    return stmt.step() ? stmt.getAsObject() as unknown as UserRow : null;
  } finally {
    stmt.free();
  }
}

/** `legacy` marks a matching SHA-256 hash that should be upgraded to scrypt. */
async function checkPassword(password: string, user: UserRow): Promise<{ ok: boolean; legacy: boolean }> {
  if (user.passwordHash.startsWith('scrypt$')) {
    return { ok: await verifyPasswordAsync(password, user.passwordHash), legacy: false };
  }
  if (user.salt) {
    const ok = verifyLegacy(password, user.salt, user.passwordHash);
    return { ok, legacy: ok };
  }
  return { ok: false, legacy: false };
}

function validPassword(password: unknown): password is string {
  return typeof password === 'string'
    && password.length > 0
    && password.length <= MAX_PASSWORD_LENGTH;
}

function validCredentialShape(username: unknown, password: unknown): username is string {
  return typeof username === 'string'
    && username.length > 0
    && username.length <= MAX_USERNAME_LENGTH
    && validPassword(password);
}

function usernameExists(username: string): boolean {
  const stmt = getDb().prepare('SELECT 1 FROM users WHERE username = ?');
  stmt.bind([username]);
  const exists = stmt.step();
  stmt.free();
  return exists;
}

function blockedForSeconds(
  attempts: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
  maxAttempts: number,
): number {
  const recent = (attempts.get(key) ?? []).filter((at) => now - at < windowMs);
  if (recent.length === 0) attempts.delete(key);
  else attempts.set(key, recent);
  if (recent.length < maxAttempts) return 0;
  return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
}

function recordAttempt(
  attempts: Map<string, number[]>,
  key: string,
  now: number,
  windowMs: number,
): void {
  const recent = (attempts.get(key) ?? []).filter((at) => now - at < windowMs);
  recent.push(now);
  if (!attempts.has(key) && attempts.size >= MAX_TRACKED_CLIENTS) {
    const oldestKey = attempts.keys().next().value as string | undefined;
    if (oldestKey !== undefined) attempts.delete(oldestKey);
  }
  attempts.set(key, recent);
}
