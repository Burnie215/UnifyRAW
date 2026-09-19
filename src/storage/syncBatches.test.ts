import { describe, expect, it } from 'vitest';
import { jsonBytes, splitPushBatches } from './syncBatches';

const row = (id: string, pad: number) => ({ id, pad: 'x'.repeat(pad) });

describe('splitPushBatches', () => {
  it('fills each batch up to maxBytes of serialized JSON, rows in order', () => {
    const rows = Array.from({ length: 12 }, (_, index) => row(`r${index}`, 20));
    // Room for four rows only if the commas between them are not counted: three fit.
    const limits = { maxBytes: 2 + 4 * jsonBytes(rows[0]), maxRows: 100, rowBytesLimit: 1000 };

    const { batches, oversized } = splitPushBatches(rows, limits);

    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 3, 3]);
    expect(batches.flat()).toEqual(rows);
    expect(oversized).toEqual([]);
    for (const batch of batches) expect(jsonBytes(batch)).toBeLessThanOrEqual(limits.maxBytes);
    // Full, not just small: the next row would not have fitted.
    for (let index = 0; index < batches.length - 1; index += 1) {
      expect(jsonBytes([...batches[index], batches[index + 1][0]])).toBeGreaterThan(limits.maxBytes);
    }
  });

  it('closes a batch at maxRows', () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(`r${index}`, 1));
    const { batches } = splitPushBatches(rows, { maxBytes: 10_000, maxRows: 3, rowBytesLimit: 1000 });
    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 3, 1]);
  });

  it('leaves rows above rowBytesLimit out of every batch and returns them in oversized', () => {
    const small = [row('a', 5), row('c', 5)];
    const big = row('b', 500);
    const { batches, oversized } = splitPushBatches([small[0], big, small[1]], {
      maxBytes: 10_000, maxRows: 100, rowBytesLimit: 100,
    });
    expect(batches).toEqual([small]);
    expect(oversized).toEqual([big]);
  });

  it('sends a row above maxBytes but within rowBytesLimit alone', () => {
    const rows = [row('a', 5), row('big', 300), row('c', 5)];
    const { batches, oversized } = splitPushBatches(rows, { maxBytes: 100, maxRows: 100, rowBytesLimit: 1000 });
    expect(batches).toEqual([[rows[0]], [rows[1]], [rows[2]]]);
    expect(oversized).toEqual([]);
  });

  it('counts UTF-8 bytes, not string length', () => {
    const umlauts = { id: 'u', pad: 'ü'.repeat(40) };
    expect(jsonBytes(umlauts)).toBe(JSON.stringify(umlauts).length + 40);
    const { oversized } = splitPushBatches([umlauts], {
      maxBytes: 1000, maxRows: 10, rowBytesLimit: JSON.stringify(umlauts).length,
    });
    expect(oversized).toEqual([umlauts]);
  });

  it('returns no batches for no rows', () => {
    expect(splitPushBatches([], { maxBytes: 10, maxRows: 1, rowBytesLimit: 10 })).toEqual({ batches: [], oversized: [] });
  });
});
