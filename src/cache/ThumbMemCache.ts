/**
 * In-Memory Thumbnail Cache — stores Blobs only, no URLs.
 * Components create their own Object URLs and revoke them on unmount.
 * LRU eviction, configurable max entries.
 */

import { STORAGE_KEYS } from '../platform/storageKeys';

const DEFAULT_MAX = 200;
const STORAGE_KEY = STORAGE_KEYS.thumbMemCacheConfig;

function loadConfig(): { enabled: boolean; max: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* */ }
  return { enabled: true, max: DEFAULT_MAX };
}

class ThumbMemCache {
  private cache = new Map<number, Blob>();
  private _enabled: boolean;
  private maxEntries: number;
  private listeners = new Map<number, Set<() => void>>();

  constructor() {
    const cfg = loadConfig();
    this._enabled = cfg.enabled;
    this.maxEntries = cfg.max;
  }

  get enabled(): boolean { return this._enabled; }
  get max(): number { return this.maxEntries; }
  get size(): number { return this.cache.size; }
  get sizeMB(): number {
    let bytes = 0;
    for (const blob of this.cache.values()) bytes += blob.size;
    return Math.round(bytes / 1024 / 1024 * 10) / 10;
  }

  setEnabled(enabled: boolean) {
    this._enabled = enabled;
    if (!enabled) this.clear();
    this.saveConfig();
  }

  setMax(max: number) {
    this.maxEntries = max;
    this.evict();
    this.saveConfig();
  }

  /** Get a cached blob. Returns null on miss or if disabled. */
  get(photoId: number): Blob | null {
    if (!this._enabled) return null;
    const blob = this.cache.get(photoId);
    if (!blob) return null;
    // Move to end (most recently used)
    this.cache.delete(photoId);
    this.cache.set(photoId, blob);
    return blob;
  }

  /** Cache a blob. No URL management — caller handles URLs. */
  put(photoId: number, blob: Blob): void {
    if (!this._enabled) return;
    this.cache.set(photoId, blob);
    this.evict();
    const set = this.listeners.get(photoId);
    if (set) for (const cb of set) cb();
  }

  /** Remove one entry and notify mounted tiles so they reload the source thumb. */
  remove(photoId: number): void {
    this.cache.delete(photoId);
    const set = this.listeners.get(photoId);
    if (set) for (const cb of set) cb();
  }

  /** Subscribe to put() events for a specific photoId. Returns unsubscribe. */
  subscribe(photoId: number, cb: () => void): () => void {
    let set = this.listeners.get(photoId);
    if (!set) { set = new Set(); this.listeners.set(photoId, set); }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.listeners.delete(photoId);
    };
  }

  has(photoId: number): boolean {
    return this._enabled && this.cache.has(photoId);
  }

  clear() {
    this.cache.clear();
  }

  private evict() {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private saveConfig() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: this._enabled, max: this.maxEntries })); } catch { /* */ }
  }
}

export const thumbMemCache = new ThumbMemCache();
