import { afterEach, describe, expect, it, vi } from 'vitest';

type DecodeQueue = typeof import('./decodeQueue.js');

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// The limits are read once at import time, so every test needs a fresh module.
async function loadQueue(concurrency = '1', queueLimit = '1'): Promise<DecodeQueue> {
  vi.stubEnv('RAW_DECODE_CONCURRENCY', concurrency);
  vi.stubEnv('RAW_DECODE_QUEUE_LIMIT', queueLimit);
  vi.resetModules();
  return import('./decodeQueue.js');
}

// A macrotask, so a queue that only awaited an extra microtask would still be caught.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('RAW decode queue', () => {
  it('holds the second decode until the first one finishes', async () => {
    const queue = await loadQueue();
    const firstDecode = deferred<string>();
    const secondFn = vi.fn(() => Promise.resolve('second'));

    const first = queue.runQueued(() => firstDecode.promise);
    const second = queue.runQueued(secondFn);
    await settle();
    expect(secondFn).not.toHaveBeenCalled();

    firstDecode.resolve('first');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(secondFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a decode beyond the waiting limit without running it', async () => {
    const queue = await loadQueue();
    const firstDecode = deferred<string>();
    const thirdFn = vi.fn(() => Promise.resolve('third'));

    const first = queue.runQueued(() => firstDecode.promise);
    const second = queue.runQueued(() => Promise.resolve('second'));
    const third = queue.runQueued(thirdFn);

    expect(queue.queueStatus().waiting).toBe(1);
    await expect(third).rejects.toBeInstanceOf(queue.DecodeQueueFullError);
    await expect(third).rejects.toThrow('RAW decode queue is full');
    expect(thirdFn).not.toHaveBeenCalled();

    firstDecode.resolve('first');
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('reports running and waiting decodes', async () => {
    const queue = await loadQueue();
    const firstDecode = deferred<void>();
    expect(queue.queueStatus()).toEqual({ active: 0, waiting: 0, max: 1 });

    const first = queue.runQueued(() => firstDecode.promise);
    expect(queue.queueStatus()).toEqual({ active: 1, waiting: 0, max: 1 });

    const second = queue.runQueued(() => Promise.resolve());
    expect(queue.queueStatus()).toEqual({ active: 1, waiting: 1, max: 1 });

    firstDecode.resolve();
    await first;
    await second;
    expect(queue.queueStatus()).toEqual({ active: 0, waiting: 0, max: 1 });
  });

  it('releases the waiting decode when the running one fails', async () => {
    const queue = await loadQueue();
    const firstDecode = deferred<string>();
    const secondFn = vi.fn(() => Promise.resolve('second'));

    const first = queue.runQueued(() => firstDecode.promise);
    const second = queue.runQueued(secondFn);

    firstDecode.reject(new Error('dcraw_emu crashed'));
    await expect(first).rejects.toThrow('dcraw_emu crashed');
    await expect(second).resolves.toBe('second');
    expect(secondFn).toHaveBeenCalledTimes(1);
    expect(queue.queueStatus()).toEqual({ active: 0, waiting: 0, max: 1 });
  });

  // The woken waiter resumes one microtask after the release; every caller
  // that could slip in first (a .then on the finished decode, a microtask it
  // queued, a new request) runs later than that, so the limit and the order
  // hold without handing the slot over explicitly.
  it('keeps the limit and the order when callers pile in as a decode finishes', async () => {
    const queue = await loadQueue('1', '10');
    let running = 0;
    let peak = 0;
    const started: string[] = [];
    const job = (name: string) => async () => {
      running++;
      peak = Math.max(peak, running);
      started.push(name);
      await settle();
      running--;
      return name;
    };

    const a = queue.runQueued(async () => {
      const result = await job('a')();
      queueMicrotask(() => { void queue.runQueued(job('late-microtask')); });
      return result;
    });
    const b = queue.runQueued(job('b'));
    const lateThen = a.then(() => queue.runQueued(job('late-then')));

    await Promise.all([a, b, lateThen]);
    await vi.waitFor(() => expect(queue.queueStatus()).toEqual({ active: 0, waiting: 0, max: 1 }));
    expect(peak).toBe(1);
    expect(started).toEqual(['a', 'b', 'late-microtask', 'late-then']);
  });

  it('falls back to two concurrent decodes for an unusable setting', async () => {
    const queue = await loadQueue('0', 'many');
    expect(queue.queueStatus().max).toBe(2);
  });
});
