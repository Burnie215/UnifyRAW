import { describe, expect, it } from 'vitest';
import { rawWhiteBalanceGains, relativeRawWhiteBalanceGains } from './whiteBalance';

describe('RAW white-balance gains', () => {
  it('is identity at neutral sliders', () => {
    expect(relativeRawWhiteBalanceGains(0, 0)).toEqual([1, 1, 1]);
  });

  it('warms via multiplicative red/blue gains', () => {
    const [r, g, b] = relativeRawWhiteBalanceGains(100, 0);
    expect(r).toBeGreaterThan(1);
    expect(g).toBe(1);
    expect(b).toBeLessThan(1);
    expect(r * g * b).toBeCloseTo(1);
  });

  it('moves positive tint toward magenta by reducing green relatively', () => {
    const [r, g, b] = relativeRawWhiteBalanceGains(0, 100);
    expect(r).toBeGreaterThan(g);
    expect(b).toBeGreaterThan(g);
    expect(r * g * b).toBeCloseTo(1);
  });

  it('combines camera and relative gains', () => {
    const relative = relativeRawWhiteBalanceGains(25, -10);
    const combined = rawWhiteBalanceGains([2, 1, 1.5], 25, -10);
    expect(combined[0]).toBeCloseTo(2 * relative[0]);
    expect(combined[1]).toBeCloseTo(relative[1]);
    expect(combined[2]).toBeCloseTo(1.5 * relative[2]);
  });
});
