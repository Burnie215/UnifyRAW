import { useEffect, useRef } from 'react';
import type { PhotoView } from '../storage/repos';
import { useRepos } from '../contexts/StorageContext';
import { thumbMemCache } from '../cache/ThumbMemCache';
import { putSourceThumb } from '../cache/putSourceThumb';
import { isThumbnailQueueIdle } from './thumbnailQueue';
import { sourceManager } from '../sources';
import { perfLog } from '../platform/perfLog';
import { generateThumbnailBlob, THUMB_LONG_EDGE } from '../engine/thumbnail/generateThumbnailBlob';
import {
  backgroundThumbnailBlob,
  retainAcquiredThumbnail,
  type BackgroundThumbnailPorts,
} from './backgroundThumbnail';
import { createRunGuard, type RunGuard } from './runGuard';
import { sourceThumbnailKey } from '../cache/sourceThumbnailKey';
import { photosNeedingThumbnail, thumbnailForBlurHash } from './backgroundThumbnailPlan';
import { backgroundThumbnailAvailable } from '../engine/raw/sourcePolicy';

const IDLE_DELAY = 2000;    // Wait 2s after last visible thumbnail before starting background
const BATCH_PAUSE = 200;    // Pause between background thumbnails (ms)
const QUEUE_POLL = 500;     // How often to check if on-demand queue is idle

const THUMB_PORTS: BackgroundThumbnailPorts = {
  fetchBlob: async (url, signal) => {
    const res = await fetch(url, { signal });
    return res.ok ? await res.blob() : null;
  },
  fromOriginal: (file) => generateThumbnailBlob(file, THUMB_LONG_EDGE, 0.7),
};

/** Called when a new sidecar thumb is written. Set by App.tsx via setOnSidecarThumbWritten. */
let onSidecarThumbWrittenFn: (() => void) | null = null;
export const onSidecarThumbWritten = () => onSidecarThumbWrittenFn?.();
export function setOnSidecarThumbWritten(fn: () => void) { onSidecarThumbWrittenFn = fn; }

import type { PhotoMeta } from '../sources/SidecarStoreV2';

type SidecarSource = {
  readSidecarThumb: (r: { sourcePhotoId: string; sourceId: string; name: string }) => Promise<Blob | null>;
  writeSidecarThumb: (r: { sourcePhotoId: string; sourceId: string; name: string }, b: Blob, meta?: Partial<PhotoMeta>) => Promise<boolean>;
};

/**
 * Background thumbnail & blurHash generator.
 *
 * Priority order:
 * 1. Recover blurHash from .dat index (fast, no blobs read)
 * 2. Generate ALL missing thumbnails → .dat (persistent)
 * 3. Generate blurHash for photos that have a thumb but no blurHash → .dat
 *
 * BlurHash is lowest priority — never blocks thumbnail generation.
 *
 * A rerun while a pass is running hands over through the run guard: the pass
 * stops at its next check and the new one starts, with the new photos, once
 * the old has left (F122).
 */
