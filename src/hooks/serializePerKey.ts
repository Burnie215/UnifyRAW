/**
 * Chain async work per key: a call waits for every earlier call with the same
 * key to settle, calls with different keys run side by side.
 *
 * A failed predecessor must not block its successor, so the chain swallows the
 * previous result before starting the next; the caller of the failing call
 * still sees its own rejection.
 */
export function serializePerKey(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const inflight = new Map<string, Promise<unknown>>();
  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const next = (inflight.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    inflight.set(key, next);
    const settle = () => {
      if (inflight.get(key) === next) inflight.delete(key);
    };
    next.then(settle, settle);
    return next;
  };
}
