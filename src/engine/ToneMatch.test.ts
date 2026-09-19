import { describe, expect, it } from 'vitest';
import { applyTone, fitToneMatch, matchingCurve, type ToneMatchAdjustments } from './ToneMatch';

const NEUTRAL: ToneMatchAdjustments = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
};

/** A broad, smooth histogram — stands in for an ordinary photograph. */
function bellHistogram(centre = 118, spread = 42): number[] {
  return Array.from({ length: 256 }, (_, i) =>
    Math.round(10_000 * Math.exp(-((i - centre) ** 2) / (2 * spread ** 2))));
}

/** Push a histogram through a known tone setting, as the renderer would. */
function renderHistogram(bins: readonly number[], adj: ToneMatchAdjustments, linear = false): number[] {
  const out = new Array(256).fill(0);
  for (let i = 0; i < 256; i++) {
    if (!bins[i]) continue;
    out[Math.round(applyTone(i / 255, adj, linear) * 255)] += bins[i];
  }
  return out;
}

describe('applyTone', () => {
  it('is the identity at neutral settings', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      expect(applyTone(v, NEUTRAL)).toBeCloseTo(v, 6);
    }
  });

  it('doubles linear light for one stop of exposure', () => {
    // u_exposure = exposure/100, and the shader raises 2 to twice that.
    expect(applyTone(0.25, { ...NEUTRAL, exposure: 50 })).toBeCloseTo(0.5, 6);
  });

  it('holds mid-gray fixed while contrast pivots around it', () => {
    expect(applyTone(0.5, { ...NEUTRAL, contrast: 40 })).toBeCloseTo(0.5, 6);
    expect(applyTone(0.7, { ...NEUTRAL, contrast: 40 })).toBeGreaterThan(0.7);
    expect(applyTone(0.3, { ...NEUTRAL, contrast: 40 })).toBeLessThan(0.3);
  });

  it('stays inside the display range', () => {
    const extreme = { exposure: 100, contrast: 100, highlights: 100, shadows: 100, whites: 100, blacks: 100 };
    for (let i = 0; i <= 255; i += 5) {
      const out = applyTone(i / 255, extreme);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
    }
  });

  it('routes through linear light when the pipeline does', () => {
    // Same slider, different working space — the results must not coincide.
    expect(applyTone(0.5, { ...NEUTRAL, exposure: 20 }, true))
      .not.toBeCloseTo(applyTone(0.5, { ...NEUTRAL, exposure: 20 }, false), 3);
  });
});

describe('matchingCurve', () => {
  it('is the identity when both sides are the same histogram', () => {
    const bins = bellHistogram();
    const curve = matchingCurve(bins, bins);
    // Only bins that actually hold pixels are meaningful.
    for (let i = 60; i < 180; i++) expect(Math.abs(curve[i] - i)).toBeLessThanOrEqual(1);
  });

  it('rises monotonically', () => {
    const curve = matchingCurve(bellHistogram(90), bellHistogram(150));
    for (let i = 1; i < 256; i++) expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
  });

  it('points a darker source at brighter targets', () => {
    const curve = matchingCurve(bellHistogram(80), bellHistogram(160));
    expect(curve[80]).toBeGreaterThan(80);
  });
});

describe('fitToneMatch', () => {
  it('returns neutral sliders for identical histograms', () => {
    const bins = bellHistogram();
    expect(fitToneMatch(bins, bins)).toEqual(NEUTRAL);
  });

  it('recovers a known exposure change', () => {
    const source = bellHistogram();
    const truth = { ...NEUTRAL, exposure: 12 };
    const fitted = fitToneMatch(source, renderHistogram(source, truth));
    expect(Math.abs(fitted.exposure - truth.exposure)).toBeLessThanOrEqual(4);
  });

  it('recovers a known contrast change', () => {
    const source = bellHistogram(128, 30);
    const truth = { ...NEUTRAL, contrast: 25 };
    const fitted = fitToneMatch(source, renderHistogram(source, truth));
    expect(fitted.contrast).toBeGreaterThan(10);
  });

  it('reproduces the target curve it was fitted to', () => {
    // The real test of the fit: not whether it guesses the same sliders, but
    // whether the resulting curve lands the source histogram on the reference.
    const source = bellHistogram(95, 35);
    const truth = { ...NEUTRAL, exposure: 15, contrast: 20, blacks: -10 };
    const reference = renderHistogram(source, truth);
    const fitted = fitToneMatch(source, reference);

    const target = matchingCurve(source, reference);
    const total = source.reduce((s, v) => s + v, 0);
    let error = 0;
    for (let i = 0; i < 256; i++) {
      if (!source[i]) continue;
      error += (source[i] / total) * Math.abs(applyTone(i / 255, fitted) * 255 - target[i]);
    }
    expect(error).toBeLessThan(4);
  });

  it('does not squash a source that is already wider than the reference', () => {
    // The bug this module replaces: a flat RAW render came back compressed.
    const source = bellHistogram(118, 55);
    const reference = bellHistogram(118, 30);
    const fitted = fitToneMatch(source, reference);
    const spread = (adj: ToneMatchAdjustments) =>
      applyTone(200 / 255, adj) - applyTone(50 / 255, adj);
    expect(spread(fitted)).toBeLessThan(spread(NEUTRAL));
  });

  it('widens a flat source towards a contrastier reference', () => {
    const source = bellHistogram(118, 25);
    const reference = bellHistogram(118, 60);
    const fitted = fitToneMatch(source, reference);
    const spread = (adj: ToneMatchAdjustments) =>
      applyTone(200 / 255, adj) - applyTone(50 / 255, adj);
    expect(spread(fitted)).toBeGreaterThan(spread(NEUTRAL));
  });

  it('survives empty input', () => {
    const empty = new Array(256).fill(0);
    expect(fitToneMatch(empty, bellHistogram())).toEqual(NEUTRAL);
    expect(fitToneMatch(bellHistogram(), empty)).toEqual(NEUTRAL);
  });

  it('keeps every slider inside its range', () => {
    const fitted = fitToneMatch(bellHistogram(20, 8), bellHistogram(230, 8));
    for (const value of Object.values(fitted)) {
      expect(value).toBeGreaterThanOrEqual(-100);
      expect(value).toBeLessThanOrEqual(100);
    }
  });
});
