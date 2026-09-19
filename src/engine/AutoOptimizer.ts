/**
 * AutoOptimizer — Histogram-based heuristic auto-adjustments.
 *
 * Analyzes the source image (before any adjustments) to compute
 * optimal Exposure, Contrast, Highlights, Shadows, Whites, Blacks,
 * White Balance (Temperature), Vibrance, Clarity, and Brilliance.
 *
 * All heuristics are conservative — they nudge toward a balanced image
 * without over-processing. Results are clamped to safe ranges.
 *
 * {@link matchToReference} solves the same problem against a concrete target
 * instead of a generic ideal: it matches one image to another (the RAW half of
 * a RAW+JPEG pair to its camera JPEG).
 */

import type { HistogramBins } from '../image/histogram';
import type { Adjustments } from '../types';
import { fitToneCurve, fitToneMatch } from './ToneMatch';

export interface AutoResult {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  vibrance: number;
  saturation: number;
  clarity: number;
  dehaze: number;
}

export interface AutoOptimizeOptions {
  /** RAW files need a small presence baseline because their neutral decode is
   * intentionally less vivid than an in-camera JPEG. */
  isRaw?: boolean;
  /** See {@link MatchOptions.linearTone}. Defaults to true, which is what the
   *  shipping pipeline does. */
  linearTone?: boolean;
}

/** Mean HSL saturation a lively image lands on. Below this counts as flat. */
const SATURATION_TARGET = 0.30;
/** Luma spread (p01..p99) below which the tonal range counts as flat. */
const FLAT_RANGE = 180;

/** Where a balanced image puts its median — slightly below middle gray. */
const TARGET_MEDIAN = 120;
/** Black and white point a full-range image lands on. */
const TARGET_BLACK = 10;
const TARGET_WHITE = 245;
/**
 * How much of the measured deviation the auto mode actually corrects.
 *
 * The mode is meant to nudge, not to normalise: a deliberately low-key or
 * high-key photograph should stay recognisable. Previously the restraint was
 * accidental — the per-slider coefficients were calibrated against a
 * gamma-space tone shader and, once the pipeline moved to linear light, they
 * delivered only 5-35% of the correction they computed (measured: exposure
 * 0.74 code values per slider unit against a coefficient of 0.35, whites 0.12
 * against 0.4). Restraint is now stated here and the fit reaches its target.
 */
const CORRECTION_STRENGTH = 0.7;
/**
 * Ceiling on how far the median may be moved, in code values.
 *
 * A deliberately low-key frame measures far from the ideal without being
 * wrong, and dragging its median all the way to {@link TARGET_MEDIAN} is not a
 * correction but a different photograph. Measured on a night shot whose camera
 * JPEG sits at median 49: uncapped, the fit chased a curve the six sliders
 * cannot describe and answered with exposure +55 against highlights -86 and
 * shadows +100 — extreme, mutually cancelling, and unusable as a starting
 * point for manual work.
 */
const MAX_MEDIAN_SHIFT = 35;
/** Auto's fit buys simplicity harder than the reference match does; see
 *  {@link ../engine/ToneMatch.ToneMatchOptions.simplicityWeight}. */
const AUTO_SIMPLICITY_WEIGHT = 12;

/**
 * Compute auto-adjustments from source image pixel data.
 * Pass the ORIGINAL image (before adjustments) as canvas or ImageData.
 */
