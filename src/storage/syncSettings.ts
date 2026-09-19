import { STORAGE_KEYS } from '../platform/storageKeys';
import type { SyncSettings } from './SyncedStorage';

/**
 * The one reader and writer of the sync settings.
 *
 * api.ts needs the bearer token, StorageContext needs the whole record. While
 * both parsed the stored JSON on their own, a change to the shape on one side
 * dropped the Authorization header on the other - no error, just a sync that
 * answers 401 (F133).
 */
export function readSyncSettings(): SyncSettings | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.syncSettings);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { serverUrl?: unknown; token?: unknown };
    if (typeof parsed.serverUrl !== 'string') return null;
    const token = typeof parsed.token === 'string' && parsed.token ? parsed.token : undefined;
    return { serverUrl: parsed.serverUrl, token };
  } catch {
    return null;
  }
}

export function writeSyncSettings(settings: SyncSettings | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (settings) localStorage.setItem(STORAGE_KEYS.syncSettings, JSON.stringify(settings));
    else localStorage.removeItem(STORAGE_KEYS.syncSettings);
  } catch { /* quota / private mode - the session keeps working without it */ }
}
