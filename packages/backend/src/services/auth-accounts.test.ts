import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, initDb } from './db.js';
import { initializeAuthAccounts } from './auth-accounts.js';

let temporaryRoot: string;

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-auth-bootstrap-'));
  await initDb(path.join(temporaryRoot, 'photolib.db'));
});

afterEach(async () => {
  closeDb();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('authentication account bootstrap', () => {
  it('refuses a hosted deployment with no account or bootstrap credentials', () => {
    expect(() => initializeAuthAccounts({
      MODE: 'hosted',
      AUTH_MODE: 'required',
    })).toThrow('No user account exists');
  });

  it('allows an explicitly open sync hub to create its first normal user', () => {
    expect(initializeAuthAccounts({
      SYNC_ONLY: 'true',
      AUTH_MODE: 'required',
      AUTH_REGISTRATION_ENABLED: 'true',
    })).toEqual({ createdAdmin: false, userCount: 0 });
  });

  it('creates exactly one administrator and ignores later bootstrap changes', () => {
    const first = initializeAuthAccounts({
      MODE: 'hosted',
      AUTH_MODE: 'required',
      AUTH_BOOTSTRAP_USERNAME: 'admin',
      AUTH_BOOTSTRAP_PASSWORD: 'correct horse battery staple',
    });
    expect(first).toEqual({ createdAdmin: true, userCount: 1 });

    const second = initializeAuthAccounts({
      MODE: 'hosted',
      AUTH_MODE: 'required',
      AUTH_BOOTSTRAP_USERNAME: 'other-admin',
      AUTH_BOOTSTRAP_PASSWORD: 'another sufficiently long password',
    });
    expect(second).toEqual({ createdAdmin: false, userCount: 1 });

    const users = getDb().exec('SELECT username, role FROM users');
    expect(users[0].values).toEqual([['admin', 'admin']]);
  });

  it('rejects a weak bootstrap password', () => {
    expect(() => initializeAuthAccounts({
      MODE: 'hosted',
      AUTH_MODE: 'required',
      AUTH_BOOTSTRAP_USERNAME: 'admin',
      AUTH_BOOTSTRAP_PASSWORD: 'too-short',
    })).toThrow('at least 12 characters');
  });
});
