import crypto from 'node:crypto';
import type { Database } from 'sql.js';
import { hashPassword, isAuthRequired, isRegistrationEnabled } from '../middleware/auth.js';
import { getDb, saveToFile } from './db.js';

const MIN_BOOTSTRAP_PASSWORD_LENGTH = 12;

export interface AuthAccountInitialization {
  createdAdmin: boolean;
  userCount: number;
}

/**
 * Ensure a required-auth deployment can never start without an account.
 * Existing databases are left intact; credentials are consulted only when the
 * users table is empty, so they may be removed from the environment later.
 */
export function initializeAuthAccounts(
  env: NodeJS.ProcessEnv = process.env,
): AuthAccountInitialization {
  const db = getDb();
  const userCount = countUsers(db);
  if (userCount > 0) return { createdAdmin: false, userCount };

  const username = env.AUTH_BOOTSTRAP_USERNAME?.trim() ?? '';
  const password = env.AUTH_BOOTSTRAP_PASSWORD ?? '';
  const hasBootstrapInput = username.length > 0 || password.length > 0;

  if (!hasBootstrapInput) {
    const fullHosted = env.SYNC_ONLY !== 'true' && (env.MODE ?? 'hosted') === 'hosted';
    if (isAuthRequired(env) && (fullHosted || !isRegistrationEnabled(env))) {
      throw new Error(
        'No user account exists. Set AUTH_BOOTSTRAP_USERNAME and ' +
        'AUTH_BOOTSTRAP_PASSWORD for the first secure startup',
      );
    }
    return { createdAdmin: false, userCount: 0 };
  }

  validateBootstrapCredentials(username, password);
  db.run(
    `INSERT INTO users (id, username, passwordHash, salt, role, createdAt)
     VALUES (?, ?, ?, '', 'admin', ?)`,
    [crypto.randomUUID(), username, hashPassword(password), Date.now()],
  );
  saveToFile();
  console.log(`[auth] Created bootstrap administrator "${username}"`);
  return { createdAdmin: true, userCount: 1 };
}

function countUsers(db: Database): number {
  const stmt = db.prepare('SELECT COUNT(*) AS count FROM users');
  stmt.step();
  const count = Number(stmt.getAsObject().count ?? 0);
  stmt.free();
  return count;
}

function validateBootstrapCredentials(username: string, password: string): void {
  if (!username || username.length > 128 || hasControlCharacter(username)) {
    throw new Error('AUTH_BOOTSTRAP_USERNAME must be between 1 and 128 printable characters');
  }
  if (password.length < MIN_BOOTSTRAP_PASSWORD_LENGTH) {
    throw new Error(
      `AUTH_BOOTSTRAP_PASSWORD must contain at least ${MIN_BOOTSTRAP_PASSWORD_LENGTH} characters`,
    );
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) return true;
  }
  return false;
}
