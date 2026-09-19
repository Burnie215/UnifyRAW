/**
 * Where ONE tile's thumbnail comes from, in order, and what it costs.
 *
 * The order is the whole point: a developed rendering beats the camera JPEG,
 * a cached blob beats a fetch, and only the last step - source fetch, decode,
 * generate - is expensive enough to need a slot from the shared queue
 * (`thumbnailQueue`). Every early return above that step is a tile that never
 * touched the queue.
 *
 * Lives outside the hook for the same reason `backgroundThumbnail` does: the
 * node test project cannot render hooks, so as long as this walk sat inside a
 * `useEffect` nothing could ask it which step it took, whether it gave its
 * queue slot back, or what it does when the tile disappears mid-flight. The
 * hook that remains ({@link useThumbnail}) owns only what React owns: the
 * URL on screen, the lifetime of the run, and the subscription that restarts
 * it.
 *
 * Cancellation is a question, not a flag: `ports.cancelled()` is asked at the
 * same places the effect used to read its `cancelled` variable, so a tile that
 * scrolls away stops between steps instead of finishing into a dead component.
 */

import { editThumbnailKey } from '../cache/editThumbnailKey';
import { revokeBlobUrls } from '../platform/objectUrls';
import type { PhotoRef } from '../sources/types';

export type ThumbnailMode = 'source' | 'edit' | 'auto';

/** How long the loader keeps waiting for a source that is still reconnecting. */
export const SOURCE_RETRIES = 10;
export const SOURCE_RETRY_DELAY = 300;

/** The part of a source provider one tile load uses. */
export interface ThumbnailLoadSource {
  getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null>;
  getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null>;
  /** Sidecar sources only; the loader asks before it decodes anything. */
  readSidecarThumb?(ref: PhotoRef): Promise<Blob | null>;
  writeSidecarThumb?(ref: PhotoRef, blob: Blob): Promise<boolean>;
}

/** Everything about the photo that decides where its thumbnail may come from. */
export interface ThumbnailRequest {
  mode: ThumbnailMode;
  ref: PhotoRef;
  /** Absent until the photo has been hashed; without it no developed slot exists. */
  contentHash?: string | null;
  /** The profiles that develop this photo, null when none do. */
  stamp: string | null;
  /** Whether the file would render differently in the editor than its embedded JPEG. */
  isRaw: boolean;
  /** The slots this photo's SOURCE thumbnail may live in; the first is where a new one is written. */
  thumbKeys: readonly string[];
  signal?: AbortSignal;
}

/**
 * The world the loader touches. Each port is the app's own call bound to this
 * photo, so the loader never has to know a repository, a cache or a renderer.
 *
 * `TEdit` is the catalog's edit row. The loader only ever asks whether there
 * is one and hands it back for the render request; it reads no field of it.
 */
export interface ThumbnailLoadPorts<TEdit> {
  /** True once this run's tile is gone or has been superseded. */
  cancelled: () => boolean;
  /** Performance trace, null when tracing is off. */
  log: ((phase: string) => void) | null;

  /** The master edit for this photo, or null. Called at most once. */
  readEdit: () => TEdit | null;
  /** Report whether this photo carries an edit (the badge). */
  setHasEdit: (value: boolean) => void;
  /** Ask the renderer for a developed thumbnail; it only answers if the RAW is decoded. */
  requestBaseThumbnail: (edit: TEdit | null) => void;

  /** A persisted thumbnail under a catalog key; null on miss AND on read failure. */
  readStored: (key: string) => Promise<Blob | null>;
  /** Persist under the source key. Failures are not this loader's business. */
  writeStored: (key: string, blob: Blob) => void;
  readMemory: () => Blob | null;
  writeMemory: (blob: Blob) => void;
  /**
   * Hand a source thumbnail to the shared memory slot and get back whoever
   * holds it - which may be a developed rendering that arrived first.
   */
  claimSourceSlot: (blob: Blob) => Promise<Blob>;
  /** Put a blob on screen. */
  show: (blob: Blob) => void;

  getSource: () => ThumbnailLoadSource | null;
  wait: (ms: number) => Promise<void>;

  /** Take a queue slot for the heavy part. Resolves when one is free. */
  enqueue: () => Promise<void>;
  /** Give the slot back. Must happen exactly once per resolved `enqueue`. */
  dequeue: () => void;

  /** Read a source-provided thumbnail URL. Null when the endpoint refuses. */
  fetchThumb: (url: string) => Promise<Blob | null>;
  /** Decode and downscale an original. */
  fromOriginal: (file: File) => Promise<Blob>;
  /** A sidecar thumbnail reached the disk. */
  onSidecarWritten: () => void;
}

