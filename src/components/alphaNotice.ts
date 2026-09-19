/**
 * Acknowledgement state for the one-time alpha warning. Lives apart from the
 * modal so the component file only exports the component (fast refresh).
 */

import { STORAGE_KEYS } from '../platform/storageKeys';

export const ALPHA_NOTICE_STORAGE_KEY = STORAGE_KEYS.alphaNoticeAcknowledged;

/** True while this browser profile has not yet acknowledged the alpha notice. */
export function alphaNoticePending(): boolean {
  try {
    return localStorage.getItem(ALPHA_NOTICE_STORAGE_KEY) !== '1';
  } catch {
    // No localStorage (private mode) — show it, an extra reminder beats none.
    return true;
  }
}

export function acknowledgeAlphaNotice(): void {
  try {
    localStorage.setItem(ALPHA_NOTICE_STORAGE_KEY, '1');
  } catch { /* unavailable — the notice returns on the next load, which is harmless */ }
}
