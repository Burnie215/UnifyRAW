/**
 * Platform configuration.
 * - 'hosted': Self-hosted build with a same-origin backend available.
 * - 'online': Static browser build with no implicit backend. Its catalog is
 *   in memory, OPFS or a chosen folder; IndexedDB only persists directory
 *   handles.
 *
 * `VITE_MODE=hosted` (build:selfhost) decides. `window.__PHOTOLIB_SELFHOSTED__`
 * is only read as a leftover of existing installations; no build has set it
 * since 4bf5a97.
 *
 * `backendUrl` resolution order:
 *   1. localStorage override, written by Settings → Data → Storage → Server
 *      (components/settings/ServerSection.tsx). The mobile WebView build,
 *      which has no implicit same-origin backend, writes the same key.
 *   2. Vite env var `VITE_BACKEND_URL` (legacy dev override).
 *   3. Empty string = same-origin relative fetches (default web build).
 */
import { STORAGE_KEYS } from './storageKeys';

function isSelfhostedDeploy(): boolean {
  return typeof window !== 'undefined' &&
    (window as unknown as { __PHOTOLIB_SELFHOSTED__?: boolean }).__PHOTOLIB_SELFHOSTED__ === true;
}

const BACKEND_URL_KEY = STORAGE_KEYS.backendUrl;

function readPersistedBackendUrl(): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    return localStorage.getItem(BACKEND_URL_KEY) ?? '';
  } catch {
    return '';
  }
}

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function getBackendUrl(): string {
  const persisted = readPersistedBackendUrl();
  if (persisted) return normalize(persisted);
  const envUrl = (import.meta.env.VITE_BACKEND_URL ?? '') as string;
  return normalize(envUrl);
}

/** Why an entered server address was refused; `empty` means "drop the override". */
export type BackendUrlRejection = 'empty' | 'invalid' | 'mixed-content' | 'own-origin';

export type BackendUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: BackendUrlRejection };

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Decides whether an address a user typed can serve as this app's backend,
 * before the browser turns the same question into an opaque network error.
 *
 * `mixed-content`: an HTTPS page may not talk to `http://` at all — which is
 * exactly the usual LAN server without a certificate (ONLINE_MODE_PLAN §P9).
 * `own-origin`: in the online build our own origin is the static host, and
 * api.ts refuses it for that reason; storing it would look like a backend
 * and answer index.html.
 */
export function validateBackendUrl(input: string, pageOrigin: string): BackendUrlCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  const target = parseUrl(trimmed);
  if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
    return { ok: false, reason: 'invalid' };
  }

  const page = parseUrl(pageOrigin);
  if (page?.protocol === 'https:' && target.protocol === 'http:') {
    return { ok: false, reason: 'mixed-content' };
  }
  if (page && target.origin === page.origin) return { ok: false, reason: 'own-origin' };

  return { ok: true, url: normalize(target.href) };
}

export function setBackendUrl(url: string): void {
  if (typeof localStorage === 'undefined') return;
  const normalized = normalize(url);
  try {
    if (normalized) localStorage.setItem(BACKEND_URL_KEY, normalized);
    else localStorage.removeItem(BACKEND_URL_KEY);
  } catch {
    /* quota / private mode */
  }
}

export const config = {
  get mode(): 'hosted' | 'online' {
    return isSelfhostedDeploy() || import.meta.env.VITE_MODE === 'hosted' ? 'hosted' : 'online';
  },
  get backendUrl() {
    return getBackendUrl();
  },
};

/**
 * Whether this build can reach a PhotoLib backend at all. The online build
 * ships without one, but a server URL set under Settings stays a valid state
 * (ONLINE_MODE_PLAN §P9) — so it is the URL, not the mode alone, that decides.
 */
export function hasBackend(): boolean {
  return config.mode === 'hosted' || config.backendUrl !== '';
}
