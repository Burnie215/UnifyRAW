/**
 * The slots every on-demand thumbnail load waits for before its heavy part
 * (source fetch, decode).
 *
 * Opening the editor throttles the queue rather than stopping it. At zero the
 * filmstrip and the editor's own loading placeholder, which load through here
 * too, stayed empty for the whole session - and requests made in that time
 * were parked on a promise nothing ever resolved, so leaving the editor did
 * not bring them back either. One slot keeps the RAW decode ahead while the
 * filmstrip still fills.
 */

export interface QueueEntry { resolve: () => void; cancelled: boolean }

const DEFAULT_LIMIT = 6;
const PAUSED_LIMIT = 1;

let limit = DEFAULT_LIMIT;
let active = 0;
const queue: QueueEntry[] = [];

function startWaiting(): void {
  while (active < limit && queue.length > 0) {
    const next = queue.pop()!; // LIFO: the tile scrolled to last goes first
    if (next.cancelled) continue;
    active++;
    next.resolve();
  }
}

export function enqueue(entry: QueueEntry): Promise<void> {
  if (active < limit) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    entry.resolve = resolve;
    queue.push(entry);
  });
}

export function dequeue(): void {
  active--;
  startWaiting();
}

export function setThumbnailQueueLimit(next: number): void {
  limit = next;
  startWaiting();
}

export function pauseThumbnailQueue(): void {
  setThumbnailQueueLimit(PAUSED_LIMIT);
}

export function resumeThumbnailQueue(): void {
  setThumbnailQueueLimit(DEFAULT_LIMIT);
}

/** Returns true when no thumbnails are being generated and queue is empty */
export function isThumbnailQueueIdle(): boolean {
  return active === 0 && queue.length === 0;
}

export function thumbnailQueueDepth(): { active: number; queued: number } {
  return { active, queued: queue.length };
}
