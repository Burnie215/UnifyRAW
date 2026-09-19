import { useEffect, useRef } from 'react';
import type { PhotoView } from '../storage/repos';
import { useRepos } from '../contexts/StorageContext';
import { sourceManager } from '../sources';
import { heifDecoder } from '../engine/HeifDecoder';
import { extractExifForDb } from './useExif';
import { isThumbnailQueueIdle } from './thumbnailQueue';
import { runExifBackfillPass } from './exifBackfillPass';
import { createRunGuard, type RunGuard } from './runGuard';

const BATCH_PAUSE = 500;           // ms between batches
const THUMBNAIL_POLL = 2000;       // ms to re-check if thumbnail queue is idle
const INITIAL_DELAY = 5000;        // ms before first run (let thumbnails start first)

/**
 * Background EXIF backfill with priority system matching thumbnail generation:
 *
 * 1. Editor mode → paused (enabled=false)
 * 2. Never runs while thumbnail queue is active (File System API contention)
 * 3. Photos with cached thumbnails first (proxy for "visible / on-demand")
 * 4. Remaining photos in background when idle
 * 5. Uses requestIdleCallback between batches
 *
 * A file that was read once is marked in `exifScan` and never read again, even
 * when it carried no capture EXIF at all; the decisions and the writes live in
 * exifBackfillPass.ts, this hook only schedules them.
 */
export function useExifBackfill(photos: PhotoView[], enabled: boolean) {
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
    const timer = setTimeout(() => { void guard.start(stale, pass); }, INITIAL_DELAY);

    async function waitForThumbnailIdle(): Promise<boolean> {
      while (!isThumbnailQueueIdle()) {
        if (stale()) return false;
        await new Promise((r) => setTimeout(r, THUMBNAIL_POLL));
      }
      return !stale();
    }

    async function waitForIdle(): Promise<boolean> {
      if (stale()) return false;
      await new Promise<void>((resolve) => {
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(() => resolve(), { timeout: 5000 });
        } else {
          setTimeout(resolve, BATCH_PAUSE);
        }
      });
      return !stale();
    }

    async function pass(): Promise<void> {
      await runExifBackfillPass({
        photos,
        scanned: repos.exifScans.scannedIds(),
        owns: (photo) => {
          const type = sourceManager.get(photo.sourceId)?.type;
          return type === 'local' || type === 'local-files';
        },
        getFile: async (photo, signal) => {
          const source = sourceManager.get(photo.sourceId);
          if (!source) return null;
          return source.getFile({
            sourcePhotoId: photo.sourcePhotoId,
            sourceId: photo.sourceId,
            name: photo.name,
          }, signal);
        },
        extractExif: extractExifForDb,
        probeSourceBits: (file) => heifDecoder.probeSourceBits(file),
        write: {
          updatePhotos: (updates) => repos.photos.bulkUpdate(updates),
          setKeywords: (contentHash, keywords) => repos.photoMeta.set(contentHash, { keywords }),
          markScanned: (ids, at) => repos.exifScans.markScanned(ids, at),
        },
        signal: controller.signal,
        stale,
        beforeBatch: async (index) => {
          if (index > 0) await new Promise((r) => setTimeout(r, BATCH_PAUSE));
          // Wait for the thumbnail queue to be idle — never compete.
          if (!(await waitForThumbnailIdle())) return false;
          return waitForIdle();
        },
        beforePhoto: async () => (isThumbnailQueueIdle() ? !stale() : waitForThumbnailIdle()),
      });
    }

    return () => {
      controller.abort();
      guard.retire();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, photos.length]);
}
