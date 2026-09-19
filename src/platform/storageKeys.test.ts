import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERSISTED_STATE_PREFIX,
  SESSION_KEYS,
  STORAGE_KEYS,
  hasStoredAppState,
  resetAllStorageKeys,
} from './storageKeys';
import { apiFetch } from './api';
import { readSyncSettings, writeSyncSettings } from '../storage/syncSettings';
import { stubSelfhostBuild, unstubBuild } from '../test/build';

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTER = path.join(SRC_DIR, 'platform', 'storageKeys.ts');
const APP_ORIGIN = 'https://photo.example.test';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'locales' && entry !== '__screenshots__') out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.|\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * localStorage keeps its entries as own properties, which is how
 * resetAllStorageKeys and hasStoredAppState enumerate it. A Map-backed fake
 * would answer Object.keys with its own methods, so the data lives on the
 * instance here too.
 */
class FakeStorage {
  getItem(key: string): string | null {
    const value = (this as unknown as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : null;
  }

  setItem(key: string, value: string): void {
    (this as unknown as Record<string, string>)[key] = String(value);
  }

  removeItem(key: string): void {
    delete (this as unknown as Record<string, unknown>)[key];
  }

  clear(): void {
    for (const key of Object.keys(this)) this.removeItem(key);
  }

  key(index: number): string | null {
    return Object.keys(this)[index] ?? null;
  }

  get length(): number {
    return Object.keys(this).length;
  }
}

function installFakeStorage(): FakeStorage {
  const local = new FakeStorage();
  vi.stubGlobal('localStorage', local as unknown as Storage);
  vi.stubGlobal('sessionStorage', new FakeStorage() as unknown as Storage);
  return local;
}

describe('storage key register', () => {
  it('holds every key name exactly once', () => {
    const values = [...Object.values(STORAGE_KEYS), ...Object.values(SESSION_KEYS)];
    expect(new Set(values).size).toBe(values.length);
  });

  it('is the only file that spells a storage key out', () => {
    const keys = [...Object.values(STORAGE_KEYS), ...Object.values(SESSION_KEYS)];
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      if (file === REGISTER) continue;
      const text = readFileSync(file, 'utf8');
      for (const key of keys) {
        if (text.includes(`'${key}'`) || text.includes(`"${key}"`) || text.includes(`\`${key}\``)) {
          offenders.push(`${key} (${path.relative(SRC_DIR, file)})`);
        }
      }
    }
    expect(offenders.sort()).toEqual([]);
  });

  it('leaves no string literal in a localStorage call', () => {
    const literalCall = /(localStorage|sessionStorage)\.(get|set|remove)Item\(\s*['"`]/;
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      if (file === REGISTER) continue;
      if (literalCall.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(SRC_DIR, file));
    }
    expect(offenders.sort()).toEqual([]);
  });
});

describe('sync settings', () => {
  beforeEach(() => { installFakeStorage(); });
  afterEach(() => { unstubBuild(); vi.unstubAllGlobals(); });

  it('hands the api the same shape it stores', async () => {
    stubSelfhostBuild(APP_ORIGIN);
    writeSyncSettings({ serverUrl: APP_ORIGIN, token: 'backend-token' });
    expect(readSyncSettings()).toEqual({ serverUrl: APP_ORIGIN, token: 'backend-token' });

    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await apiFetch('/api/files');

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer backend-token');
  });

  it('forgets the settings when they are written away', () => {
    writeSyncSettings({ serverUrl: APP_ORIGIN, token: 'backend-token' });
    writeSyncSettings(null);
    expect(readSyncSettings()).toBeNull();
  });

  it('reads a record without a token', () => {
    writeSyncSettings({ serverUrl: APP_ORIGIN });
    expect(readSyncSettings()).toEqual({ serverUrl: APP_ORIGIN, token: undefined });
  });
});

describe('resetAllStorageKeys', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('drops registered and persisted-state keys, keeps foreign ones', () => {
    const local = installFakeStorage();
    local.setItem(STORAGE_KEYS.uiPreferences, '{}');
    local.setItem(`${PERSISTED_STATE_PREFIX}gridMode`, '"tiles"');
    local.setItem('some.other.app', 'keep me');
    sessionStorage.setItem(SESSION_KEYS.staleAssetReload, '1');

    resetAllStorageKeys();

    expect(local.getItem(STORAGE_KEYS.uiPreferences)).toBeNull();
    expect(local.getItem(`${PERSISTED_STATE_PREFIX}gridMode`)).toBeNull();
    expect(local.getItem('some.other.app')).toBe('keep me');
    expect(sessionStorage.getItem(SESSION_KEYS.staleAssetReload)).toBeNull();
  });

  it('sees stored app state only while a key of this app exists', () => {
    const local = installFakeStorage();
    expect(hasStoredAppState()).toBe(false);
    local.setItem('some.other.app', 'x');
    expect(hasStoredAppState()).toBe(false);
    local.setItem(STORAGE_KEYS.phase2MigrationToastShown, '1');
    expect(hasStoredAppState([STORAGE_KEYS.phase2MigrationToastShown])).toBe(false);
    expect(hasStoredAppState()).toBe(true);
  });
});