export function autoOptimize(
  bins: HistogramBins,
  pixelData?: Uint8ClampedArray,
  options: AutoOptimizeOptions = {},
): AutoResult {
  const result: AutoResult = {
    exposure: 0, contrast: 0, highlights: 0, shadows: 0,
    whites: 0, blacks: 0, temperature: 0, vibrance: 0, saturation: 0, clarity: 0, dehaze: 0,
  };

  const totalPixels = bins.luma.reduce((s, v) => s + v, 0);
  if (totalPixels === 0) return result;

  // ─── Luma statistics ───
  const lumaCdf = cdf(bins.luma);
  const mean = weightedMean(bins.luma);
  const median = percentile(lumaCdf, 0.5);
  const p01 = percentile(lumaCdf, 0.01);   // black point (1st percentile)
  const p99 = percentile(lumaCdf, 0.99);   // white point (99th percentile)
  const dynamicRange = p99 - p01;

  // ─── Tone (exposure, contrast, highlights, shadows, whites, blacks) ───
  // The six tone sliders compose sequentially on the same pixel, so they are
  // solved together against the tone curve an ideal image would need — the
  // same machinery the reference-match mode uses, just with an ideal target
  // instead of a measured one. Deriving them one by one from the untouched
  // histogram both double-counts and hard-codes an assumption about which
  // colour space the shader works in.
  const highlightPixels = bins.luma.slice(230).reduce((s, v) => s + v, 0) / totalPixels;
  Object.assign(result, fitToneCurve(
    bins.luma,
    idealToneCurve({ median, p01, p99, highlightPixels }),
    { linear: options.linearTone ?? true, simplicityWeight: AUTO_SIMPLICITY_WEIGHT },
  ));

  // ─── White Balance (Temperature) ───
  if (pixelData) {
    const wb = analyzeWhiteBalance(pixelData);
    result.temperature = wb.temperature;
  } else {
    // Fallback: use R/B histogram means
    const rMean = weightedMean(bins.red);
    const bMean = weightedMean(bins.blue);
    const rbDelta = rMean - bMean;
    // Positive rbDelta = warm image → cool it down (negative temp)
    result.temperature = clamp(-rbDelta * 0.3, -25, 25);
  }

  // ─── Vibrance / Saturation ───
  // Flatness is a colour *and* a tone property: washed-out colours and a
  // narrow histogram reinforce each other. Vibrance stays the primary control
  // (it protects skin tones and colours that are already dense); saturation
  // carries the rest, scaled by how flat the tonal range is on top of it.
  const flatness = Math.max(0, Math.min(1, (FLAT_RANGE - dynamicRange) / FLAT_RANGE));
  if (pixelData) {
    const avgSat = averageSaturation(pixelData);
    const deficit = Math.max(0, SATURATION_TARGET - avgSat);
    if (options.isRaw) {
      // A neutral RAW decode normally looks flatter than the camera JPEG,
      // so it gets a presence baseline even when the colours measure fine.
      result.vibrance = clamp(8 + deficit * 90, 8, 28);
    } else if (avgSat < 0.15) {
      // Low saturation → boost vibrance; high → leave alone
      result.vibrance = clamp((0.15 - avgSat) * 200, 0, 25);
    }
    const lift = deficit * 55 * (1 + flatness * 0.8);
    result.saturation = clamp(options.isRaw ? Math.max(2, lift) : lift, 0, 25);
  } else {
    // Fallback: if R/G/B histograms are very similar → low saturation
    const rMean = weightedMean(bins.red);
    const gMean = weightedMean(bins.green);
    const bMean = weightedMean(bins.blue);
    const spread = Math.max(rMean, gMean, bMean) - Math.min(rMean, gMean, bMean);
    if (spread < 15) {
      result.vibrance = clamp((15 - spread) * 1.2, 0, 20);
    }
    // Channel spread is the only saturation proxy available without pixels.
    result.saturation = clamp(Math.max(0, 18 - spread) * 0.8 * (1 + flatness * 0.8), 0, 20);
    if (options.isRaw) {
      result.vibrance = Math.max(result.vibrance, 14);
      result.saturation = Math.max(result.saturation, 5);
    }
  }

  // ─── Clarity ───
  // Add a small amount of clarity for most images (subtle midtone contrast)
  // Skip for very dark or very bright images
  if (mean > 50 && mean < 200) {
    result.clarity = 8;
  }

  // ─── Brilliance (`dehaze` is the persisted legacy key) ───
  // Haze most often shows up as a compressed tonal range, lifted blacks and
  // reduced colour density. Keep this deliberately modest because those
  // signals can also describe a legitimate low-key or pastel look.
  const haze = imageStats(bins, pixelData).haze;
  result.dehaze = clamp((haze - 0.2) * 25, 0, 18);

  return result;
}

/**
 * Apply AutoResult to existing adjustments.
 * REPLACES the auto-controlled values (does not add — the analysis is always
 * against the source image, so the result is absolute, not relative).
 */
export function applyAutoResult(current: Adjustments, auto: AutoResult): Adjustments {
  return {
    ...current,
    exposure: auto.exposure,
    contrast: auto.contrast,
    highlights: auto.highlights,
    shadows: auto.shadows,
    whites: auto.whites,
    blacks: auto.blacks,
    temperature: auto.temperature,
    vibrance: auto.vibrance,
    saturation: auto.saturation,
    clarity: auto.clarity,
    dehaze: auto.dehaze,
  };
}

/**
 * Statistics that describe the *look* of an image — the properties the
 * adjustment sliders can move. Computed for the neutral RAW render and for the
 * camera JPEG, they reduce "make this look like that" to a difference.
 */
export interface ImageStats {
  median: number;
  /** Black point (1st percentile of luma). */
  p01: number;
  /** White point (99th percentile of luma). */
  p99: number;
  /** Share of pixels in the top zone (>=230). */
  highlightFraction: number;
  /** Share of pixels in the bottom zone (<25). */
  shadowFraction: number;
  /** Gray-world R–B ratio. Positive = warm. */
  warmth: number;
  /** Mean HSL saturation over usable midtones. */
  saturation: number;
  /** Estimated atmospheric haze, from 0 (clear) to 1 (strong). */
  haze: number;
}

