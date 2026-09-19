export interface ToneCurvePoint {
  x: number;
  y: number;
}

export interface ToneCurveChannels {
  rgb: readonly ToneCurvePoint[];
  luma: readonly ToneCurvePoint[];
  red: readonly ToneCurvePoint[];
  green: readonly ToneCurvePoint[];
  blue: readonly ToneCurvePoint[];
}

const IDENTITY_EPSILON = 1e-6;

/**
 * A curve is a no-op when it covers the complete input range and every
 * control point lies on y=x. This intentionally also accepts extra points on
 * the diagonal; merely adding a point must not change an image.
 */
export function isToneCurveIdentity(points: readonly ToneCurvePoint[]): boolean {
  const sorted = preparePoints(points);
  if (sorted.length < 2) return false;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return Math.abs(first.x) <= IDENTITY_EPSILON
    && Math.abs(first.y) <= IDENTITY_EPSILON
    && Math.abs(last.x - 1) <= IDENTITY_EPSILON
    && Math.abs(last.y - 1) <= IDENTITY_EPSILON
    && sorted.every((point) => Math.abs(point.x - point.y) <= IDENTITY_EPSILON);
}

export function areToneCurvesIdentity(curves: ToneCurveChannels): boolean {
  return isToneCurveIdentity(curves.rgb)
    && isToneCurveIdentity(curves.luma)
    && isToneCurveIdentity(curves.red)
    && isToneCurveIdentity(curves.green)
    && isToneCurveIdentity(curves.blue);
}

/**
 * Evaluate a user curve using monotone cubic Hermite interpolation (PCHIP).
 * Unlike the former per-segment smoothstep implementation, this preserves a
 * straight line exactly and does not introduce artificial contrast around
 * every control point. Monotone input curves also remain free of overshoot.
 */
export function evaluateToneCurve(points: readonly ToneCurvePoint[], input: number): number {
  const sorted = preparePoints(points);
  const t = clamp01(input);
  if (sorted.length < 2) return t;
  if (t <= sorted[0].x) return sorted[0].y;
  if (t >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

  let segment = 0;
  for (let index = 1; index < sorted.length; index++) {
    if (t <= sorted[index].x) {
      segment = index - 1;
      break;
    }
  }

  const slopes = monotoneSlopes(sorted);
  const left = sorted[segment];
  const right = sorted[segment + 1];
  const width = right.x - left.x;
  if (width <= 0) return left.y;

  const u = (t - left.x) / width;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return clamp01(
    h00 * left.y
      + h10 * width * slopes[segment]
      + h01 * right.y
      + h11 * width * slopes[segment + 1],
  );
}

/** Build the packed RGBA LUT consumed by ToneCurvePass. */
export function buildToneCurveLut(curves: ToneCurveChannels): Uint8Array {
  const data = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index++) {
    const input = index / 255;
    const rgb = evaluateToneCurve(curves.rgb, input);
    const luma = evaluateToneCurve(curves.luma, rgb);
    data[index * 4] = Math.round(evaluateToneCurve(curves.red, luma) * 255);
    data[index * 4 + 1] = Math.round(evaluateToneCurve(curves.green, luma) * 255);
    data[index * 4 + 2] = Math.round(evaluateToneCurve(curves.blue, luma) * 255);
    data[index * 4 + 3] = 255;
  }
  return data;
}

function preparePoints(points: readonly ToneCurvePoint[]): ToneCurvePoint[] {
  const sorted = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: clamp01(point.x), y: clamp01(point.y) }))
    .sort((left, right) => left.x - right.x);

  const unique: ToneCurvePoint[] = [];
  for (const point of sorted) {
    const previous = unique[unique.length - 1];
    if (previous && Math.abs(previous.x - point.x) <= Number.EPSILON) {
      unique[unique.length - 1] = point;
    } else {
      unique.push(point);
    }
  }
  return unique;
}

function monotoneSlopes(points: readonly ToneCurvePoint[]): number[] {
  const count = points.length;
  if (count === 2) {
    const slope = (points[1].y - points[0].y) / (points[1].x - points[0].x);
    return [slope, slope];
  }

  const widths: number[] = [];
  const secants: number[] = [];
  for (let index = 0; index < count - 1; index++) {
    const width = points[index + 1].x - points[index].x;
    widths.push(width);
    secants.push((points[index + 1].y - points[index].y) / width);
  }

  const slopes = new Array<number>(count);
  slopes[0] = endpointSlope(widths[0], widths[1], secants[0], secants[1]);
  slopes[count - 1] = endpointSlope(
    widths[count - 2],
    widths[count - 3],
    secants[count - 2],
    secants[count - 3],
  );

  for (let index = 1; index < count - 1; index++) {
    const before = secants[index - 1];
    const after = secants[index];
    if (before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)) {
      slopes[index] = 0;
      continue;
    }
    const beforeWidth = widths[index - 1];
    const afterWidth = widths[index];
    const weightBefore = 2 * afterWidth + beforeWidth;
    const weightAfter = afterWidth + 2 * beforeWidth;
    slopes[index] = (weightBefore + weightAfter)
      / (weightBefore / before + weightAfter / after);
  }
  return slopes;
}

function endpointSlope(
  adjacentWidth: number,
  nextWidth: number,
  adjacentSecant: number,
  nextSecant: number,
): number {
  let slope = (
    (2 * adjacentWidth + nextWidth) * adjacentSecant
      - adjacentWidth * nextSecant
  ) / (adjacentWidth + nextWidth);
  if (Math.sign(slope) !== Math.sign(adjacentSecant)) return 0;
  if (
    Math.sign(adjacentSecant) !== Math.sign(nextSecant)
    && Math.abs(slope) > Math.abs(3 * adjacentSecant)
  ) {
    slope = 3 * adjacentSecant;
  }
  return slope;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
