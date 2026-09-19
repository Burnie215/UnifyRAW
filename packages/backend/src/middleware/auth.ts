import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getDb } from '../services/db.js';

/**
 * Simple JWT-like token auth for hosted mode.
 * HMAC-SHA256 signed, scrypt-hashed passwords.
 */

export type AuthRole = 'admin' | 'user';
export type AuthMode = 'required' | 'disabled';

/**
 * Resolve the effective auth mode once, consistently, for every backend
 * surface. Hosted and sync-only deployments fail closed. Local development
 * must opt out explicitly with AUTH_MODE=disabled.
 */
export function getAuthMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  if (env.SYNC_ONLY === 'true') {
    if (env.AUTH_MODE === 'disabled') {
      throw new Error('AUTH_MODE=disabled is not allowed when SYNC_ONLY=true');
    }
    return 'required';
  }

  if (env.AUTH_MODE !== undefined) {
    if (env.AUTH_MODE === 'required' || env.AUTH_MODE === 'disabled') return env.AUTH_MODE;
    throw new Error('AUTH_MODE must be either "required" or "disabled"');
  }

  // MODE itself defaults to hosted in index.ts, so the security decision must
  // use the same default instead of reading only the raw environment value.
  return (env.MODE ?? 'hosted') === 'hosted' ? 'required' : 'disabled';
}

export function isAuthRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return getAuthMode(env) === 'required';
}

export function isRegistrationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTH_REGISTRATION_ENABLED === 'true';
}

export function validateAuthConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const authRequired = isAuthRequired(env);
  const secret = env.AUTH_SECRET;
  if (authRequired && (!secret || secret.length < 32)) {
    throw new Error(
      'AUTH_SECRET must be set to a persistent string of at least 32 characters ' +
      'when authentication is required',
    );
  }
}

let cachedSecret: string | null = null;

function loadSecret(): string {
  if (cachedSecret) return cachedSecret;
  const fromEnv = process.env.AUTH_SECRET;
  if (fromEnv && fromEnv.length >= 32) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  validateAuthConfiguration();

  // Explicit local/dev mode: tokens are not required, but keeping a stable
  // process-local secret makes the auth endpoints deterministic if exercised.
  cachedSecret = crypto.randomBytes(32).toString('hex');
  return cachedSecret;
}

const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24h

export interface TokenPayload {
  userId: string;
  username: string;
  role: AuthRole;
  exp: number;
  /** users.tokenVersion at issue time; bumping it revokes the token. */
  tv: number;
}

export const ANON_USER_ID = '_anon';

/** Return the authenticated owner, or the single-user local owner. */
export function getRequestUserId(req: Request): string {
  const user = (req as Request & { user?: TokenPayload }).user;
  return user?.userId ?? ANON_USER_ID;
}

function parsePayload(p: unknown): TokenPayload | null {
  if (typeof p !== 'object' || p === null) return null;
  const o = p as Record<string, unknown>;
  if (
    typeof o.userId !== 'string'
    || typeof o.username !== 'string'
    || typeof o.exp !== 'number'
    || !Number.isFinite(o.exp)
  ) return null;
  if (o.tv !== undefined && (typeof o.tv !== 'number' || !Number.isSafeInteger(o.tv))) return null;

  // Tokens issued before role support remain valid for sync, but never gain
  // administrator privileges implicitly. A fresh login issues a role token.
  const role: AuthRole = o.role === 'admin' ? 'admin' : 'user';
  // Tokens from before token versions count as version 0, the column default,
  // so deploying revocation does not sign every device out.
  return { userId: o.userId, username: o.username, role, exp: o.exp, tv: o.tv ?? 0 };
}

export function createToken(
  userId: string,
  username: string,
  role: AuthRole,
  tokenVersion: number,
): string {
  const payload: TokenPayload = {
    userId,
    username,
    role,
    exp: Date.now() + TOKEN_EXPIRY,
    tv: tokenVersion,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', loadSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;

  const expectedSig = crypto.createHmac('sha256', loadSecret()).update(data).digest('base64url');

  // Timing-safe comparison to prevent signature oracle attacks.
  const sigBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expectedSig, 'base64url');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const payload = parsePayload(JSON.parse(Buffer.from(data, 'base64url').toString()));
    if (!payload) return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Password hashing with scrypt (Node builtin, memory-hard KDF).
 * Format: scrypt$N$r$p$salt$hash (all params encoded for future-proofing).
 */

const SCRYPT_N = 16384;  // CPU/memory cost
const SCRYPT_R = 8;      // block size
const SCRYPT_P = 1;      // parallelization
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALTLEN = 16;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SCRYPT_SALTLEN);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT_SALTLEN);
  const hash = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Async login verifier so scrypt cannot block the single Express event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  try {
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    const hash = await new Promise<Buffer>((resolve, reject) => {
      crypto.scrypt(password, salt, expected.length, { N, r, p }, (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      });
    });
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch {
    return false;
  }
}

/** Express middleware requiring a valid token unless local mode opted out. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!isAuthRequired()) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  if (currentTokenVersion(payload.userId) !== payload.tv) {
    res.status(401).json({ error: 'Token revoked' });
    return;
  }

  (req as Request & { user?: TokenPayload }).user = payload;
  next();
}

/** The user's token version, or null when the account no longer exists. */
export function currentTokenVersion(userId: string): number | null {
  const stmt = getDb().prepare('SELECT tokenVersion FROM users WHERE id = ?');
  try {
    stmt.bind([userId]);
    return stmt.step() ? Number(stmt.getAsObject().tokenVersion) : null;
  } finally {
    stmt.free();
  }
}

/** Require an administrator for global filesystem/network resources. */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAuthRequired()) {
    next();
    return;
  }

  requireAuth(req, res, () => {
    const user = (req as Request & { user?: TokenPayload }).user;
    if (user?.role !== 'admin') {
      res.status(403).json({ error: 'Administrator access required' });
      return;
    }
    next();
  });
}
