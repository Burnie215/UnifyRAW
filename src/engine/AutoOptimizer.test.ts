import { describe, expect, it } from 'vitest';
import { autoOptimize, applyAutoResult, matchToReference, idealToneCurve } from './AutoOptimizer';
import { histogramFromPixels } from '../image/histogram';
import { applyTone } from './ToneMatch';
import { defaultAdjustments } from '../types';

function mutedPixels(): Uint8ClampedArray {
  return new Uint8ClampedArray([
    120, 116, 112, 255,
    140, 135, 130, 255,
    95, 92, 90, 255,
    170, 164, 158, 255,
  ]);
}

/** Same tones, but with the colour density of a camera JPEG. */
function vividPixels(): Uint8ClampedArray {
  return new Uint8ClampedArray([
    150, 110, 70, 255,
    175, 130, 85, 255,
    115, 80, 50, 255,
    210, 160, 105, 255,
  ]);
}

function input(pixels: Uint8ClampedArray) {
  return { bins: histogramFromPixels(pixels), pixels };
}

describe('AutoOptimizer RAW presence', () => {
  it('adds both vibrance and saturation to a neutral RAW decode', () => {
    const pixels = mutedPixels();
    const result = autoOptimize(histogramFromPixels(pixels), pixels, { isRaw: true });
    expect(result.vibrance).toBeGreaterThanOrEqual(8);
    expect(result.saturation).toBeGreaterThanOrEqual(2);
  });

  it('gives a RAW decode more vibrance than the same tones as a JPEG', () => {
    const pixels = mutedPixels();
    const raw = autoOptimize(histogramFromPixels(pixels), pixels, { isRaw: true });
    const jpeg = autoOptimize(histogramFromPixels(pixels), pixels);
    expect(raw.vibrance).toBeGreaterThan(jpeg.vibrance);
  });

  it('persists the calculated saturation in adjustments', () => {
    const result = applyAutoResult(defaultAdjustments, {
      exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0,
      blacks: 0, temperature: 0, vibrance: 12, saturation: 6, clarity: 8, dehaze: 11,
    });
    expect(result.saturation).toBe(6);
    expect(result.dehaze).toBe(11);
  });

  it('uses dehaze for a compressed, washed-out image', () => {
    const pixels = mutedPixels();
    const result = autoOptimize(histogramFromPixels(pixels), pixels, { isRaw: true });
    expect(result.dehaze).toBeGreaterThan(0);
    expect(result.dehaze).toBeLessThanOrEqual(18);
  });
});

describe('AutoOptimizer saturation on flat images', () => {
  it('lifts saturation on a flat non-RAW image', () => {
    const pixels = mutedPixels();
    const result = autoOptimize(histogramFromPixels(pixels), pixels);
    expect(result.saturation).toBeGreaterThan(0);
  });

  it('leaves an image that already has colour density alone', () => {
    const pixels = vividPixels();
    const flat = autoOptimize(histogramFromPixels(mutedPixels()), mutedPixels());
    const vivid = autoOptimize(histogramFromPixels(pixels), pixels);
    expect(vivid.saturation).toBeLessThan(flat.saturation);
  });

  it('never pushes saturation past the safe ceiling', () => {
    const gray = new Uint8ClampedArray([128, 128, 128, 255, 130, 130, 130, 255]);
    const result = autoOptimize(histogramFromPixels(gray), gray);
    expect(result.saturation).toBeLessThanOrEqual(25);
  });

  it('still lifts saturation without pixel data', () => {
    const pixels = mutedPixels();
    const result = autoOptimize(histogramFromPixels(pixels));
    expect(result.saturation).toBeGreaterThan(0);
  });
});

