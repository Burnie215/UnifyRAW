import { describe, expect, it } from 'vitest';
import {
  areToneCurvesIdentity,
  buildToneCurveLut,
  evaluateToneCurve,
  isToneCurveIdentity,
  type ToneCurveChannels,
} from './toneCurve';

const identity = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

describe('tone curve interpolation', () => {
  it('keeps the two-point diagonal exactly linear', () => {
    expect(evaluateToneCurve(identity, 0.25)).toBeCloseTo(0.25, 12);
    expect(evaluateToneCurve(identity, 0.5)).toBeCloseTo(0.5, 12);
    expect(evaluateToneCurve(identity, 0.75)).toBeCloseTo(0.75, 12);
  });

  it('keeps additional collinear control points neutral', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 0.2, y: 0.2 },
      { x: 0.5, y: 0.5 },
      { x: 0.8, y: 0.8 },
      { x: 1, y: 1 },
    ];
    expect(isToneCurveIdentity(points)).toBe(true);
    for (let index = 0; index <= 100; index++) {
      const input = index / 100;
      expect(evaluateToneCurve(points, input)).toBeCloseTo(input, 12);
    }
  });

  it('does not overshoot a monotone adjustment', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.1 },
      { x: 0.7, y: 0.85 },
      { x: 1, y: 1 },
    ];
    for (let index = 0; index <= 100; index++) {
      const value = evaluateToneCurve(points, index / 100);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('builds a byte-exact identity LUT for a neutral multi-point curve', () => {
    const diagonal = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }];
    const curves: ToneCurveChannels = {
      rgb: diagonal,
      luma: identity,
      red: identity,
      green: identity,
      blue: identity,
    };
    expect(areToneCurvesIdentity(curves)).toBe(true);
    const lut = buildToneCurveLut(curves);
    for (let index = 0; index < 256; index++) {
      expect(Array.from(lut.slice(index * 4, index * 4 + 4))).toEqual([
        index,
        index,
        index,
        255,
      ]);
    }
  });
});
