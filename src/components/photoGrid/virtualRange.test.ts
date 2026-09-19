import { describe, expect, it } from 'vitest';

import { computeVisibleRange, scrollOffsetToReveal } from './virtualRange';

/**
 * The numbers are the ones from finding F021: a 184 px row (180 px tile plus
 * the 4 px gap), four columns, three buffer rows, a 900 px viewport. Folder A
 * holds 400 photos and is therefore 100 rows / 18400 px tall, folder B follows
 * it in the same scroll parent.
 *
 * Every case asserts an absolute index. A range recomputed from the same inputs
 * it was derived from would agree with any offset, including no offset at all.
 */
const GRID = { viewportSize: 900, rowSize: 184, perRow: 4, bufferRows: 3 };

describe('computeVisibleRange', () => {
  it('renders the first rows of a grid that sits at the top of its scroll parent', () => {
    expect(computeVisibleRange({ ...GRID, scrollOffset: 0, containerOffset: 0, total: 400 }))
      .toEqual({ start: 0, end: 32 });
  });

  it('renders the first rows of the SECOND grid once the scroll position reaches it', () => {
    expect(computeVisibleRange({ ...GRID, scrollOffset: 18400, containerOffset: 18400, total: 100 }))
      .toEqual({ start: 0, end: 32 });
  });

  it('renders nothing for that grid when its offset is ignored (the shipped bug)', () => {
    expect(computeVisibleRange({ ...GRID, scrollOffset: 18400, containerOffset: 0, total: 100 }))
      .toEqual({ start: 0, end: 0 });
  });

  it('keeps a buffer above and below the viewport', () => {
    expect(computeVisibleRange({ ...GRID, scrollOffset: 3680, containerOffset: 0, total: 400 }))
      .toEqual({ start: 68, end: 112 });
  });

  it('renders exactly the visible rows with no buffer', () => {
    expect(computeVisibleRange({ ...GRID, bufferRows: 0, scrollOffset: 3680, containerOffset: 0, total: 400 }))
      .toEqual({ start: 80, end: 100 });
  });

  it('renders nothing for a container still below the viewport', () => {
    expect(computeVisibleRange({ ...GRID, scrollOffset: 0, containerOffset: 18400, total: 100 }))
      .toEqual({ start: 0, end: 0 });
  });

  it('renders nothing for a container already scrolled past', () => {
    expect(computeVisibleRange({ ...GRID, scrollOffset: 30000, containerOffset: 0, total: 400 }))
      .toEqual({ start: 0, end: 0 });
  });

  it('clamps the end to the item count, not to a full last row', () => {
    expect(computeVisibleRange({ ...GRID, scrollOffset: 0, containerOffset: 0, total: 10 }))
      .toEqual({ start: 0, end: 10 });
    expect(computeVisibleRange({ ...GRID, scrollOffset: 17000, containerOffset: 0, total: 400 }))
      .toEqual({ start: 356, end: 400 });
  });

  it('treats a horizontal strip as one item per row', () => {
    const strip = { viewportSize: 800, rowSize: 104, perRow: 1, bufferRows: 3, total: 10_000 };
    expect(computeVisibleRange({ ...strip, scrollOffset: 8, containerOffset: 8 }))
      .toEqual({ start: 0, end: 11 });
    expect(computeVisibleRange({ ...strip, scrollOffset: 5208, containerOffset: 8 }))
      .toEqual({ start: 47, end: 61 });
  });

  it('renders nothing when it has no geometry to work with', () => {
    const base = { ...GRID, scrollOffset: 0, containerOffset: 0, total: 400 };
    expect(computeVisibleRange({ ...base, rowSize: 0 })).toEqual({ start: 0, end: 0 });
    expect(computeVisibleRange({ ...base, perRow: 0 })).toEqual({ start: 0, end: 0 });
    expect(computeVisibleRange({ ...base, total: 0 })).toEqual({ start: 0, end: 0 });
    expect(computeVisibleRange({ ...base, containerOffset: Number.NaN })).toEqual({ start: 0, end: 0 });
  });
});

/**
 * The gallery strip's real numbers: a 90 px strip minus its 16 px padding is a
 * 74 px thumbnail, plus a 4 px gap is one column every 78 px, and the track
 * begins 8 px into the strip's scrollable content. Every case asserts the
 * absolute offset, not "it scrolled".
 */
const STRIP = { viewportSize: 800, containerOffset: 8, rowSize: 78, itemSize: 74, perRow: 1, total: 10_000 };

describe('scrollOffsetToReveal', () => {
  it('leaves a thumbnail that is already fully on screen alone', () => {
    expect(scrollOffsetToReveal({ ...STRIP, index: 0, scrollOffset: 0 })).toBeNull();
    // Item 9 ends at 8 + 9*78 + 74 = 784, the last one that fits at offset 0.
    expect(scrollOffsetToReveal({ ...STRIP, index: 9, scrollOffset: 0 })).toBeNull();
  });

  it('scrolls just far enough to show a thumbnail past the right edge', () => {
    // Item 10 ends at 8 + 10*78 + 74 = 862, so 862 - 800 = 62.
    expect(scrollOffsetToReveal({ ...STRIP, index: 10, scrollOffset: 0 })).toBe(62);
    // Item 40 ends at 8 + 40*78 + 74 = 3202.
    expect(scrollOffsetToReveal({ ...STRIP, index: 40, scrollOffset: 0 })).toBe(2402);
  });

  it('scrolls back to a thumbnail that is left of the viewport', () => {
    // Item 40 starts at 8 + 40*78 = 3128.
    expect(scrollOffsetToReveal({ ...STRIP, index: 40, scrollOffset: 5000 })).toBe(3128);
  });

  it('scrolls back to the very first thumbnail, padding and all', () => {
    expect(scrollOffsetToReveal({ ...STRIP, index: 0, scrollOffset: 400 })).toBe(8);
  });

  it('never asks for a negative offset', () => {
    expect(scrollOffsetToReveal({ ...STRIP, containerOffset: -20, index: 0, scrollOffset: 100 })).toBe(0);
  });

  it('shows the beginning of an item too big for the viewport', () => {
    const wide = { ...STRIP, viewportSize: 50, rowSize: 78, itemSize: 74 };
    expect(scrollOffsetToReveal({ ...wide, index: 3, scrollOffset: 0 })).toBe(242);
  });

  it('has nothing to reveal without geometry or without the item', () => {
    const base = { ...STRIP, index: 40, scrollOffset: 0 };
    expect(scrollOffsetToReveal({ ...base, rowSize: 0 })).toBeNull();
    expect(scrollOffsetToReveal({ ...base, itemSize: 0 })).toBeNull();
    expect(scrollOffsetToReveal({ ...base, viewportSize: 0 })).toBeNull();
    expect(scrollOffsetToReveal({ ...base, index: 10_000 })).toBeNull();
    expect(scrollOffsetToReveal({ ...base, index: -1 })).toBeNull();
    expect(scrollOffsetToReveal({ ...base, containerOffset: Number.NaN })).toBeNull();
  });
});
