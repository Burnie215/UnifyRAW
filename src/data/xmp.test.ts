import { describe, expect, it } from 'vitest';
import { CRS_FIELDS } from './crsScale';
import { parseLightroomPreset } from './lightroomPreset';
import { adjustmentsToXMP } from './xmp';
import { defaultAdjustments, type Adjustments } from '../types';

/** One probe per CRS_FIELDS entry, each different from the default - a value
 * that equals the default is not written at all and would measure nothing. */
const PROBE: Record<string, number> = {
  exposure: 50,
  contrast: 20,
  highlights: -30,
  shadows: 35,
  whites: 10,
  blacks: -10,
  clarity: 20,
  texture: 15,
  dehaze: -10,
  vibrance: 20,
  saturation: 10,
  temperature: 18,
  tint: 5,
  sharpness: 40,
  sharpenRadius: 2,
  sharpenMasking: 30,
  noiseReduction: 20,
  vignette: -20,
  vignetteFeather: 60,
  grain: 30,
  grainSize: 40,
  rotation: 3,
};

function probeAdjustments(): Adjustments {
  const adj = structuredClone(defaultAdjustments);
  for (const [key, value] of Object.entries(PROBE)) {
    (adj as unknown as Record<string, number>)[key] = value;
  }
  adj.hsl.orange.hue = -8;
  adj.colorGrading.shadows = { hue: 205, saturation: 18, satAdj: 0, lumAdj: -10 };
  adj.bwEnabled = true;
  adj.bwMix.red = 20;
  adj.flipH = true;
  // The import always reads a curve as 'gamma', so only that case round-trips.
  adj.toneCurve.rgb = [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }];
  adj.toneCurveSpace = 'gamma';
  return adj;
}

describe('XMP export', () => {
  it('round-trips every scaled field through the Lightroom import', () => {
    const parsed = parseLightroomPreset(adjustmentsToXMP(probeAdjustments()), 'r.xmp').adjustments;

    expect(CRS_FIELDS).toHaveLength(Object.keys(PROBE).length);
    for (const field of CRS_FIELDS) {
      const expected = PROBE[field.key];
      const actual = (parsed as unknown as Record<string, number | undefined>)[field.key];
      expect.soft(actual, `${field.crs} missing`).toBeTypeOf('number');
      expect.soft(Math.abs((actual ?? NaN) - expected), `${field.crs} off scale`)
        .toBeLessThanOrEqual(0.5);
    }
  });

  it('round-trips the mappings that are not a single factor', () => {
    const parsed = parseLightroomPreset(adjustmentsToXMP(probeAdjustments()), 'r.xmp').adjustments;

    expect(parsed.hsl?.orange.hue).toBeCloseTo(-8, 2);
    expect(parsed.colorGrading?.shadows.hue).toBeCloseTo(205, 2);
    expect(parsed.colorGrading?.shadows.saturation).toBeCloseTo(18, 2);
    expect(parsed.colorGrading?.shadows.lumAdj).toBeCloseTo(-10, 2);
    expect(parsed.bwEnabled).toBe(true);
    expect(parsed.bwMix?.red).toBeCloseTo(20, 2);
    expect(parsed.toneCurveSpace).toBe('gamma');
    expect(parsed.toneCurve?.rgb).toHaveLength(3);
    for (const [index, point] of [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }].entries()) {
      expect(parsed.toneCurve!.rgb[index].x).toBeCloseTo(point.x, 2);
      expect(Math.abs(parsed.toneCurve!.rgb[index].y - point.y)).toBeLessThanOrEqual(0.02);
    }
  });

  it('writes Lightroom units, not slider values', () => {
    const xmp = adjustmentsToXMP(probeAdjustments());

    expect(xmp).toContain('crs:Exposure2012="1"');
    expect(xmp).toContain('crs:Contrast2012="30.77"');
    expect(xmp).toContain('crs:Temperature="6130"');
    expect(xmp).toContain('crs:WhiteBalance="Custom"');
    expect(xmp).toContain('crs:HueAdjustmentOrange="-10"');
    expect(xmp).toContain('crs:ColorGradeShadowSat="24"');
    // No reader in this repo takes the flips back out; the file still carries them.
    expect(xmp).toContain('crs:FlipHorizontal="True"');
  });

  it('writes no setting at all for untouched adjustments', () => {
    const xmp = adjustmentsToXMP(defaultAdjustments);

    expect([...xmp.matchAll(/crs:(\w+)/g)].map((match) => match[1]))
      .toEqual(['Version', 'ProcessVersion']);
  });
});
