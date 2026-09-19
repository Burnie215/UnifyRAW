import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  config, getBackendUrl, hasBackend, setBackendUrl, validateBackendUrl,
  type BackendUrlCheck,
} from './config';
import { stubOnlineBuild, stubSelfhostBuild, unstubBuild } from '../test/build';

afterEach(unstubBuild);

describe('build mode', () => {
  it('reads VITE_MODE=hosted as the selfhost build', () => {
    stubSelfhostBuild();
    expect(config.mode).toBe('hosted');
    expect(hasBackend()).toBe(true);
  });

  it('reads any other VITE_MODE as the online build', () => {
    stubOnlineBuild();
    expect(config.mode).toBe('online');
    expect(hasBackend()).toBe(false);
  });

  // config.mode is a getter. Were it ever a constant, every
  // stubSelfhostBuild() in the suite would silently test the online build.
  it('follows a VITE_MODE stubbed after the module was imported', () => {
    stubOnlineBuild();
    expect(config.mode).toBe('online');
    vi.stubEnv('VITE_MODE', 'hosted');
    expect(config.mode).toBe('hosted');
  });

  it('still honours the window flag of installations built before VITE_MODE', () => {
    vi.stubEnv('VITE_MODE', '');
    vi.stubGlobal('window', { location: { origin: 'https://app.test' }, __PHOTOLIB_SELFHOSTED__: true });
    expect(config.mode).toBe('hosted');
  });
});

/**
 * The table of ONLINE_MODE_PLAN §P9: which addresses a user may enter as this
 * app's backend. `empty` is not an error, it clears the override.
 */
describe('validateBackendUrl', () => {
  const APP_ORIGIN = 'https://app.unifyraw.com';
  const DEV_ORIGIN = 'http://localhost:5173';

  const cases: ReadonlyArray<readonly [string, string, BackendUrlCheck]> = [
    ['', APP_ORIGIN, { ok: false, reason: 'empty' }],
    ['not-a-url', APP_ORIGIN, { ok: false, reason: 'invalid' }],
    ['ftp://files.example.test', APP_ORIGIN, { ok: false, reason: 'invalid' }],
    ['http://192.168.1.50:3000', APP_ORIGIN, { ok: false, reason: 'mixed-content' }],
    ['http://192.168.1.50:3000', DEV_ORIGIN, { ok: true, url: 'http://192.168.1.50:3000' }],
    ['https://app.unifyraw.com/', APP_ORIGIN, { ok: false, reason: 'own-origin' }],
    ['https://photos.example.com/', APP_ORIGIN, { ok: true, url: 'https://photos.example.com' }],
  ];

  it.each(cases)('judges %o entered on %s', (input, pageOrigin, expected) => {
    expect(validateBackendUrl(input, pageOrigin)).toEqual(expected);
  });
});

describe('backend url override', () => {
  function installLocalStorage(): void {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    } satisfies Storage);
  }

  // The field under Settings writes exactly this, and hasBackend() is what
  // decoder, transport and the /api guard read afterwards.
  it('makes the online build reach a backend, and stops again when cleared', () => {
    stubOnlineBuild();
    installLocalStorage();
    expect(hasBackend()).toBe(false);

    setBackendUrl('https://photos.example.com/');
    expect(config.backendUrl).toBe('https://photos.example.com');
    expect(hasBackend()).toBe(true);

    setBackendUrl('');
    expect(getBackendUrl()).toBe('');
    expect(hasBackend()).toBe(false);
  });
});
