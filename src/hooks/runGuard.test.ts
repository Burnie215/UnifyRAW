import { describe, expect, it } from 'vitest';
import { createRunGuard } from './runGuard';

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Let every pending microtask and timer-free continuation run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createRunGuard', () => {
  it('makes every earlier claim stale', () => {
    const guard = createRunGuard();

    const first = guard.claim();
    expect(first()).toBe(false);

    const second = guard.claim();
    expect(first()).toBe(true);
    expect(second()).toBe(false);
  });

  it('retires the claim an effect cleanup leaves behind', () => {
    const guard = createRunGuard();
    const only = guard.claim();

    guard.retire();

    expect(only()).toBe(true);
  });

  it('does not start a pass whose claim went stale first', async () => {
    const guard = createRunGuard();
    const stale = guard.claim();
    guard.retire();

    let ran = false;
    await guard.start(stale, async () => { ran = true; });

    expect(ran).toBe(false);
  });

  it('runs only the newest of two passes claimed back to back', async () => {
    const guard = createRunGuard();
    const ran: string[] = [];

    const first = guard.claim();
    const second = guard.claim();
    await Promise.all([
      guard.start(first, async () => { ran.push('first'); }),
      guard.start(second, async () => { ran.push('second'); }),
    ]);

    expect(ran).toEqual(['second']);
  });

  it('starts the next pass only after the running one has left', async () => {
    const guard = createRunGuard();
    const order: string[] = [];
    const blocked = deferred();

    const first = guard.claim();
    const firstRun = guard.start(first, async () => {
      order.push('first-start');
      await blocked.promise;
      order.push('first-end');
    });
    await settle();

    const second = guard.claim();
    const secondRun = guard.start(second, async () => { order.push('second-start'); });
    await settle();
    expect(order).toEqual(['first-start']);

    blocked.resolve();
    await Promise.all([firstRun, secondRun]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });
});
