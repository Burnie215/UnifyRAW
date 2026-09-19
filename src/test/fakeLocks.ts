import { vi } from 'vitest';

/**
 * In-memory Web Locks for node tests: exclusive locks, `ifAvailable`,
 * `signal`, first-in-first-out hand-over to waiters. Node 20 (the container)
 * has no `navigator.locks` at all.
 */
type LockCallback = (lock: Lock | null) => unknown;

function abortError(): DOMException {
  return new DOMException('The lock request was aborted', 'AbortError');
}

export class FakeLockManager {
  private readonly held = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  async request(name: string, optionsOrCallback: LockOptions | LockCallback, maybeCallback?: LockCallback): Promise<unknown> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
    if (options.signal?.aborted) throw abortError();
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await this.enqueue(name, options.signal);
    } else {
      this.held.add(name);
    }
    try {
      return await callback({ name, mode: options.mode ?? 'exclusive' } as Lock);
    } finally {
      this.handOver(name);
    }
  }

  isHeld(name: string): boolean {
    return this.held.has(name);
  }

  private enqueue(name: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const queue = this.waiters.get(name) ?? [];
      this.waiters.set(name, queue);
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = queue.indexOf(grant);
        if (index >= 0) queue.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(grant);
    });
  }

  private handOver(name: string): void {
    const next = this.waiters.get(name)?.shift();
    if (next) next();
    else this.held.delete(name);
  }
}

/** Installs a fresh FakeLockManager as `navigator.locks`; undo with vi.unstubAllGlobals(). */
export function stubWebLocks(): FakeLockManager {
  const locks = new FakeLockManager();
  vi.stubGlobal('navigator', { locks });
  return locks;
}
