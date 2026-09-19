import { describe, expect, it } from 'vitest';
import { isFullCropRect, normalizeCropRect, persistedCropRect } from './Crop';

describe('normalized crop rectangles', () => {
  it('treats a missing crop as the full legacy frame', () => {
    expect(normalizeCropRect()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(isFullCropRect()).toBe(true);
    expect(persistedCropRect()).toBeUndefined();
  });

  it('keeps malformed persisted data finite and inside the image', () => {
    const crop = normalizeCropRect({ x: 0.8, y: -2, width: 0.7, height: Number.NaN });
    expect(crop).toMatchObject({ x: 0.8, y: 0, height: 1 });
    expect(crop.width).toBeCloseTo(0.2);
  });
});