export function useBackgroundThumbnails(
  photos: PhotoView[],
  enabled: boolean,
) {
  const repos = useRepos();
  const guardRef = useRef<RunGuard | null>(null);
  guardRef.current ??= createRunGuard();
  const guard = guardRef.current;

  useEffect(() => {
    if (!enabled || photos.length === 0) {
      guard.retire();
      return;
    }

    const controller = new AbortController();
    const stale = guard.claim();
    const timer = setTimeout(() => { void guard.start(stale, runBackground); }, IDLE_DELAY);

    async function runBackground() {
      // Build .dat index per source (read once, use for all phases)
      const indexBySource = new Map<string, Record<string, PhotoMeta>>();
      const bySource = new Map<string, PhotoView[]>();
      for (const p of photos) {
        if (!p.id) continue;
        const arr = bySource.get(p.sourceId) ?? [];
        arr.push(p);
        bySource.set(p.sourceId, arr);
      }
      for (const [sourceId] of bySource) {
        if (stale()) break;
        const source = sourceManager.get(sourceId);
        if (!source || !('store' in source)) continue;
        const store = (source as unknown as { store: { getIndex: () => Promise<Record<string, PhotoMeta>> } }).store;
        if (!store) continue;
        try {
          indexBySource.set(sourceId, await store.getIndex());
        } catch { /* */ }
      }

      // Phase 1: Recover blurHash from .dat index → IndexedDB (fast, no blob reads)
      {
        const updates: { id: number; blurHash: string }[] = [];
        for (const [sourceId, sourcePhotos] of bySource) {
          const index = indexBySource.get(sourceId);
          if (!index) continue;
          for (const photo of sourcePhotos) {
            if (!photo.id || photo.blurHash) continue;
            const meta = index[photo.sourcePhotoId];
            if (meta?.b) {
              (photo as { blurHash?: string }).blurHash = meta.b;
              updates.push({ id: photo.id, blurHash: meta.b });
            }
          }
        }
        if (updates.length > 0) {
          repos.photos.bulkUpdate(updates.map((u) => ({
            id: u.id, patch: { blurHash: u.blurHash },
          })));
          if (perfLog.enabled) console.log(`[BgThumb] Recovered ${updates.length} blurHash from .dat`);
        }
      }

      // Phase 2: Generate missing thumbnails.
      // "Missing" = nothing that can answer this tile exists yet - not just
      // "no entry in the .dat index", which a source without a sidecar never
      // has and which therefore made every pass redo the whole library.
      const storedKeys = await repos.thumbnails.storedKeys();
      const needsThumb: PhotoView[] = photosNeedingThumbnail([...bySource.values()].flat(), {
        hasSidecarThumb: (p) => !!indexBySource.get(p.sourceId)?.[p.sourcePhotoId]?.t,
        storedKeys,
        hasMemoryThumb: (id) => thumbMemCache.has(id),
        canProvideThumbnail: (photo) => backgroundThumbnailAvailable(
          sourceManager.get(photo.sourceId)?.type,
        ),
      });

      if (perfLog.enabled) console.log(`[BgThumb] ${needsThumb.length} need thumbnail generation`);

      for (const photo of needsThumb) {
        if (stale()) break;
        if (!photo.id) continue;

        const source = sourceManager.get(photo.sourceId);
        if (!source) continue;

        const ref = {
          sourcePhotoId: photo.sourcePhotoId,
          sourceId: photo.sourceId,
          name: photo.name,
        };

        try {
          // Wait for on-demand thumbnail queue to be idle
          while (!isThumbnailQueueIdle() && !stale()) {
            await new Promise((r) => setTimeout(r, QUEUE_POLL));
          }
          if (stale()) break;

          // Yield to main thread
          await new Promise<void>((resolve) => {
            if (typeof requestIdleCallback !== 'undefined') {
              requestIdleCallback(() => resolve(), { timeout: 5000 });
            } else {
              setTimeout(resolve, BATCH_PAUSE);
            }
          });
          if (stale()) break;

          // The source's own thumbnail first; the original only for a source
          // whose bytes are already on this device. This loop walks the WHOLE
          // library after every scan, and it used to fetch the original of
          // every remote photo to make a 300 px JPEG out of it (F022).
          const blob = await backgroundThumbnailBlob(
            source,
            ref,
            THUMB_PORTS,
            controller.signal,
          );
          if (!blob) continue;
          if (stale()) break;

          await retainAcquiredThumbnail(blob, {
            // The shared slot may already hold a developed RAW thumbnail;
            // putSourceThumb keeps that winner instead of overwriting it.
            cache: (value) => putSourceThumb(
              photo as Parameters<typeof putSourceThumb>[0], value,
            ).then(() => {}),
            persistBlob: (value) => {
              repos.thumbnails.set(sourceThumbnailKey(photo), value).catch(() => {});
            },
            computeBlurHash,
            persistBlurHash: (blurHash) => {
              if (stale()) return;
              (photo as { blurHash?: string }).blurHash = blurHash;
              repos.photos.update(photo.id!, { blurHash });
            },
            persistSidecar: (value, blurHash) => {
              if (!('writeSidecarThumb' in source)) return;
              (source as unknown as SidecarSource).writeSidecarThumb(
                ref,
                value,
                blurHash ? { b: blurHash } : undefined,
              ).then((ok) => { if (ok) onSidecarThumbWritten(); }).catch(() => {});
            },
          });
        } catch {
          // Non-critical — skip
        }

        await new Promise((r) => setTimeout(r, BATCH_PAUSE));
      }

      // Phase 3: Generate blurHash for photos that have a thumb but no blurHash
      // Lowest priority — only after ALL thumbnails are persisted
      if (stale()) return;

      const needsHash = photos.filter((p) => p.id && !p.blurHash);
      if (perfLog.enabled && needsHash.length > 0) {
        console.log(`[BgThumb] ${needsHash.length} need blurHash`);
      }

      for (const photo of needsHash) {
        if (stale()) break;
        if (!photo.id) continue;

        const source = sourceManager.get(photo.sourceId);
        if (!source) continue;

        const ref = {
          sourcePhotoId: photo.sourcePhotoId,
          sourceId: photo.sourceId,
          name: photo.name,
        };

        try {
          // Wait for on-demand queue idle
          while (!isThumbnailQueueIdle() && !stale()) {
            await new Promise((r) => setTimeout(r, QUEUE_POLL));
          }
          if (stale()) break;

          // The thumbnail this photo already has, wherever it lives. The
          // catalog is part of the answer: phase 2 counts a stored thumbnail
          // as supplied and skips the photo, so for a source without a sidecar
          // this is the only place the picture can still be found.
          const thumbBlob = await thumbnailForBlurHash(photo, {
            readSidecar: 'readSidecarThumb' in source
              ? () => (source as unknown as SidecarSource).readSidecarThumb(ref)
              : null,
            readMemory: (id) => thumbMemCache.get(id),
            readStored: async (key) => (await repos.thumbnails.get(key)) ?? null,
          });
          if (!thumbBlob || stale()) continue;

          const hash = await computeBlurHash(thumbBlob);

          if (hash && !stale()) {
            (photo as { blurHash?: string }).blurHash = hash;
            repos.photos.update(photo.id, { blurHash: hash });

            // Persist blurHash to .dat index
            if ('store' in source) {
              const store = (source as unknown as { store: { setMeta: (path: string, meta: Partial<PhotoMeta>) => Promise<void> } }).store;
              if (store) store.setMeta(photo.sourcePhotoId, { b: hash }).catch(() => {});
            }
          }
        } catch { /* non-critical */ }

        await new Promise((r) => setTimeout(r, BATCH_PAUSE));
      }
    }

    return () => {
      controller.abort();
      guard.retire();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, photos.length]);
}

/** Compute blurHash from a thumbnail blob. Returns null on error. */
async function computeBlurHash(blob: Blob): Promise<string | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(32, 32);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, 32, 32);
    const data = canvas.getContext('2d')!.getImageData(0, 0, 32, 32);
    const { encodeBlurHash } = await import('../image/blurhash');
    return encodeBlurHash(data.data, 32, 32, 4, 3);
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}
