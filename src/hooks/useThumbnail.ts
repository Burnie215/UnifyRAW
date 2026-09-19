import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { sourceManager } from '../sources';
import type { EditRow, PhotoView } from '../storage/repos';
import { thumbMemCache } from '../cache/ThumbMemCache';
import { onSidecarThumbWritten } from './useBackgroundThumbnails';
import { perfLog } from '../platform/perfLog';
import { generateThumbnailBlob, THUMB_LONG_EDGE } from '../engine/thumbnail/generateThumbnailBlob';
import { getActiveRepos } from '../storage/activeRepos';
import { putSourceThumb, type SourceThumbSubject } from '../cache/putSourceThumb';
import { sourceThumbnailKeys } from '../cache/sourceThumbnailKey';
import { thumbnailStampFor } from '../engine/thumbnailStamp';
import { developProfileRevision } from '../engine/developProfileStore';
import { lensProfileRevision } from '../engine/lensProfileStore';
import { RawDecoder } from '../engine/RawDecoder';
import { defaultAdjustments } from '../types';
import { dequeue, enqueue, thumbnailQueueDepth, type QueueEntry } from './thumbnailQueue';
import { loadThumbnail, type ThumbnailLoadPorts, type ThumbnailMode } from './thumbnailLoad';

export type { ThumbnailMode };

/**
 * One tile's thumbnail.
 *
 * The walk that decides where the picture comes from is
 * [`loadThumbnail`](./thumbnailLoad.ts) and does not know React exists. What
 * is left here is what React owns: the URL on screen and who may revoke it,
 * the lifetime of one run, and the subscription that starts the next one.
 */