/** Measure one image. `pixelData` sharpens warmth and saturation; without it
 *  both fall back to channel histogram means. */
export function imageStats(bins: HistogramBins, pixelData?: Uint8ClampedArray): ImageStats {
  const total = bins.luma.reduce((s, v) => s + v, 0);
  if (total === 0) {
    return { median: 128, p01: 0, p99: 255, highlightFraction: 0, shadowFraction: 0, warmth: 0, saturation: 0, haze: 0 };
  }
  const lumaCdf = cdf(bins.luma);
  const rMean = weightedMean(bins.red);
  const gMean = weightedMean(bins.green);
  const bMean = weightedMean(bins.blue);
  const p01 = percentile(lumaCdf, 0.01);
  const p99 = percentile(lumaCdf, 0.99);
  const saturation = pixelData
    ? averageSaturation(pixelData)
    : (Math.max(rMean, gMean, bMean) - Math.min(rMean, gMean, bMean)) / 255;
  return {
    median: percentile(lumaCdf, 0.5),
    p01,
    p99,
    highlightFraction: bins.luma.slice(230).reduce((s, v) => s + v, 0) / total,
    shadowFraction: bins.luma.slice(0, 25).reduce((s, v) => s + v, 0) / total,
    warmth: pixelData ? grayWorldWarmth(pixelData) : (rMean - bMean) / (gMean + 1),
    saturation,
    haze: hazeLikelihood(p01, p99, saturation),
  };
}

/** One side of a match: the histogram, plus pixels when they are available. */
export interface MatchInput {
  bins: HistogramBins;
  pixels?: Uint8ClampedArray;
}

export interface MatchOptions {
  /**
   * Whether TonePass sees linear light. Defaults to true, which is what every
   * shipping source does — see {@link ../engine/ToneMatch.ToneMatchOptions}.
   * Kept overridable for tests only; callers should not set it from the
   * source kind.
   */
  linearTone?: boolean;
}

/**
 * Compute adjustments that move `source` toward `reference`.
 *
 * Used for the RAW half of a RAW+JPEG pair: the camera JPEG is the look the
 * photographer already saw on the back of the camera, so it is a far better
 * target than a generic histogram ideal. The result is absolute (it replaces
 * the auto-controlled sliders), because both images are measured *before* any
 * adjustment is applied.
 *
 * Tone is fitted against the real shader math by {@link fitToneMatch} rather
 * than estimated per slider — the six tone controls compose, so they have to
 * be solved together. Colour stays a direct difference: white balance and
 * saturation act independently of each other and of the tone curve.
 *
 * Clarity stays at 0 — local contrast is invisible to a histogram, so guessing
 * it from the JPEG would over-process instead of match. Brilliance is derived from
 * the difference in tonal compression, black lift and colour wash between the
 * two images.
 */
export function matchToReference(
  source: MatchInput,
  reference: MatchInput,
  options: MatchOptions = {},
): AutoResult {
  const tone = fitToneMatch(source.bins.luma, reference.bins.luma, { linear: options.linearTone ?? true });
  const sourceStats = imageStats(source.bins, source.pixels);
  const referenceStats = imageStats(reference.bins, reference.pixels);
  const satDelta = referenceStats.saturation - sourceStats.saturation;

  return {
    ...tone,
    // Positive temperature warms, so a warmer reference pulls the slider up.
    temperature: clamp((referenceStats.warmth - sourceStats.warmth) * 30, -50, 50),
    vibrance: clamp(satDelta * 85, -40, 40),
    saturation: clamp(satDelta * 55, -30, 30),
    clarity: 0,
    // Positive values remove more haze from the source; negative values retain
    // a softer reference look instead of always forcing extra contrast.
    dehaze: clamp((sourceStats.haze - referenceStats.haze) * 30, -25, 25),
  };
}

// ─── Helpers ───

/**
 * The tone curve a balanced image would need: 256 target luma values, one per
 * source luma value.
 *
 * Shape: classic auto-levels — remap the image's own black and white point
 * (p01/p99) onto their ideals, with a gamma in between chosen so the median
 * lands on its target. Opening up blocked shadows needs no separate term: a
 * dark frame gets a gamma below 1, which is exactly a shadow lift. Smooth and monotonic on purpose. An earlier attempt
 * interpolated between separate anchor points and fitted badly: the kinks it
 * produced are not in the family of curves six tone sliders can describe, so
 * the fit thrashed and returned extreme opposing slider values (highlights
 * -87 against shadows +100) that landed nowhere near the target. A curve the
 * shader can actually express is worth more than a curve that states the wish
 * more precisely.
 */
