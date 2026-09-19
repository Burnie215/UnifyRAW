import { describe, expect, it } from 'vitest';
import {
  MAX_PINCH_TILE_SIZE,
  MIN_PINCH_TILE_SIZE,
  calculatePinchTileSize,
} from './photoGrid/pinchTileSize';

describe('calculatePinchTileSize', () => {
  it('scales and rounds thumbnail sizes in small stable steps', () => {
    expect(calculatePinchTileSize(180, 100, 150)).toBe(272);
    expect(calculatePinchTileSize(180, 100, 75)).toBe(136);
  });

  it('clamps both ends to the library size-control range', () => {
    expect(calculatePinchTileSize(180, 100, 10)).toBe(MIN_PINCH_TILE_SIZE);
    expect(calculatePinchTileSize(180, 100, 1_000)).toBe(MAX_PINCH_TILE_SIZE);
  });

  it('falls back safely for an invalid starting distance', () => {
    expect(calculatePinchTileSize(181, 0, 100)).toBe(180);
  });
});
