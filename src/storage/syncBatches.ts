export interface PushBatchLimits {
  /** Largest JSON array a batch may serialize to. A single row above it travels alone. */
  maxBytes: number;
  maxRows: number;
  /** Rows above this never travel; the hub would refuse them anyway. */
  rowBytesLimit: number;
}

export interface PushBatches<T> {
  batches: T[][];
  oversized: T[];
}

const encoder = new TextEncoder();

/** Bytes of a value as the hub measures a pushed row: its UTF-8 JSON. */
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/**
 * Cut rows, in their order, into batches that each serialize to at most
 * maxBytes and hold at most maxRows rows. Rows above rowBytesLimit are left
 * out of every batch and returned in `oversized`.
 */
export function splitPushBatches<T>(
  rows: readonly T[],
  limits: PushBatchLimits,
  sizeOf: (row: T) => number = jsonBytes,
): PushBatches<T> {
  const batches: T[][] = [];
  const oversized: T[] = [];
  let batch: T[] = [];
  // "[" + "]" for the array, one comma per further row.
  let batchBytes = 2;
  for (const row of rows) {
    const size = sizeOf(row);
    if (size > limits.rowBytesLimit) {
      oversized.push(row);
      continue;
    }
    const added = batch.length === 0 ? size : size + 1;
    if (batch.length > 0 && (batch.length >= limits.maxRows || batchBytes + added > limits.maxBytes)) {
      batches.push(batch);
      batch = [];
      batchBytes = 2 + size;
    } else {
      batchBytes += added;
    }
    batch.push(row);
  }
  if (batch.length > 0) batches.push(batch);
  return { batches, oversized };
}
