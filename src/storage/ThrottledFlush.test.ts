import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThrottledFlush } from './ThrottledFlush';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('ThrottledFlush', () => {
  it('fires after idleMs of quiet', async () => {
    const fired = vi.fn().mockResolvedValue(undefined);
    const t = new ThrottledFlush(fired, { idleMs: 30, maxMs: 1000 });
    t.schedule();
    expect(fired).not.toHaveBeenCalled();
    await sleep(60);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('coalesces repeated schedules', async () => {
    const fired = vi.fn().mockResolvedValue(undefined);
    const t = new ThrottledFlush(fired, { idleMs: 40, maxMs: 1000 });
    for (let i = 0; i < 5; i++) {
      t.schedule();
      await sleep(10);
    }
    await sleep(80);
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('hits the max ceiling under continuous schedules', async () => {
    const fired = vi.fn().mockResolvedValue(undefined);
    const t = new ThrottledFlush(fired, { idleMs: 60, maxMs: 80 }); // idle wider than max
    for (let i = 0; i < 6; i++) {
      t.schedule();
      await sleep(30);
    }
    // max should have fired at least once before idle would
    expect(fired.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('serializes concurrent fires + queues one follow-up', async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    const worker = async () => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await sleep(40);
      inFlight--;
    };
    const t = new ThrottledFlush(worker, { idleMs: 5, maxMs: 1000 });
    t.schedule();
    await sleep(15); // worker started
    t.schedule(); // queues
    t.schedule(); // collapses into the queued one
    await sleep(150);
    expect(maxConcurrent).toBe(1);
  });

  it('fireNow runs immediately', async () => {
    const fired = vi.fn().mockResolvedValue(undefined);
    const t = new ThrottledFlush(fired, { idleMs: 2000, maxMs: 5000 });
    await t.fireNow();
    expect(fired).toHaveBeenCalledTimes(1);
  });

  it('cancel drops pending timers', async () => {
    const fired = vi.fn().mockResolvedValue(undefined);
    const t = new ThrottledFlush(fired, { idleMs: 30, maxMs: 1000 });
    t.schedule();
    t.cancel();
    await sleep(60);
    expect(fired).not.toHaveBeenCalled();
  });

  it('fireNow during a fire in flight also waits for a fire that saw the latest change', async () => {
    let value = 0;
    let release!: () => void;
    const seen: number[] = [];
    const worker = vi.fn(async () => {
      const snapshot = value;
      if (worker.mock.calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
      seen.push(snapshot);
    });
    const t = new ThrottledFlush(worker, { idleMs: 5000, maxMs: 60_000 });
    const first = t.fireNow();
    value = 1;
    const second = t.fireNow();
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual([0, 1]);
    t.cancel();
  });
});

describe('ThrottledFlush with a failing worker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the failure to onError once and leaves no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const error = new Error('disk full');
      const onError = vi.fn();
      const worker = vi.fn().mockRejectedValue(error);
      const t = new ThrottledFlush(worker, { idleMs: 5, maxMs: 1000, onError, retryBaseMs: 10_000 });
      t.schedule();
      await sleep(40);
      await t.fireNow();
      await sleep(20);
      expect(worker).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenNthCalledWith(1, error);
      expect(t.lastError).toBe(error);
      t.cancel();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('retries after retryBaseMs and clears lastError once a run succeeds', async () => {
    vi.useFakeTimers();
    const worker = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
    const t = new ThrottledFlush(worker, { idleMs: 10, maxMs: 60_000, onError: () => undefined, retryBaseMs: 100, retryMaxMs: 1000 });
    t.schedule();
    await vi.advanceTimersByTimeAsync(10);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(t.lastError).toBeInstanceOf(Error);

    await vi.advanceTimersByTimeAsync(99);
    expect(worker).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(t.lastError).toBeNull();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(worker).toHaveBeenCalledTimes(2);
  });

  it('doubles the wait with every further failure up to retryMaxMs', async () => {
    vi.useFakeTimers();
    const runs: number[] = [];
    const worker = vi.fn(async () => {
      runs.push(Date.now());
      throw new Error('disk full');
    });
    const t = new ThrottledFlush(worker, { idleMs: 10, maxMs: 60_000, onError: () => undefined, retryBaseMs: 100, retryMaxMs: 400 });
    t.schedule();
    await vi.advanceTimersByTimeAsync(10 + 100 + 200 + 400 + 400);
    t.cancel();
    expect(runs.slice(1).map((at, i) => at - runs[i])).toEqual([100, 200, 400, 400]);
  });
});