describe('matchToReference', () => {
  it('adds colour when the reference JPEG is more saturated', () => {
    const result = matchToReference(input(mutedPixels()), input(vividPixels()));
    expect(result.vibrance).toBeGreaterThan(0);
    expect(result.saturation).toBeGreaterThan(0);
  });

  it('removes colour when the reference JPEG is flatter', () => {
    const result = matchToReference(input(vividPixels()), input(mutedPixels()));
    expect(result.saturation).toBeLessThan(0);
  });

  it('is a no-op when source and reference are the same image', () => {
    const same = input(vividPixels());
    const result = matchToReference(same, same);
    expect(result).toEqual({
      exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0,
      blacks: 0, temperature: 0, vibrance: 0, saturation: 0, clarity: 0, dehaze: 0,
    });
  });

  // Asserted on the resulting tone curve, not on one slider. The six controls
  // compose, so "brighter" is a property of the fit as a whole — an earlier
  // version of this test pinned `exposure` and failed the moment the fit found
  // an equally good answer through contrast instead.
  it('brightens towards a brighter reference', () => {
    const dark = new Uint8ClampedArray([40, 40, 40, 255, 60, 60, 60, 255]);
    const bright = new Uint8ClampedArray([180, 180, 180, 255, 200, 200, 200, 255]);

    const up = matchToReference(input(dark), input(bright));
    const down = matchToReference(input(bright), input(dark));
    for (const value of [40, 60]) {
      expect(applyTone(value / 255, up, true) * 255).toBeGreaterThan(value);
    }
    for (const value of [180, 200]) {
      expect(applyTone(value / 255, down, true) * 255).toBeLessThan(value);
    }
  });

  it('warms towards a warmer reference', () => {
    const cool = new Uint8ClampedArray([100, 130, 170, 255, 110, 140, 180, 255]);
    const warm = new Uint8ClampedArray([170, 130, 100, 255, 180, 140, 110, 255]);
    expect(matchToReference(input(cool), input(warm)).temperature).toBeGreaterThan(0);
    expect(matchToReference(input(warm), input(cool)).temperature).toBeLessThan(0);
  });

  it('leaves clarity alone — a histogram cannot see local contrast', () => {
    expect(matchToReference(input(mutedPixels()), input(vividPixels())).clarity).toBe(0);
  });

  it('removes haze when the source is flatter than the JPG/HIF reference', () => {
    const hazy = mutedPixels();
    const clear = new Uint8ClampedArray([
      10, 25, 40, 255,
      235, 205, 170, 255,
      25, 185, 75, 255,
      240, 225, 210, 255,
    ]);
    expect(matchToReference(input(hazy), input(clear)).dehaze).toBeGreaterThan(0);
    expect(matchToReference(input(clear), input(hazy)).dehaze).toBeLessThan(0);
  });
});

describe('idealToneCurve', () => {
  const flat = { median: 128, p01: 60, p99: 190, highlightPixels: 0 };

  it('is monotonic, so the fit downstream stays stable', () => {
    const curve = idealToneCurve(flat);
    for (let i = 1; i < 256; i++) {
      expect(curve[i], `at ${i}`).toBeGreaterThanOrEqual(curve[i - 1]);
    }
  });

  it('expands a narrow histogram towards the full range', () => {
    const curve = idealToneCurve(flat);
    expect(curve[60]).toBeLessThan(60);
    expect(curve[190]).toBeGreaterThan(190);
  });

  it('pulls the white point down instead of up when highlights are blown', () => {
    const blown = { ...flat, p99: 255, highlightPixels: 0.25 };
    expect(idealToneCurve(blown)[255]).toBeLessThan(255);
  });

  it('never moves the median further than the cap allows', () => {
    // A night scene: the ideal is 95 code values away, the cap is 35.
    const dark = { median: 25, p01: 2, p99: 200, highlightPixels: 0 };
    expect(idealToneCurve(dark)[25] - 25).toBeLessThanOrEqual(35);
    const bright = { median: 220, p01: 90, p99: 255, highlightPixels: 0 };
    expect(220 - idealToneCurve(bright)[220]).toBeLessThanOrEqual(35);
  });

  it('survives a degenerate histogram without producing NaN', () => {
    const flatGray = { median: 128, p01: 128, p99: 128, highlightPixels: 0 };
    const curve = idealToneCurve(flatGray);
    for (let i = 0; i < 256; i++) expect(Number.isFinite(curve[i]), `at ${i}`).toBe(true);
  });
});
