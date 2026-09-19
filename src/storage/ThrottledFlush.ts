export interface ThrottledFlushOptions {
  /** Quiet time after the last schedule() before the worker runs. */
  idleMs?: number;
  /** Upper bound since the first schedule() after the last fire. */
  maxMs?: number;
  /** Called with every worker failure; the fire is retried after a backoff. */
  onError?: (error: unknown) => void;
  /** Wait before the first retry after a failure; doubles with each further failure. */
  retryBaseMs?: number;
  /** Ceiling for the retry wait. */
  retryMaxMs?: number;
}

/**
 * Debounced flush with a hard upper bound. Calling schedule() restarts the
 * idle timer; the worker fires either after `idleMs` of quiet or `maxMs`
 * since the first schedule call since the last fire, whichever comes first.
 *
 * Concurrent fires are serialized: a new fire scheduled while one is in
 * flight queues exactly one follow-up.
 *
 * A failing worker never rejects a fire. The failure goes to `onError`, stays
 * readable as `lastError`, and the fire is retried after `retryBaseMs`,
 * doubling up to `retryMaxMs`, until one succeeds.
 */
export class ThrottledFlush {
  private readonly worker: () => Promise<void>;
  private readonly idleMs: number;
  private readonly maxMs: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private rescheduleAfter = false;
  private failures = 0;
  private error: unknown = null;

  constructor(worker: () => Promise<void>, {
    idleMs = 2000,
    maxMs = 30_000,
    onError,
    retryBaseMs = 1000,
    retryMaxMs = 30_000,
  }: ThrottledFlushOptions = {}) {
    this.worker = worker;
    this.idleMs = idleMs;
    this.maxMs = maxMs;
    this.onError = onError;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
  }

  /** The failure of the last fire; null once a fire has succeeded. */
  get lastError(): unknown {
    return this.error;
  }

  /** Mark dirty. Worker runs after idleMs of quiet or maxMs since first call. */
  schedule(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.fire(); }, this.failures > 0 ? this.retryDelay() : this.idleMs);

    if (!this.maxTimer) {
      this.maxTimer = setTimeout(() => { void this.fire(); }, this.maxMs);
    }
  }

  /**
   * Run the worker now (skips debounce). A fire already in flight may have
   * read its data before the caller's last change, so this waits for it and
   * then for a fire that starts after the call.
   */
  async fireNow(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    return this.fire();
  }

  /** Wait for any in-flight fire to drain. Does not schedule a new one. */
  async drain(): Promise<void> {
    if (this.inFlight) await this.inFlight;
  }

  /** Cancel any pending fire without running it, retries included. */
  cancel(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }
    this.rescheduleAfter = false;
  }

  private retryDelay(): number {
    return Math.min(this.retryBaseMs * 2 ** (this.failures - 1), this.retryMaxMs);
  }

  private async fire(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.maxTimer) { clearTimeout(this.maxTimer); this.maxTimer = null; }

    if (this.inFlight) {
      this.rescheduleAfter = true;
      return this.inFlight;
    }

    this.inFlight = (async () => {
      try {
        await this.worker();
        this.failures = 0;
        this.error = null;
      } catch (e) {
        this.failures++;
        this.error = e;
        this.rescheduleAfter = true;
        this.onError?.(e);
      } finally {
        this.inFlight = null;
        if (this.rescheduleAfter) {
          this.rescheduleAfter = false;
          this.schedule();
        }
      }
    })();
    return this.inFlight;
  }
}
