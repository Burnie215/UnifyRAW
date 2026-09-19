import { MAX_PINCH_TILE_SIZE, MIN_PINCH_TILE_SIZE } from './pinchTileSize';

export const GRID_TILE_GAP = 4;

const PHONE_DENSE_COLUMNS = 4;
const PHONE_LARGE_COLUMNS = 2;
const MIN_RENDERED_PHONE_TILE_SIZE = 64;

function tileSizeForColumns(availableWidth: number, columns: number): number {
  return Math.floor((availableWidth - GRID_TILE_GAP * (columns - 1)) / columns);
}

/**
 * Treat the persisted tile size as a density preference on phone layouts.
 * Mapping the full preference range onto two-to-four columns keeps a desktop
 * value such as 180 or 400 from producing a one-column, overflowing phone
 * grid while preserving useful feedback across the whole slider/pinch range.
 */
export function calculatePhoneTileSize(
  preferredSize: number,
  viewportWidth: number,
  horizontalInset: number,
): number {
  const safePreference = Number.isFinite(preferredSize) ? preferredSize : MIN_PINCH_TILE_SIZE;
  const boundedPreference = Math.min(
    MAX_PINCH_TILE_SIZE,
    Math.max(MIN_PINCH_TILE_SIZE, safePreference),
  );
  const safeViewportWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth) : 0;
  const safeInset = Number.isFinite(horizontalInset) ? Math.max(0, horizontalInset) : 0;
  const availableWidth = Math.max(0, safeViewportWidth - safeInset);

  if (availableWidth <= 0) return MIN_RENDERED_PHONE_TILE_SIZE;

  const denseSize = Math.max(
    MIN_RENDERED_PHONE_TILE_SIZE,
    tileSizeForColumns(availableWidth, PHONE_DENSE_COLUMNS),
  );
  const largeSize = Math.max(
    denseSize,
    tileSizeForColumns(availableWidth, PHONE_LARGE_COLUMNS),
  );
  const preferenceRatio = (boundedPreference - MIN_PINCH_TILE_SIZE)
    / (MAX_PINCH_TILE_SIZE - MIN_PINCH_TILE_SIZE);

  return Math.round(denseSize + (largeSize - denseSize) * preferenceRatio);
}

/** Match CSS grid's repeat(auto-fill) column calculation, including gaps. */
export function calculateGridColumnCount(
  containerWidth: number,
  tileSize: number,
  gap = GRID_TILE_GAP,
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 1;
  const safeTileSize = Number.isFinite(tileSize) ? Math.max(1, tileSize) : 1;
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  return Math.max(1, Math.floor((containerWidth + safeGap) / (safeTileSize + safeGap)));
}

/**
 * Tile size that makes `columns` tiles plus their gaps span the full width.
 *
 * This is what turns the size slider into steps: the column count only changes
 * at whole columns, and between those points the tiles absorb the leftover
 * space instead of leaving it at the right edge.
 */
export function fillTileSize(
  containerWidth: number,
  columns: number,
  fallback: number,
  gap = GRID_TILE_GAP,
): number {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return fallback;
  if (!Number.isFinite(columns) || columns < 1) return fallback;
  const safeGap = Number.isFinite(gap) ? Math.max(0, gap) : 0;
  const size = Math.floor((containerWidth - safeGap * (columns - 1)) / columns);
  return size > 0 ? size : fallback;
}
