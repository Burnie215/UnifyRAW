/**
 * ToneMatch — fits the tone sliders so one image's histogram lands on another's.
 *
 * Matching a RAW render to its camera JPEG is not six independent nudges: the
 * sliders act *sequentially* on the same pixel, so exposure already moves the
 * white point that whites is then asked to move again. Deriving each slider
 * from the same untouched measurement double-counts, overshoots, and the
 * clamps turn the overshoot into a squashed histogram.
 *
 * So instead of guessing coefficients, this module
 *   1. builds the target transfer curve by classical histogram matching
 *      (`map[v] = refCdf⁻¹(srcCdf(v))`),
 *   2. simulates what {@link ../engine/passes/TonePass} actually computes, and
 *   3. fits the six sliders to that curve by coordinate descent, weighted by
 *      how many pixels each luma value actually holds.
 *
 * The simulation mirrors TonePass.ts exactly — if that shader changes, this
 * must follow. ToneMatch.browser.test.ts renders a ramp through the real
 * graph and fails when the two drift apart; ToneMatch.test.ts cannot, it only
 * checks the simulation against itself.
 */

export interface ToneMatchAdjustments {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

export interface ToneMatchOptions {
  /**
   * True when TonePass sees linear light while the histogram was measured on
   * the gamma-encoded display output — the simulation then decodes and
   * re-encodes around the tone math.
   *
   * Since the Phase-2 hard cut this is true for *every* source. The graph puts
   * the tone node in the working-linear block for both `imageBitmap` (the
   * compiler inserts a gamma→linear convert at the head) and `raw16` (already
   * linear); see `chainForSource` in DefaultGraphBuilder.ts. Measured on the
   * gray wedge, `linear: true` reproduces the real GL output to within 0.5
   * code values while `linear: false` is off by up to 45, so callers should
   * not be deriving this from the source kind.
   */
  linear?: boolean;
  /**
   * Overrides {@link SIMPLICITY_WEIGHT}. The generic auto mode raises it: its
   * target curve is an ideal rather than a measured image, so buying a little
   * curve accuracy with extreme opposing sliders is a bad trade there.
   */
  simplicityWeight?: number;
}

const NEUTRAL: ToneMatchAdjustments = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
};

/**
 * Tie-breaker weight. Many slider combinations describe nearly the same curve
 * — a plain exposure lift can be imitated by piling blacks, whites and shadows
 * against each other. Penalising slider magnitude picks the simple answer out
 * of that family. At this weight the penalty is worth well under one code
 * value of curve error, so it never overrides an actually better fit, but it
 * keeps the panel readable and the result sane to tweak by hand afterwards.
 */
const SIMPLICITY_WEIGHT = 1;

/** Slider order for the descent: coarse global moves before local shaping. */
const SLIDERS: (keyof ToneMatchAdjustments)[] = [
  'exposure', 'contrast', 'blacks', 'whites', 'shadows', 'highlights',
];

/**
 * One neutral pixel through TonePass. For a neutral pixel the shader's
 * `dot(c, vec3(0.299, 0.587, 0.114))` collapses to `c` itself, so a scalar is
 * an exact model of the luma channel rather than an approximation.
 */
export function applyTone(value: number, adj: ToneMatchAdjustments, linear = false): number {
  let c = linear ? srgbToLinear(value) : value;

  c *= Math.pow(2, (adj.exposure / 100) * 2);
  c += (adj.blacks / 100) * 0.1;
  c *= 1 + (adj.whites / 100) * 0.15;

  const lum = c;
  c += c * (adj.shadows / 100) * 0.5 * (1 - smoothstep(0, 0.5, lum));
  c += c * (adj.highlights / 100) * 0.5 * smoothstep(0.5, 1, lum);

  c = 0.5 + (c - 0.5) * (1 + adj.contrast / 100);
  c = Math.min(1, Math.max(0, c));

  return linear ? linearToSrgb(c) : c;
}

/**
 * The tone curve that maps `source` onto `reference`, as 256 target luma
 * values. Monotonic by construction, which is what keeps the fit stable.
 */
export function matchingCurve(source: readonly number[], reference: readonly number[]): Float64Array {
  const sourceCdf = normalizedCdf(source);
  const referenceCdf = normalizedCdf(reference);
  const curve = new Float64Array(256);

  let j = 0;
  for (let i = 0; i < 256; i++) {
    while (j < 255 && referenceCdf[j] < sourceCdf[i]) j++;
    curve[i] = j;
  }
  return curve;
}

/**
 * Fit the six tone sliders so the source histogram lands on the reference's.
 * Returns slider units (-100..100), all integers.
 */
