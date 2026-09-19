/**
 * Lightweight concurrency limiter for CPU-bound subprocess calls (dcraw_emu,
 * sharp, exiftool). Without this, N parallel HTTP requests would spawn N
 * dcraw_emu processes and starve the host CPU.
 *
 * Default cap: 2 concurrent. Each container has typically 2-4 cores assigned,
 * and dcraw_emu is largely single-threaded — running 2 in parallel saturates
 * a 2-4-core container without trashing.
 */

const MAX_CONCURRENT = positiveInteger(process.env.RAW_DECODE_CONCURRENCY, 2);
const MAX_WAITING = positiveInteger(process.env.RAW_DECODE_QUEUE_LIMIT, 16);

export class DecodeQueueFullError extends Error {}

let active = 0;
const waiting: Array<() => void> = [];

export async function runQueued<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_WAITING) {
      throw new DecodeQueueFullError('RAW decode queue is full');
    }
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = waiting.shift();
    if (next) next();
  }
}

export function queueStatus(): { active: number; waiting: number; max: number } {
  return { active, waiting: waiting.length, max: MAX_CONCURRENT };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
