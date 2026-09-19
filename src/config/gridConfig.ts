import { STORAGE_KEYS } from '../platform/storageKeys';

const GRID_BUFFER_KEY = STORAGE_KEYS.gridBuffer;

export let gridBufferRows = (() => {
  try { return Number(localStorage.getItem(GRID_BUFFER_KEY)) || 3; } catch { return 3; }
})();

export function setGridBufferRows(n: number) {
  gridBufferRows = Math.max(1, Math.min(20, n));
  try { localStorage.setItem(GRID_BUFFER_KEY, String(gridBufferRows)); } catch { /* */ }
}
