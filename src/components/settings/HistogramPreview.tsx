import type { HistogramStyle } from '../../types';
import {
  buildSvgHistogramPaths,
  HISTOGRAM_BACKGROUND,
  type HistogramBins,
} from '../../image/histogram';

const PREVIEW_BINS: HistogramBins = createPreviewBins();

function createPreviewBins(): HistogramBins {
  const gaussian = (x: number, center: number, width: number, amplitude: number) =>
    amplitude * Math.exp(-Math.pow((x - center) / width, 2));
  const channel = (center: number, shoulder: number) => Array.from({ length: 256 }, (_, index) => {
    const x = index / 255;
    return gaussian(x, center, 0.18, 80) + gaussian(x, shoulder, 0.08, 35) + 2;
  });
  const red = channel(0.58, 0.82);
  const green = channel(0.49, 0.70);
  const blue = channel(0.40, 0.62);
  const luma = red.map((value, index) =>
    0.299 * value + 0.587 * green[index] + 0.114 * blue[index]);
  return { red, green, blue, luma };
}

/** Mini histogram preview for style selection */
export function HistogramPreview({ style }: { style: HistogramStyle }) {
  const w = 120, h = 40;
  const paths = buildSvgHistogramPaths(PREVIEW_BINS, style, w, h, 1, 1);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="settings-hist-preview">
      <rect width={w} height={h} fill={HISTOGRAM_BACKGROUND} />
      {paths.fills.map((fill, index) => (
        <path key={`fill-${index}`} d={fill.d} fill={fill.color} opacity={fill.opacity}
          style={fill.blend ? { mixBlendMode: fill.blend } : undefined} />
      ))}
      {paths.strokes.map((stroke, index) => (
        <path
          key={`stroke-${index}`}
          d={stroke.d}
          fill="none"
          stroke={stroke.color}
          opacity={stroke.opacity}
          strokeWidth={stroke.width}
        />
      ))}
    </svg>
  );
}
