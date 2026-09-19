/**
 * Which slice of a virtualised grid is worth rendering.
 *
 * Axis-neutral on purpose. The tile grids scroll vertically, where a row holds
 * `perRow` tiles; the gallery strip scrolls horizontally, where a "row" is one
 * column and `perRow` is 1. Both want the same arithmetic, so both ask here.
 *
 * `containerOffset` is the part the folder grouping needs: several grids share
 * one scroll parent, so a grid must subtract where it begins inside that parent
 * before a scroll position means anything in its own rows.
 */
export interface VisibleRangeInput {
  /** Scroll position of the scroll parent along the virtualised axis. */
  scrollOffset: number;
  /** Visible size of the scroll parent along that axis. */
  viewportSize: number;
  /** Where this container starts inside the scroll parent's scrollable content. */
  containerOffset: number;
  /** Size of one row including the gap that follows it. */
  rowSize: number;
  /** Items per row; 1 for a horizontal strip. */
  perRow: number;
  /** Items held by this container. */
  total: number;
  /** Extra rows kept rendered on each side of the viewport. */
  bufferRows: number;
}

export interface VisibleRange {
  start: number;
  end: number;
}

const EMPTY: VisibleRange = { start: 0, end: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeVisibleRange({
  scrollOffset, viewportSize, containerOffset, rowSize, perRow, total, bufferRows,
}: VisibleRangeInput): VisibleRange {
  if (!Number.isFinite(rowSize) || rowSize <= 0) return EMPTY;
  if (!Number.isFinite(perRow) || perRow < 1) return EMPTY;
  if (!Number.isFinite(total) || total <= 0) return EMPTY;
  if (!Number.isFinite(scrollOffset) || !Number.isFinite(containerOffset)) return EMPTY;
  if (!Number.isFinite(viewportSize) || viewportSize < 0) return EMPTY;

  const localOffset = scrollOffset - containerOffset;
  const rows = Math.ceil(total / perRow);
  const buffer = Number.isFinite(bufferRows) ? Math.max(0, Math.floor(bufferRows)) : 0;
  const firstRow = clamp(Math.floor(localOffset / rowSize) - buffer, 0, rows);
  const lastRow = clamp(Math.ceil((localOffset + viewportSize) / rowSize) + buffer, 0, rows);
  const start = firstRow * perRow;
  const end = Math.min(total, lastRow * perRow);

  // Scrolled past this container, or not reached yet: nothing of it is worth
  // mounting, and a start beyond `end` would only confuse the padding.
  return end > start ? { start, end } : EMPTY;
}

export interface RevealInput {
  /** The item that has to be on screen. */
  index: number;
  /** Scroll position of the scroll parent along the virtualised axis. */
  scrollOffset: number;
  /** Visible size of the scroll parent along that axis. */
  viewportSize: number;
  /** Where this container starts inside the scroll parent's scrollable content. */
  containerOffset: number;
  /** Size of one row including the gap that follows it. */
  rowSize: number;
  /** Size of one row without that gap - what actually has to fit on screen. */
  itemSize: number;
  /** Items per row; 1 for a horizontal strip. */
  perRow: number;
  /** Items held by this container. */
  total: number;
}

/**
 * The scroll offset that brings `index` fully into view, or `null` when it
 * already is.
 *
 * The counterpart to `computeVisibleRange` and deliberately its neighbour: the
 * two describe the same geometry from opposite ends, and a second model of
 * where an item sits is exactly how a virtualised list drifts. It matters more
 * here than in an ordinary list - an item outside the range is not merely
 * off screen, it is not in the DOM, so nothing can scroll it into view later.
 */
export function scrollOffsetToReveal({
  index, scrollOffset, viewportSize, containerOffset, rowSize, itemSize, perRow, total,
}: RevealInput): number | null {
  if (!Number.isFinite(rowSize) || rowSize <= 0) return null;
  if (!Number.isFinite(itemSize) || itemSize <= 0) return null;
  if (!Number.isFinite(perRow) || perRow < 1) return null;
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(index) || index < 0 || index >= total) return null;
  if (!Number.isFinite(scrollOffset) || !Number.isFinite(containerOffset)) return null;
  if (!Number.isFinite(viewportSize) || viewportSize <= 0) return null;

  const start = containerOffset + Math.floor(index / perRow) * rowSize;
  const end = start + itemSize;

  if (start < scrollOffset) return Math.max(0, start);
  if (end > scrollOffset + viewportSize) {
    // The smaller of the two is the near edge: normally that is "just far
    // enough" (end - viewportSize), and for an item taller than the viewport
    // it is its own start, so the item begins on screen instead of ending there.
    return Math.max(0, Math.min(start, end - viewportSize));
  }
  return null;
}
