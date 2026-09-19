/**
 * One background pass at a time, with an effect able to hand over to itself.
 *
 * An effect that starts a long async pass has to survive a rerun in the middle
 * of one: the running pass must stop, and the new one must start with the new
 * data once the old has actually left. A cancelled flag cannot do that - the
 * rerun clears it before the running pass has seen it, so the pass carries on
 * with the old closure and, because that branch registers no cleanup, keeps
 * running after unmount against a closed storage (F122).
 */
export interface RunGuard {
  /**
   * Register a pass. Every pass claimed earlier is stale from here on; the
   * returned predicate is what the new pass checks instead of a flag.
   */
  claim(): () => boolean;
  /** Make every claimed pass stale. The effect's cleanup calls this. */
  retire(): void;
  /**
   * Run `body` once the previously started pass has left, unless this claim
   * went stale while waiting. Two starts for the same guard never overlap,
   * and a start whose claim is already stale does not run at all.
   */
  start(stale: () => boolean, body: () => Promise<void>): Promise<void>;
}

export function createRunGuard(): RunGuard {
  let current = 0;
  let previous: Promise<void> = Promise.resolve();

  return {
    claim() {
      const mine = ++current;
      return () => mine !== current;
    },

    retire() {
      current += 1;
    },

    async start(stale, body) {
      const earlier = previous;
      let left = () => {};
      previous = new Promise<void>((resolve) => { left = resolve; });
      try {
        await earlier;
        if (stale()) return;
        await body();
      } finally {
        left();
      }
    },
  };
}
