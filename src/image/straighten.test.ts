import { describe, expect, it } from 'vitest';
import { normalizeRotation, straightenRotation } from './straighten';

describe('straightenRotation', () => {
  it('levels a slightly tilted horizon', () => {
    // 400px right, 21px down - a horizon tipped by 3 degrees.
    expect(straightenRotation(400, 21)).toBeCloseTo(-3, 1);
    expect(straightenRotation(400, -21)).toBeCloseTo(3, 1);
  });

  it('straightens a near-vertical line against the vertical axis', () => {
    // A tower edge 3 degrees off vertical must rotate by 3 degrees, not by 87.
    expect(straightenRotation(21, 400)).toBeCloseTo(3, 1);
    expect(straightenRotation(-21, 400)).toBeCloseTo(-3, 1);
  });

  it('gives the same answer whichever way the line was drawn', () => {
    expect(straightenRotation(-400, -21)).toBeCloseTo(straightenRotation(400, 21)!, 5);
    expect(straightenRotation(-21, -400)).toBeCloseTo(straightenRotation(21, 400)!, 5);
  });

  it('never rotates more than the slider allows', () => {
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [400, 399]] as const) {
      const rotation = straightenRotation(dx * 400, dy * 400)!;
      expect(Math.abs(rotation)).toBeLessThanOrEqual(45);
    }
  });

  it('leaves an already level line alone', () => {
    expect(straightenRotation(400, 0)).toBe(0);
    expect(straightenRotation(0, 400)).toBe(0);
  });

  it('ignores a drag too short to carry a direction', () => {
    expect(straightenRotation(5, 2)).toBeNull();
    expect(straightenRotation(0, 0)).toBeNull();
  });
});

describe('normalizeRotation', () => {
  it('keeps a correction on top of an existing orientation fix', () => {
    // Upside-down photo, horizon 3 degrees off: the 180 must survive.
    const correction = straightenRotation(400, 21)!;
    expect(normalizeRotation(180 + correction)).toBeCloseTo(177, 1);
  });

  it('leaves an upside-down photo alone when the line is already level', () => {
    expect(normalizeRotation(180 + straightenRotation(400, 0)!)).toBe(180);
  });

  it('folds into (-180, 180]', () => {
    expect(normalizeRotation(190)).toBe(-170);
    expect(normalizeRotation(-190)).toBe(170);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(180)).toBe(180);
  });

  it('survives a broken value', () => {
    expect(normalizeRotation(Number.NaN)).toBe(0);
  });
});
