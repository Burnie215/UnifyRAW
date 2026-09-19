import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from './thumbnailQueue';

// The queue is module state; every test gets a fresh copy.
let q: typeof import('./thumbnailQueue');

beforeEach(async () => {
  vi.resetModules();
  q = await import('./thumbnailQueue');
});

function entry(): QueueEntry {
  return { resolve: () => {}, cancelled: false };
}

function track(promise: Promise<void>): { started: boolean; promise: Promise<void> } {
  const state = { started: false, promise };
  void promise.then(() => { state.started = true; });
  return state;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function within(promise: Promise<void>, ms: number): Promise<'started' | 'timeout'> {
  return Promise.race([
    promise.then(() => 'started' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms)),
  ]);
}

describe('thumbnail queue', () => {
  it('runs six loads at once and lets the seventh wait for a free slot', async () => {
    const loads = Array.from({ length: 7 }, () => track(q.enqueue(entry())));
    await settle();
    expect(loads.filter((load) => load.started)).toHaveLength(6);

    q.dequeue();
    await settle();
    expect(loads.every((load) => load.started)).toBe(true);
  });

  it('keeps one slot open while paused and never parks a request for good', async () => {
    q.pauseThumbnailQueue();
    const first = track(q.enqueue(entry()));
    const second = track(q.enqueue(entry()));
    await settle();
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);

    q.resumeThumbnailQueue();
    await expect(within(second.promise, 50)).resolves.toBe('started');
  });

  it('does not drop what was already waiting when it pauses', async () => {
    for (let i = 0; i < 6; i++) await q.enqueue(entry());
    const waiting = [track(q.enqueue(entry())), track(q.enqueue(entry()))];

    q.pauseThumbnailQueue();
    q.resumeThumbnailQueue();
    q.dequeue();
    q.dequeue();
    await settle();

    expect(waiting.every((load) => load.started)).toBe(true);
  });

  it('starts waiting loads up to the full limit on resume', async () => {
    q.pauseThumbnailQueue();
    const loads = Array.from({ length: 8 }, () => track(q.enqueue(entry())));
    await settle();
    expect(loads.filter((load) => load.started)).toHaveLength(1);

    q.resumeThumbnailQueue();
    await settle();
    expect(loads.filter((load) => load.started)).toHaveLength(6);
    expect(q.thumbnailQueueDepth()).toEqual({ active: 6, queued: 2 });
  });

  it('skips a load whose tile went away while it waited', async () => {
    for (let i = 0; i < 6; i++) await q.enqueue(entry());
    const gone = entry();
    const load = track(q.enqueue(gone));
    gone.cancelled = true;

    q.dequeue();
    await settle();

    expect(load.started).toBe(false);
    expect(q.thumbnailQueueDepth()).toEqual({ active: 5, queued: 0 });
  });

  it('reports idle only with nothing running and nothing waiting', async () => {
    expect(q.isThumbnailQueueIdle()).toBe(true);
    await q.enqueue(entry());
    expect(q.isThumbnailQueueIdle()).toBe(false);
    q.dequeue();
    expect(q.isThumbnailQueueIdle()).toBe(true);
  });
});
