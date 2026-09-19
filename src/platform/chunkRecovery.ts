import { SESSION_KEYS } from './storageKeys';

export const CHUNK_RELOAD_STORAGE_KEY = SESSION_KEYS.staleAssetReload;
export const CHUNK_RELOAD_COOLDOWN_MS = 10_000;

type MinimalStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Claim the single automatic reload allowed within the cooldown window. */
export function claimChunkRecoveryReload(
  storage: MinimalStorage,
  now = Date.now(),
): boolean {
  const previous = Number(storage.getItem(CHUNK_RELOAD_STORAGE_KEY) || 0);
  if (Number.isFinite(previous) && previous > 0 && now - previous <= CHUNK_RELOAD_COOLDOWN_MS) {
    return false;
  }
  storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(now));
  return true;
}

/**
 * Vite emits this event when a lazy chunk or its imported CSS disappeared
 * during a deployment. Prevent the rejected import from becoming a blank
 * React screen and reload the current HTML exactly once.
 */
export function installChunkRecovery(): void {
  window.addEventListener('vite:preloadError', (event) => {
    event.preventDefault();
    try {
      if (!claimChunkRecoveryReload(window.sessionStorage)) return;
    } catch {
      // Storage can be unavailable in hardened/private contexts. A reload is
      // still the only useful recovery, even without the loop guard.
    }
    window.location.reload();
  });
}