export function idealToneCurve(m: {
  median: number; p01: number; p99: number; highlightPixels: number;
}, tuning: { strength?: number; maxMedianShift?: number } = {}): Float64Array {
  const strength = tuning.strength ?? CORRECTION_STRENGTH;
  const maxShift = tuning.maxMedianShift ?? MAX_MEDIAN_SHIFT;
  const toward = (from: number, to: number) => from + (to - from) * strength;

  // A frame that is already blowing out gets its white point pulled *down*
  // instead of pushed up — the more of it sits in the top zone, the further.
  const whiteIdeal = m.highlightPixels > 0.03
    ? Math.min(TARGET_WHITE, 255 - m.highlightPixels * 60)
    : TARGET_WHITE;

  const inBlack = m.p01;
  const inWhite = Math.max(m.p01 + 1, m.p99);
  const outBlack = toward(m.p01, TARGET_BLACK);
  const outWhite = Math.max(outBlack + 1, toward(m.p99, whiteIdeal));

  // Gamma that carries the median onto its target within the remapped range.
  // Both positions are normalised, so this is independent of the two levels.
  const normIn = (m.median - inBlack) / (inWhite - inBlack);
  const targetMedian = m.median + clampRange(
    toward(m.median, TARGET_MEDIAN) - m.median, -maxShift, maxShift,
  );
  const normOut = (targetMedian - outBlack) / (outWhite - outBlack);
  const gamma = normIn > 0.01 && normIn < 0.99 && normOut > 0.01 && normOut < 0.99
    ? clampRange(Math.log(normOut) / Math.log(normIn), 0.4, 2.5)
    : 1;

  const curve = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const t = clamp01((i - inBlack) / (inWhite - inBlack));
    curve[i] = clampRange(outBlack + Math.pow(t, gamma) * (outWhite - outBlack), 0, 255);
  }
  return curve;
}

function clampRange(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function cdf(bins: number[]): number[] {
  const result = new Array(256);
  result[0] = bins[0];
  for (let i = 1; i < 256; i++) result[i] = result[i - 1] + bins[i];
  return result;
}

function percentile(cumulative: number[], p: number): number {
  const total = cumulative[255];
  const target = total * p;
  for (let i = 0; i < 256; i++) {
    if (cumulative[i] >= target) return i;
  }
  return 255;
}

function weightedMean(bins: number[]): number {
  let sum = 0, count = 0;
  for (let i = 0; i < 256; i++) {
    sum += i * bins[i];
    count += bins[i];
  }
  return count > 0 ? sum / count : 128;
}

function clamp(v: number, min: number, max: number): number {
  return Math.round(Math.max(min, Math.min(max, v)));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Estimate haze from global image statistics. This is intentionally a blend:
 * no single cue is reliable on its own (a gray wall is not necessarily fog).
 */
function hazeLikelihood(p01: number, p99: number, saturation: number): number {
  const tonalCompression = clamp01((200 - (p99 - p01)) / 140);
  const liftedBlacks = clamp01((p01 - 12) / 68);
  const colourWash = clamp01((0.25 - saturation) / 0.25);
  return tonalCompression * 0.5 + liftedBlacks * 0.3 + colourWash * 0.2;
}

/**
 * Analyze white balance from pixel data using gray-world assumption.
 * Returns temperature adjustment (-100..100).
 */
function analyzeWhiteBalance(data: Uint8ClampedArray): { temperature: number } {
  // R > B → warm → negative temp correction; B > R → cool → positive temp
  return { temperature: clamp(-grayWorldWarmth(data) * 30, -25, 25) };
}

/**
 * Gray-world colour cast: (R − B) / G over the reliable midtones.
 * Positive = warm, negative = cool, 0 = neutral.
 */
function grayWorldWarmth(data: Uint8ClampedArray): number {
  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  // Sample every 4th pixel for performance
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // Skip very dark / very bright pixels (unreliable for WB)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 20 || lum > 240) continue;
    rSum += r;
    gSum += g;
    bSum += b;
    count++;
  }

  if (count === 0) return 0;
  return (rSum / count - bSum / count) / (gSum / count + 1);
}

/**
 * Compute average saturation from pixel data (HSL space).
 */
function averageSaturation(data: Uint8ClampedArray): number {
  let satSum = 0, count = 0;

  for (let i = 0; i < data.length; i += 16) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    // Skip near-black and near-white (saturation undefined/unreliable)
    if (l < 0.08 || l > 0.92) continue;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    satSum += s;
    count++;
  }

  return count > 0 ? satSum / count : 0;
}