export function fitToneMatch(
  source: readonly number[],
  reference: readonly number[],
  options: ToneMatchOptions = {},
): ToneMatchAdjustments {
  const referenceTotal = reference.reduce((sum, count) => sum + count, 0);
  if (referenceTotal === 0) return { ...NEUTRAL };
  return fitToneCurve(source, matchingCurve(source, reference), options);
}

/**
 * Fit the six tone sliders to an arbitrary target curve — 256 target luma
 * values, one per source luma value.
 *
 * This is the half of {@link fitToneMatch} that does the actual work, split
 * out because the generic auto mode has a target curve too: it just builds it
 * from ideal anchor points instead of from a reference histogram. Both modes
 * fitting through the same simulated shader is what keeps them honest — a
 * per-slider coefficient can be calibrated for the wrong colour space without
 * anyone noticing, a fit against {@link applyTone} cannot.
 */
export function fitToneCurve(
  source: readonly number[],
  target: Float64Array | readonly number[],
  options: ToneMatchOptions = {},
): ToneMatchAdjustments {
  const total = source.reduce((sum, count) => sum + count, 0);
  if (total === 0) return { ...NEUTRAL };

  // Weighting by population keeps a nearly empty shadow bin from dragging the
  // fit around while the densely populated midtones drift.
  const weight = source.map((count) => count / total);
  const linear = options.linear ?? false;
  const simplicity = options.simplicityWeight ?? SIMPLICITY_WEIGHT;

  const cost = (adj: ToneMatchAdjustments): number => {
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      if (weight[i] === 0) continue;
      const delta = applyTone(i / 255, adj, linear) * 255 - target[i];
      sum += weight[i] * delta * delta;
    }
    for (const slider of SLIDERS) {
      const normalized = adj[slider] / 100;
      sum += simplicity * normalized * normalized;
    }
    return sum;
  };

  // Coordinate descent, halving the step down to single slider units. Powers
  // of two from 32 keep every visited value an integer.
  const descend = (start: ToneMatchAdjustments): ToneMatchAdjustments => {
    let current = { ...start };
    let currentCost = cost(current);
    for (let step = 32; step >= 1; step /= 2) {
      let improved = true;
      while (improved) {
        improved = false;
        for (const slider of SLIDERS) {
          for (const direction of [1, -1]) {
            const value = clampSlider(current[slider] + direction * step);
            if (value === current[slider]) continue;
            const candidate = { ...current, [slider]: value };
            const candidateCost = cost(candidate);
            if (candidateCost < currentCost - 1e-9) {
              current = candidate;
              currentCost = candidateCost;
              improved = true;
            }
          }
        }
      }
    }
    return current;
  };

  // Descending from neutral alone lands in a local minimum: the coarse steps
  // cannot express a small exposure move, so the other sliders absorb the
  // error and the descent never finds its way back. Seeding a second run with
  // the exposure that maps the median onto its target puts one attempt in the
  // right basin from the start; the better of the two wins.
  const candidates = [descend(NEUTRAL), descend(seedExposure(target, weight, linear))];
  return candidates.reduce((a, b) => (cost(b) < cost(a) ? b : a));
}

/** Exposure alone that would carry the population median onto its target. */
function seedExposure(
  target: Float64Array | readonly number[],
  weight: readonly number[],
  linear: boolean,
): ToneMatchAdjustments {
  let cumulative = 0;
  let median = 127;
  for (let i = 0; i < 256; i++) {
    cumulative += weight[i];
    if (cumulative >= 0.5) { median = i; break; }
  }

  const encode = (v: number) => (linear ? srgbToLinear(v) : v);
  const from = encode(median / 255);
  const to = encode(target[median] / 255);
  if (from <= 1e-6 || to <= 1e-6) return { ...NEUTRAL };

  // The shader computes c *= 2^(2 * exposure/100), so a factor f needs
  // exposure = 50 * log2(f).
  return { ...NEUTRAL, exposure: clampSlider(Math.round(50 * Math.log2(to / from))) };
}

// ─── Helpers ───

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function normalizedCdf(bins: readonly number[]): Float64Array {
  const cdf = new Float64Array(256);
  let running = 0;
  for (let i = 0; i < 256; i++) {
    running += bins[i] ?? 0;
    cdf[i] = running;
  }
  const total = cdf[255];
  if (total > 0) for (let i = 0; i < 256; i++) cdf[i] /= total;
  return cdf;
}

function clampSlider(v: number): number {
  return Math.max(-100, Math.min(100, v));
}
