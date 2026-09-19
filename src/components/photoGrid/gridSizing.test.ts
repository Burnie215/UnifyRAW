import { describe, expect, it } from 'vitest';
import { calculateGridColumnCount, calculatePhoneTileSize, fillTileSize, GRID_TILE_GAP } from './gridSizing';

describe('calculatePhoneTileSize', () => {
  it('maps the complete persisted density range to four through two phone columns', () => {
    const availableWidth = 390 - 32;
    const dense = calculatePhoneTileSize(80, 390, 32);
    const normal = calculatePhoneTileSize(180, 390, 32);
    const large = calculatePhoneTileSize(400, 390, 32);

    expect(calculateGridColumnCount(availableWidth, dense)).toBe(4);
    expect(calculateGridColumnCount(availableWidth, normal)).toBe(3);
    expect(calculateGridColumnCount(availableWidth, large)).toBe(2);
  });

  it('adapts to portrait and landscape widths without changing the preference', () => {
    expect(calculatePhoneTileSize(180, 390, 32)).toBe(114);
    expect(calculatePhoneTileSize(180, 844, 32)).toBe(264);
  });

  it('accounts for the narrower timeline content area', () => {
    const size = calculatePhoneTileSize(400, 390, 70);
    expect(calculateGridColumnCount(390 - 70, size)).toBe(2);
  });

  it('bounds invalid and out-of-range preferences safely', () => {
    expect(calculatePhoneTileSize(Number.NaN, 390, 32)).toBe(
      calculatePhoneTileSize(80, 390, 32),
    );
    expect(calculatePhoneTileSize(1_000, 390, 32)).toBe(
      calculatePhoneTileSize(400, 390, 32),
    );
  });
});

describe('calculateGridColumnCount', () => {
  it('matches the gap-aware auto-fill boundary', () => {
    expect(calculateGridColumnCount(358, 86)).toBe(4);
    expect(calculateGridColumnCount(358, 87)).toBe(3);
  });
});

describe('fillTileSize', () => {
  it('spends the whole width on the columns and their gaps', () => {
    const width = 1000;
    const columns = 5;
    const size = fillTileSize(width, columns, 180);
    expect(size * columns + GRID_TILE_GAP * (columns - 1)).toBeLessThanOrEqual(width);
    // Nothing worth another column may be left over.
    expect(width - (size * columns + GRID_TILE_GAP * (columns - 1))).toBeLessThan(columns);
  });

  it('steps only when the column count changes', () => {
    // Same five columns, wider container - the tiles absorb the extra width.
    expect(fillTileSize(1000, 5, 180)).toBeLessThan(fillTileSize(1100, 5, 180));
  });

  it('falls back while the container has not been measured', () => {
    expect(fillTileSize(0, 4, 180)).toBe(180);
    expect(fillTileSize(Number.NaN, 4, 180)).toBe(180);
    expect(fillTileSize(1000, 0, 180)).toBe(180);
  });
});
