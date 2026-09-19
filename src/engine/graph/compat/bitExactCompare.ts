/**
 * Bit-exact pixel comparison for compat tests, written for the classic
 * pipeline (deleted, tag attic/pre-deadcode-2026-09) against the graph-based
 * PipelineExecutor.
 *
 * Phase 0 policy: identical math must produce identical pixels. No LSB
 * tolerance — tolerance hides real implementation drift. Phase 2 (linear
 * math hard-cut) flips this to an explicit "expected drift" baseline.
 */

export interface CompareResult {
  /** True iff every byte matches. */
  match: boolean;
  /** Number of bytes that differ across the two buffers. */
  divergentBytes: number;
  /** First divergent (x, y) pair if any, in pixel coordinates. */
  firstDivergent?: {
    x: number;
    y: number;
    channel: 'r' | 'g' | 'b' | 'a';
    expected: number;
    actual: number;
  };
}

export interface CompareOptions {
  /** Sample width — needed to project byte offsets back to (x, y). */
  width: number;
  /** Buffers must agree on channel count (RGBA = 4). */
  channelsPerPixel?: number;
}

/**
 * Compare two RGBA byte buffers byte-for-byte. Returns a structured result
 * with divergence count and first-divergence location so test failures
 * point straight at the offending pixel.
 */
export function bitExactCompare(
  expected: Uint8Array,
  actual: Uint8Array,
  opts: CompareOptions,
): CompareResult {
  const channels = opts.channelsPerPixel ?? 4;
  if (expected.length !== actual.length) {
    return {
      match: false,
      divergentBytes: Math.abs(expected.length - actual.length),
      firstDivergent: undefined,
    };
  }

  let divergent = 0;
  let firstDivergent: CompareResult['firstDivergent'] | undefined;

  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== actual[i]) {
      divergent++;
      if (!firstDivergent) {
        const pixelIdx = Math.floor(i / channels);
        const channelIdx = i % channels;
        firstDivergent = {
          x: pixelIdx % opts.width,
          y: Math.floor(pixelIdx / opts.width),
          channel: (['r', 'g', 'b', 'a'][channelIdx] ?? 'a') as 'r' | 'g' | 'b' | 'a',
          expected: expected[i],
          actual: actual[i],
        };
      }
    }
  }

  return {
    match: divergent === 0,
    divergentBytes: divergent,
    firstDivergent,
  };
}

/**
 * Pretty-format a CompareResult for vitest failure output. Use in
 * `expect(result.match).toBe(true)` style assertions by tagging the
 * description with `formatCompareResult(result)`.
 */
export function formatCompareResult(result: CompareResult, totalBytes?: number): string {
  if (result.match) return 'OK — bit-identical';
  const pct = totalBytes ? ` (${((result.divergentBytes / totalBytes) * 100).toFixed(2)}%)` : '';
  const where = result.firstDivergent
    ? ` first divergence at (${result.firstDivergent.x},${result.firstDivergent.y}).` +
      `${result.firstDivergent.channel}: expected=${result.firstDivergent.expected} ` +
      `actual=${result.firstDivergent.actual}`
    : '';
  return `${result.divergentBytes} divergent bytes${pct}.${where}`;
}
