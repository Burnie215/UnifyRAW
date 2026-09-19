import { SmartPreviewStrategy } from './SmartPreviewStrategy';
import { isLocalRawSourceType } from './sourcePolicy';
import { getDefaultRawPixelsCache } from './RawPixelsOpfsCache';
import { currentSlotKey, isCurrentPreviewVariant } from './previewSlots';

/**
 * Hover-triggered Smart Preview pre-generation.
 *
 * - Concurrent limit: max 2 in-flight backend round-trips at once
 * - Dedup: a cacheKey already in-flight or queued won't re-fire
 * - Memory of completed: keys we've already pre-fetched in this session skip
 *   the work entirely (the OPFS cache hit on next decode will be enough)
 * - Per-cell cancel: TileItem cancels its hover-pending request when the
 *   mouse leaves before the 300ms dwell expires
 *
 * The prefetch itself is fire-and-forget — we never throw or await it from
 * the UI layer. Failures are logged and discarded.
 */
interface InFlight {
  controller: AbortController;
  startedAt: number;
}

export class PrefetchManager {
  private strategy = new SmartPreviewStrategy();
  private inFlight = new Map<string, InFlight>();
  private completed = new Set<string>();
  private maxConcurrent = 2;
  private listeners = new Set<() => void>();
  private scanPromise: Promise<void> | null = null;

  /**
   * Subscribe to state changes (prefetch started / finished / OPFS scan
   * complete). The callback fires whenever a key transitions between
   * {none, in-flight, completed}. Returns an unsubscribe function. Used
   * by tile badges in the library grid.
   */
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  /**
   * Populate `completed` from previously-cached OPFS entries. Lazy: only
   * runs once per session, on the first call. Listeners are notified when
   * the scan finishes so existing tile badges re-render.
   */
  scanOpfsCache(): Promise<void> {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('smart-previews', { create: false }).catch(() => null);
        // Only slots of the current preview version count, and a TIFF that
        // was opened twice lives on in the pixel cache alone (F038, F087).
        if (dir) {
          for await (const [name] of dir.entries()) {
            const key = currentSlotKey(name);
            if (key) this.completed.add(key);
          }
        }
        for (const { contentHash, shortEdge } of await getDefaultRawPixelsCache().listEntries()) {
          if (isCurrentPreviewVariant(shortEdge)) this.completed.add(contentHash);
        }
        this.emit();
      } catch {
        /* OPFS not available or no cache dir yet — nothing to do */
      }
    })();
    return this.scanPromise;
  }

  /**
   * Schedule a prefetch for the given file + cache key. Returns a
   * cancel-handle that the caller can invoke if the user's intent goes
   * away (e.g. mouse-leave before dwell completes).
   *
   * Priority semantics: the most recent `schedule()` always wins. If the
   * concurrency limit is reached and the new key isn't already running,
   * the OLDEST in-flight request is aborted to make room. This matches
   * hover behavior — when the user scrolls past many tiles, only the
   * currently-hovered one should be racing toward the cache.
   */
  schedule(file: File, cacheKey: string, size = 1200, sourceType?: string): () => void {
    // Privacy boundary: local browser files are decoded with libraw-wasm and
    // must never enter the server-backed Smart Preview queue.
    if (isLocalRawSourceType(sourceType)) return () => {};
    if (this.completed.has(cacheKey)) return () => {};
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      // Already racing for this exact key — refresh its priority by
      // bumping startedAt so it isn't the next victim of eviction.
      existing.startedAt = Date.now();
      return () => existing.controller.abort();
    }

    // Capacity full → evict oldest to make room for this new (higher-prio) one.
    if (this.inFlight.size >= this.maxConcurrent) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.inFlight) {
        if (v.startedAt < oldestAt) {
          oldestAt = v.startedAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) {
        const victim = this.inFlight.get(oldestKey);
        victim?.controller.abort();
        this.inFlight.delete(oldestKey);
      }
    }

    const controller = new AbortController();
    const entry: InFlight = { controller, startedAt: Date.now() };
    this.inFlight.set(cacheKey, entry);
    this.emit();
    this.strategy
      .prefetch(file, { cacheKey, size, signal: controller.signal })
      .then((cached) => {
        // Only a slot that really holds a preview counts. Marking it on any
        // settle used to badge a tile "cached" after a failed fetch and never
        // try again.
        if (cached && !controller.signal.aborted) this.completed.add(cacheKey);
      })
      .finally(() => {
        if (this.inFlight.get(cacheKey) === entry) {
          this.inFlight.delete(cacheKey);
        }
        this.emit();
      });
    return () => { controller.abort(); this.emit(); };
  }

  hasInFlight(cacheKey: string): boolean {
    return this.inFlight.has(cacheKey);
  }

  isCompleted(cacheKey: string): boolean {
    return this.completed.has(cacheKey);
  }

  /**
   * Bulk pre-generate: walks a list of photos and warms the cache for each.
   * Used by the "Alle vorgenerieren"-Button in Settings.
   */
  async bulk(
    items: Array<{
      cacheKey: string;
      sourceType?: string;
      getFile: (signal?: AbortSignal) => Promise<File | null>;
    }>,
    opts: { size?: number; onProgress?: (done: number, total: number, key: string) => void; signal?: AbortSignal } = {},
  ): Promise<void> {
    const { size = 1200, onProgress, signal } = opts;
    let done = 0;
    const total = items.length;

    // Simple worker-pool of MAX_CONCURRENT workers pulling from the queue.
    const queue = [...items];
    const workers: Promise<void>[] = [];
    for (let w = 0; w < this.maxConcurrent; w++) {
      workers.push((async () => {
        while (true) {
          if (signal?.aborted) return;
          const next = queue.shift();
          if (!next) return;
          if (isLocalRawSourceType(next.sourceType)) {
            done++;
            onProgress?.(done, total, next.cacheKey);
            continue;
          }
          if (!this.completed.has(next.cacheKey)) {
            const file = await next.getFile(signal).catch(() => null);
            if (signal?.aborted) return;
            if (file) {
              const cached = await this.strategy.prefetch(file, { cacheKey: next.cacheKey, size, signal });
              if (cached) {
                this.completed.add(next.cacheKey);
                this.emit();
              }
            }
          }
          done++;
          onProgress?.(done, total, next.cacheKey);
        }
      })());
    }
    await Promise.all(workers);
  }
}

/** Module-level singleton — shared across all hover events. */
export const prefetchManager = new PrefetchManager();

// Warm the in-memory "completed" set from any prior-session OPFS cache so
// tile badges in the grid can show cached state immediately on first paint.
// Fire-and-forget — listeners (useTileCacheState) re-render when it lands.
prefetchManager.scanOpfsCache();