export function useThumbnail(photo: PhotoView, mode: ThumbnailMode = 'auto'): { url: string | undefined; hasEdit: boolean } {
  const [url, setUrl] = useState<string>();
  const [hasEdit, setHasEdit] = useState(false);
  const [revision, setRevision] = useState(0);
  // The URL currently on screen. It lives with the component, not with one run
  // of the effect: the effect re-runs whenever contentHash or the revision
  // moves, and revoking there used to kill the URL the <img> was still showing.
  // A tile then displayed a broken image until a later run replaced it - and if
  // that run stalled in the queue, until the component unmounted.
  const urlRef = useRef<string>(undefined);

  // Which profiles develop this photo, as a value the effect can depend on.
  // Built from the fields that decide the answer rather than from `photo`,
  // because a new PhotoView identity arrives on every catalog write and would
  // otherwise restart every tile's load.
  //
  // The profile revisions are in the dependencies because the answer also
  // changes when the profiles do, and the stores they live in are outside
  // React and cannot invalidate a memo by themselves. Their writer bumps them
  // before it nudges the tiles, so a re-render always sees the new number.
  const subject = useMemo<SourceThumbSubject>(() => ({
    id: photo.id!,
    contentHash: photo.contentHash,
    name: photo.name ?? '',
    camera: photo.camera,
    iso: photo.iso,
    lens: photo.lens,
    focalLength: photo.focalLength,
  }), [photo.id, photo.contentHash, photo.name, photo.camera, photo.iso, photo.lens, photo.focalLength]);

  // The slots this photo's source thumbnail may live in, built from the fields
  // that decide the answer rather than from `photo`: a new PhotoView identity
  // arrives on every catalog write and would otherwise restart every tile.
  const thumbKeys = useMemo(() => sourceThumbnailKeys({
    sourceId: photo.sourceId,
    sourcePhotoId: photo.sourcePhotoId,
    contentHash: photo.contentHash,
    sizeBytes: photo.sizeBytes,
    dateModified: photo.dateModified,
    sourceRevision: photo.sourceRevision,
  }), [
    photo.sourceId, photo.sourcePhotoId, photo.contentHash,
    photo.sizeBytes, photo.dateModified, photo.sourceRevision,
  ]);

  const profileRevision = `${developProfileRevision()}.${lensProfileRevision()}`;
  const stamp = useMemo(
    () => thumbnailStampFor(subject),
    // The linter cannot see that `thumbnailStampFor` reads the profile stores,
    // so it calls the revision unnecessary. It is the opposite: without it the
    // memo survives a profile change and the tile keeps the retired key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subject, profileRevision],
  );

  const show = useCallback((blob: Blob) => {
    const next = URL.createObjectURL(blob);
    const previous = urlRef.current;
    urlRef.current = next;
    setUrl(next);
    if (previous) URL.revokeObjectURL(previous);
  }, []);

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  useEffect(() => {
    const photoId = photo.id;
    if (!photoId) return;
    const contentHash = photo.contentHash;
    let cancelled = false;
    const controller = new AbortController();
    const queueEntry: QueueEntry = { resolve: () => {}, cancelled: false };

    const log = perfLog.enabled
      ? (phase: string) => {
        const { active, queued } = thumbnailQueueDepth();
        console.log(`[Thumb] #${photoId} ${photo.name} | ${phase} | +${Math.round(performance.now() - t0)}ms | active=${active} queued=${queued}`);
      }
      : null;
    const t0 = performance.now();

    const ref = {
      sourcePhotoId: photo.sourcePhotoId,
      sourceId: photo.sourceId,
      name: photo.name,
    };

    const ports: ThumbnailLoadPorts<EditRow> = {
      cancelled: () => cancelled,
      log,
      readEdit: () => (contentHash ? getActiveRepos()?.edits.getMaster(contentHash) ?? null : null),
      setHasEdit,
      requestBaseThumbnail: (edit) => {
        if (!contentHash) return;
        void import('../engine/ThumbnailRenderer').then((mod) => {
          if (cancelled) return;
          mod.queueBaseThumbnail(
            contentHash,
            edit?.adjustments ?? defaultAdjustments,
            edit?.document ?? undefined,
          );
        }).catch(() => {});
      },
      readStored: (key) => getActiveRepos()?.thumbnails.get(key).catch(() => null) ?? Promise.resolve(null),
      writeStored: (key, blob) => { getActiveRepos()?.thumbnails.set(key, blob).catch(() => {}); },
      readMemory: () => thumbMemCache.get(photoId),
      writeMemory: (blob) => thumbMemCache.put(photoId, blob),
      claimSourceSlot: (blob) => putSourceThumb(subject, blob),
      show,
      getSource: () => sourceManager.get(photo.sourceId) ?? null,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      enqueue: () => enqueue(queueEntry),
      dequeue,
      fetchThumb: async (thumbUrl) => {
        const res = await fetch(thumbUrl, { signal: controller.signal });
        return res.ok ? await res.blob() : null;
      },
      fromOriginal: (file) => generateThumbnailBlob(file, THUMB_LONG_EDGE, 0.7),
      onSidecarWritten: onSidecarThumbWritten,
    };

    void loadThumbnail({
      mode,
      ref,
      contentHash,
      stamp,
      isRaw: RawDecoder.isRawFile(photo.name),
      thumbKeys,
      signal: controller.signal,
    }, ports);

    // Refresh when an edit thumbnail is written for this photo.
    const unsub = mode === 'source' ? () => {} : thumbMemCache.subscribe(photoId, () => {
      const blob = thumbMemCache.get(photoId);
      if (cancelled) return;
      if (!blob) {
        setHasEdit(false);
        setRevision((current) => current + 1);
        return;
      }
      show(blob);
      if (photo.contentHash) {
        setHasEdit(!!getActiveRepos()?.edits.getMaster(photo.contentHash));
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
      queueEntry.cancelled = true;
      unsub();
    };
  }, [photo.id, photo.sourceId, photo.sourcePhotoId, photo.name, photo.contentHash, mode, revision, show, stamp, subject, thumbKeys]);

  return { url, hasEdit };
}

export async function saveEditThumbnail(photoId: number, canvas: HTMLCanvasElement): Promise<void> {
  const thumbSize = THUMB_LONG_EDGE;
  const aspect = canvas.width / canvas.height;
  const w = aspect >= 1 ? thumbSize : Math.round(thumbSize * aspect);
  const h = aspect >= 1 ? Math.round(thumbSize / aspect) : thumbSize;

  const offscreen = new OffscreenCanvas(w, h);
  const ctx = offscreen.getContext('2d')!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const editBlob = await offscreen.convertToBlob({ type: 'image/jpeg', quality: 0.7 });

  thumbMemCache.put(photoId, editBlob);
}
