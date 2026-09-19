import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, NoBackendError } from './api';
import { stubOnlineBuild, stubSelfhostBuild, unstubBuild } from '../test/build';

const BACKEND_URL_KEY = 'photolib.backendUrl';
const SYNC_SETTINGS_KEY = 'photolib.storage.sync';
const APP_ORIGIN = 'https://photo.example.test';
const TOKEN = 'backend-token';

/**
 * The backend-authorization tests all describe a build that HAS a backend, so
 * they run as the selfhosted deploy. `selfhosted: false` gets the online build,
 * where apiFetch must refuse rather than call the static host (§P5).
 */
function installBrowserStorage(
  entries: Record<string, string> = {},
  { selfhosted = true }: { selfhosted?: boolean } = {},
): Map<string, string> {
  const values = new Map(Object.entries(entries));
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() {
      return values.size;
    },
  } satisfies Storage;

  if (selfhosted) stubSelfhostBuild(APP_ORIGIN);
  else stubOnlineBuild(APP_ORIGIN);
  vi.stubGlobal('localStorage', storage);
  return values;
}

function syncSettings(serverUrl: string): string {
  return JSON.stringify({ serverUrl, token: TOKEN });
}

function authorizationFrom(fetchMock: ReturnType<typeof vi.fn>): string | null {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return new Headers(init?.headers).get('Authorization');
}

afterEach(unstubBuild);

describe('apiFetch backend authorization', () => {
  it('adds the PhotoLib bearer to a relative same-origin backend path', async () => {
    installBrowserStorage({
      [SYNC_SETTINGS_KEY]: syncSettings(APP_ORIGIN),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/files');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/files');
    expect(authorizationFrom(fetchMock)).toBe(`Bearer ${TOKEN}`);
  });

  it('adds the bearer to an absolute URL on the app origin when the backend is same-origin', async () => {
    installBrowserStorage({
      [SYNC_SETTINGS_KEY]: syncSettings(APP_ORIGIN),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch(`${APP_ORIGIN}/api/files`);

    expect(authorizationFrom(fetchMock)).toBe(`Bearer ${TOKEN}`);
  });

  it('adds the bearer to the explicitly configured backend origin', async () => {
    const backendUrl = 'https://backend.example.test/base';
    installBrowserStorage({
      [BACKEND_URL_KEY]: backendUrl,
      [SYNC_SETTINGS_KEY]: syncSettings(backendUrl),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/files');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${backendUrl}/api/files`);
    expect(authorizationFrom(fetchMock)).toBe(`Bearer ${TOKEN}`);
  });

  it('adds the bearer to an absolute URL on the configured backend origin', async () => {
    const backendUrl = 'https://backend.example.test';
    installBrowserStorage({
      [BACKEND_URL_KEY]: backendUrl,
      [SYNC_SETTINGS_KEY]: syncSettings(backendUrl),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch(`${backendUrl}/api/files`);

    expect(authorizationFrom(fetchMock)).toBe(`Bearer ${TOKEN}`);
  });

  it('never sends the PhotoLib bearer to a foreign absolute URL', async () => {
    installBrowserStorage({
      [SYNC_SETTINGS_KEY]: syncSettings(APP_ORIGIN),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('https://source.example.test/api/assets');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://source.example.test/api/assets');
    expect(authorizationFrom(fetchMock)).toBeNull();
  });

  it('does not overwrite an Authorization header provided by the caller', async () => {
    installBrowserStorage({
      [SYNC_SETTINGS_KEY]: syncSettings(APP_ORIGIN),
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/files', {
      headers: { Authorization: 'Basic caller-credentials' },
    });

    expect(authorizationFrom(fetchMock)).toBe('Basic caller-credentials');
  });
});

describe('apiFetch without a backend (online build)', () => {
  it('refuses a relative backend path instead of fetching the static host', async () => {
    installBrowserStorage({}, { selfhosted: false });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch('/api/files')).rejects.toBeInstanceOf(NoBackendError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an absolute URL that points back at the static host', async () => {
    installBrowserStorage({}, { selfhosted: false });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiFetch(`${APP_ORIGIN}/api/files`)).rejects.toBeInstanceOf(NoBackendError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the path so the failure is readable', async () => {
    installBrowserStorage({}, { selfhosted: false });
    vi.stubGlobal('fetch', vi.fn());

    await expect(apiFetch('/api/raw/smart-preview')).rejects.toThrow(/\/api\/raw\/smart-preview/);
  });

  it('lets a foreign absolute URL through — that is not our backend', async () => {
    installBrowserStorage({}, { selfhosted: false });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('https://source.example.test/api/assets');

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps working when a server URL is configured (§P9)', async () => {
    const backendUrl = 'https://backend.example.test';
    installBrowserStorage({ [BACKEND_URL_KEY]: backendUrl }, { selfhosted: false });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/files');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${backendUrl}/api/files`);
  });
});
