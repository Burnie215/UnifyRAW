import { describe, expect, it } from 'vitest';
import {
  calculateWheelTileSize,
  MAX_PINCH_TILE_SIZE,
  MIN_PINCH_TILE_SIZE,
  PINCH_TILE_SIZE_STEP,
} from './pinchTileSize';

describe('calculateWheelTileSize', () => {
  it('grows the tiles when the gesture zooms in', () => {
    expect(calculateWheelTileSize(200, -10)).toBeGreaterThan(200);
  });

  it('shrinks the tiles when the gesture zooms out', () => {
    expect(calculateWheelTileSize(200, 10)).toBeLessThan(200);
  });

  it('stays inside the slider range', () => {
    expect(calculateWheelTileSize(MIN_PINCH_TILE_SIZE, 400)).toBe(MIN_PINCH_TILE_SIZE);
    expect(calculateWheelTileSize(MAX_PINCH_TILE_SIZE, -400)).toBe(MAX_PINCH_TILE_SIZE);
  });

  it('snaps to the shared step so the grid does not jitter', () => {
    for (const delta of [-37, -3, 3, 37]) {
      expect(calculateWheelTileSize(203, delta) % PINCH_TILE_SIZE_STEP).toBe(0);
    }
  });

  it('handles a zero or broken delta without moving', () => {
    expect(calculateWheelTileSize(200, 0)).toBe(200);
    expect(calculateWheelTileSize(200, Number.NaN)).toBe(200);
  });
});