export async function loadThumbnail<TEdit>(
  request: ThumbnailRequest,
  ports: ThumbnailLoadPorts<TEdit>,
): Promise<void> {
  const { mode, ref, contentHash, stamp, isRaw, thumbKeys, signal } = request;
  const { log } = ports;
  log?.('start');

  // The badge says "this photo has been edited", so it has to come from the
  // edits table. It used to be read off the existence of a developed
  // thumbnail, which was the same thing right up until un-edited RAWs started
  // getting one too - after which every RAW would have claimed an edit it
  // does not have.
  const edit = (mode !== 'source' && contentHash) ? ports.readEdit() : null;
  ports.setHasEdit(!!edit);

  /**
   * Put a source thumbnail on screen - unless a developed one has appeared in
   * the meantime.
   *
   * Every path below writes into one shared memory slot, and for a RAW the
   * source thumbnail can take seconds to fetch and decode while the developed
   * render takes a fraction of that. Whoever finishes last wins the slot, so
   * without this check the camera JPEG routinely lands on top of the developed
   * picture and stays there: the render that would correct it has already
   * happened and will not happen again.
   */
  const showSource = async (blob: Blob) => {
    // "Show originals" wants the camera's own picture, so it skips the check
    // and takes whatever it was handed.
    if (mode === 'source') { ports.writeMemory(blob); ports.show(blob); return; }
    const winner = await ports.claimSourceSlot(blob);
    if (ports.cancelled()) return;
    ports.show(winner);
    if (winner !== blob) log?.('developed-won-the-race');
  };

  // Developed thumbnails have their own persistent key. Prefer them in normal
  // gallery mode, but never while "show originals" is active.
  if (mode !== 'source' && contentHash) {
    const editHit = await ports.readStored(editThumbnailKey(contentHash, stamp));
    if (editHit && editHit.size > 0 && !ports.cancelled()) {
      ports.writeMemory(editHit);
      ports.show(editHit);
      log?.('EDIT-HIT');
      return;
    }

    // No developed thumbnail, but this photo would render differently in the
    // editor than the camera JPEG below does. Ask for one; it is only produced
    // if the RAW pixels are already decoded.
    if (stamp && isRaw) ports.requestBaseThumbnail(edit);
  }

  // 1. Memory cache (instant)
  // Source mode bypasses this shared slot because it may contain a developed
  // thumbnail written by ThumbnailRenderer.
  const memBlob = mode === 'source' ? null : ports.readMemory();
  if (memBlob && !ports.cancelled()) {
    ports.show(memBlob);
    log?.('MEM-HIT');
    return;
  }

  // Wait for the source to be connected (reconnectAll may still be running
  // after a refresh).
  let source = ports.getSource();
  if (!source) {
    for (let i = 0; i < SOURCE_RETRIES && !source && !ports.cancelled(); i++) {
      await ports.wait(SOURCE_RETRY_DELAY);
      source = ports.getSource();
    }
    if (!source) { log?.('no-source'); return; }
  }

  // 2. Sidecar thumb read (no queue slot needed)
  if (source.readSidecarThumb) {
    const hit = await source.readSidecarThumb(ref).catch(() => null);
    if (hit && hit.size > 0 && !ports.cancelled()) {
      await showSource(hit);
      log?.('CACHE-HIT');
      return;
    }
  }

  // Non-sidecar sources (for example a one-off local file list) still get
  // persistent catalog thumbnails. Under `sourceThumbnailKey`, not under the
  // content hash: a freshly scanned row has no hash yet, so gating the lookup
  // on one meant a library nobody had opened never found a stored thumbnail
  // and decoded every RAW again on every grid build.
  for (const key of thumbKeys) {
    const hit = await ports.readStored(key);
    if (hit && hit.size > 0 && !ports.cancelled()) {
      await showSource(hit);
      log?.('REPO-HIT');
      return;
    }
    if (ports.cancelled()) return;
  }
  log?.('CACHE-MISS');

  if (ports.cancelled()) { log?.('cancelled-early'); return; }

  // 3. Queue for heavy work (source fetch / decode / generate)
  log?.('enqueue-wait');
  await ports.enqueue();
  if (ports.cancelled()) { log?.('cancelled-in-queue'); ports.dequeue(); return; }
  log?.('dequeued');

  try {
    let blob: Blob | null = null;

    // Source-provided thumbnail (Immich, etc.)
    let thumbUrl: string | null = null;
    try {
      thumbUrl = await source.getThumbnailUrl(ref, signal);
      if (thumbUrl && !ports.cancelled()) {
        blob = await ports.fetchThumb(thumbUrl);
        log?.('source-thumb');
      }
    } catch { /* */ } finally {
      if (thumbUrl) revokeBlobUrls([thumbUrl]);
    }

    // Generate from file
    if (!blob && !ports.cancelled()) {
      try {
        const file = await source.getFile(ref, signal);
        log?.(`getFile(${file ? Math.round(file.size / 1024) + 'KB' : 'null'})`);
        if (file && !ports.cancelled()) {
          blob = await ports.fromOriginal(file);
          log?.('decoded');

          // Save sidecar thumbnail to .dat (no blurHash here - generated later)
          if (!ports.cancelled() && source.writeSidecarThumb) {
            source.writeSidecarThumb(ref, blob)
              .then((ok) => { if (ok) ports.onSidecarWritten(); })
              .catch(() => {});
            log?.('sidecar-written');
          }
        }
      } catch { log?.('decode-error'); }
    }

    if (blob && blob.size > 0 && !ports.cancelled()) {
      // Persist under the source key regardless - that is a different slot and
      // nothing else writes it.
      ports.writeStored(thumbKeys[0], blob);

      await showSource(blob);
      log?.('displayed');
    } else {
      log?.(`not-displayed(cancelled=${ports.cancelled()})`);
    }
  } finally {
    ports.dequeue();
    log?.('done');
  }
}
