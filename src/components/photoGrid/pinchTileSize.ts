export const MIN_PINCH_TILE_SIZE = 80;
export const MAX_PINCH_TILE_SIZE = 400;
export const PINCH_TILE_SIZE_STEP = 4;

/**
 * Convert a two-pointer distance into the same bounded tile size exposed by
 * the library's view controls. A small step keeps the grid stable without
 * making the gesture feel coarse.
 */
export function calculatePinchTileSize(
  startSize: number,
  startDistance: number,
  currentDistance: number,
): number {
  const safeStartSize = Number.isFinite(startSize) ? startSize : MIN_PINCH_TILE_SIZE;
  const boundedStartSize = Math.min(MAX_PINCH_TILE_SIZE, Math.max(MIN_PINCH_TILE_SIZE, safeStartSize));
  if (!Number.isFinite(startDistance) || startDistance <= 0 || !Number.isFinite(currentDistance)) {
    return Math.round(boundedStartSize / PINCH_TILE_SIZE_STEP) * PINCH_TILE_SIZE_STEP;
  }

  const scaled = safeStartSize * (currentDistance / startDistance);
  const bounded = Math.min(MAX_PINCH_TILE_SIZE, Math.max(MIN_PINCH_TILE_SIZE, scaled));
  return Math.round(bounded / PINCH_TILE_SIZE_STEP) * PINCH_TILE_SIZE_STEP;
}

/**
 * Trackpad pinch (a wheel event with ctrlKey) mapped onto the tile size.
 *
 * Browsers report a trackpad pinch as ctrl+wheel, which they would otherwise
 * spend on page zoom. In the library that is the wrong target: the gesture is
 * about how large the photos are, not how large the app chrome is.
 */
export function calculateWheelTileSize(currentSize: number, deltaY: number): number {
  const safeSize = Number.isFinite(currentSize) ? currentSize : MIN_PINCH_TILE_SIZE;
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    return Math.round(safeSize / PINCH_TILE_SIZE_STEP) * PINCH_TILE_SIZE_STEP;
  }
  // Zooming in (deltaY < 0) has to grow the tiles.
  const scaled = safeSize * (1 - Math.max(-40, Math.min(40, deltaY)) / 100);
  const bounded = Math.min(MAX_PINCH_TILE_SIZE, Math.max(MIN_PINCH_TILE_SIZE, scaled));
  return Math.round(bounded / PINCH_TILE_SIZE_STEP) * PINCH_TILE_SIZE_STEP;
}
