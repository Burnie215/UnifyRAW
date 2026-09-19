import type { SyncSettings } from '../storage/SyncedStorage';

/**
 * Which sync hub a profile without stored settings starts with.
 *
 * `/api/sync` lives in the same backend as `/api/proxy`, and the bearer for
 * both comes out of these very settings — so a server the user entered under
 * Settings → Data → Storage → Server pre-fills the hub instead of asking for
 * the same address twice (AP21, decision 2). The selfhost build keeps its own
 * origin. The online build without a server has no hub to offer.
 *
 * This is `hasBackend()` spelled out over the two fields it reads, so that the
 * decision is testable without a browser.
 */
export function defaultSyncSettings(
  config: { mode: 'hosted' | 'online'; backendUrl: string },
  origin: string | null,
): SyncSettings | null {
  if (config.backendUrl) return { serverUrl: config.backendUrl };
  if (config.mode === 'hosted' && origin) return { serverUrl: origin };
  return null;
}
