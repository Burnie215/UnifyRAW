import { describe, expect, it } from 'vitest';
import { bitExactCompare, formatCompareResult } from './bitExactCompare';
import {
  gradientHorizontal,
  colorSwatches,
  clippingCorners,
  sharpEdges,
  STANDARD_FIXTURES,
} from './syntheticFixtures';

/**
 * Only the pure logic: comparator and fixture generators. The GL suite that
 * compared the old and the new pipeline was removed after the Phase-2 hard
 * cut (PIPELINE_NODE_GRAPH_PLAN §Phase 2); the fixtures live on in
 * PipelineService.browser.test.ts and projectionFixtures.ts.
 */

describe('bitExactCompare', () => {
  it('reports match for identical buffers', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    const r = bitExactCompare(a, b, { width: 1 });
    expect(r.match).toBe(true);
    expect(r.divergentBytes).toBe(0);
    expect(r.firstDivergent).toBeUndefined();
  });

  it('reports byte count + first divergent pixel coordinate', () => {
    const a = new Uint8Array([
      0, 0, 0, 255,   // pixel (0,0)
      0, 0, 0, 255,   // pixel (1,0)
      0, 0, 0, 255,   // pixel (0,1)
      0, 0, 0, 255,   // pixel (1,1)
    ]);
    const b = new Uint8Array([
      0, 0, 0, 255,
      0, 0, 0, 255,
      0, 0, 0, 255,
      0, 0, 5, 255,   // diverges at pixel (1,1).b
    ]);
    const r = bitExactCompare(a, b, { width: 2 });
    expect(r.match).toBe(false);
    expect(r.divergentBytes).toBe(1);
    expect(r.firstDivergent).toEqual({ x: 1, y: 1, channel: 'b', expected: 0, actual: 5 });
  });

  it('handles length mismatch gracefully (no firstDivergent)', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    const r = bitExactCompare(a, b, { width: 1 });
    expect(r.match).toBe(false);
    expect(r.divergentBytes).toBe(2);
    expect(r.firstDivergent).toBeUndefined();
  });

  it('formatCompareResult is descriptive for failures', () => {
    const a = new Uint8Array([255, 0, 0, 255]);
    const b = new Uint8Array([0, 0, 0, 255]);
    const r = bitExactCompare(a, b, { width: 1 });
    const msg = formatCompareResult(r, a.length);
    expect(msg).toMatch(/divergent bytes/);
    expect(msg).toMatch(/\(0,0\)\.r/);
  });
});

describe('syntheticFixtures', () => {
  it('gradientHorizontal sweeps 0..255 across x', () => {
    const f = gradientHorizontal(256, 1);
    expect(f.pixels[0]).toBe(0);            // x=0 → 0
    expect(f.pixels[255 * 4]).toBe(255);    // x=255 → 255
    expect(f.pixels[3]).toBe(255);          // alpha
  });

  it('colorSwatches lays out 8 distinct hues', () => {
    const f = colorSwatches(8);
    expect(f.width).toBe(32);
    expect(f.height).toBe(16);
    // Top-left pixel: red swatch
    expect(f.pixels[0]).toBe(255);
    expect(f.pixels[1]).toBe(0);
    expect(f.pixels[2]).toBe(0);
  });

  it('clippingCorners has the right quadrant values', () => {
    const f = clippingCorners();
    const at = (x: number, y: number) => f.pixels[(y * f.width + x) * 4];
    expect(at(0, 0)).toBe(0);     // TL black
    expect(at(15, 0)).toBe(255);  // TR white
    expect(at(0, 15)).toBe(128);  // BL mid
    expect(at(15, 15)).toBe(4);   // BR near-black
  });

  it('sharpEdges places lines at center', () => {
    const f = sharpEdges(64, 64);
    const at = (x: number, y: number) => f.pixels[(y * f.width + x) * 4];
    expect(at(32, 0)).toBe(255);  // vertical line at x=32
    expect(at(0, 32)).toBe(255);  // horizontal line at y=32
    expect(at(0, 0)).toBe(32);    // background
  });

  it('STANDARD_FIXTURES contains all four', () => {
    expect(STANDARD_FIXTURES.map((f) => f.name)).toEqual([
      'gradient-horizontal',
      'color-swatches',
      'clipping-corners',
      'sharp-edges',
    ]);
  });
});

// The browser-mode suite that bit-compared the classic pipeline against the
// PipelineExecutor for each fixture (compat.browser.test.ts) is deleted with
// the classic pipeline, tag attic/pre-deadcode-2026-09.
// graySweep.browser.test.ts pins the graph's pixels against recorded values.
