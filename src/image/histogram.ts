/**
 * Shared histogram computation used by all histogram displays
 * (main histogram, tone curve, levels panel).
 */
import type { HistogramStyle } from '../types';

const DOWNSCALE = 200; // max dimension for pixel sampling

export const HISTOGRAM_BACKGROUND = '#111111';

export interface HistogramBins {
  red: number[];
  green: number[];
  blue: number[];
  luma: number[];
}

export type HistogramChannel = keyof HistogramBins;

export interface HistogramLayer {
  channel: HistogramChannel;
  mode: 'fill' | 'stroke';
  color: string;
  opacity: number;
  width?: number;
  /**
   * Composite mode for this layer. Painted normally, the last channel drawn
   * tints every overlap with its own colour — the blue layer used to give the
   * filled style an overall cast. 'screen' is order-independent, so areas
   * where the channels agree come out neutral, as a RGB histogram should read.
   */
  blend?: 'screen';
}

/**
 * The single visual definition used by every histogram renderer. Keeping the
 * channel order, colours and opacity here prevents the Canvas main histogram,
 * SVG adjustment histograms and settings previews from drifting apart.
 */
const HISTOGRAM_LAYERS: Record<HistogramStyle, readonly HistogramLayer[]> = {
  filled: [
    { channel: 'luma', mode: 'fill', color: '#888888', opacity: 0.35 },
    { channel: 'red', mode: 'fill', color: '#e74c3c', opacity: 0.34, blend: 'screen' },
    { channel: 'green', mode: 'fill', color: '#2ecc71', opacity: 0.34, blend: 'screen' },
    { channel: 'blue', mode: 'fill', color: '#3498db', opacity: 0.34, blend: 'screen' },
  ],
  lines: [
    { channel: 'luma', mode: 'stroke', color: '#aaaaaa', opacity: 0.50, width: 1 },
    { channel: 'red', mode: 'stroke', color: '#e74c3c', opacity: 0.70, width: 1 },
    { channel: 'green', mode: 'stroke', color: '#2ecc71', opacity: 0.70, width: 1 },
    { channel: 'blue', mode: 'stroke', color: '#3498db', opacity: 0.70, width: 1 },
  ],
  hybrid: [
    { channel: 'luma', mode: 'fill', color: '#888888', opacity: 0.35 },
    { channel: 'red', mode: 'stroke', color: '#e74c3c', opacity: 0.70, width: 1 },
    { channel: 'green', mode: 'stroke', color: '#2ecc71', opacity: 0.70, width: 1 },
    { channel: 'blue', mode: 'stroke', color: '#3498db', opacity: 0.70, width: 1 },
  ],
};

export function getHistogramLayers(style: HistogramStyle): readonly HistogramLayer[] {
  return HISTOGRAM_LAYERS[style];
}

/** Compute per-channel histogram bins from pixel data */
export function histogramFromPixels(data: Uint8ClampedArray): HistogramBins {
  const red = new Array(256).fill(0);
  const green = new Array(256).fill(0);
  const blue = new Array(256).fill(0);
  const luma = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    red[r]++;
    green[g]++;
    blue[b]++;
    luma[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++;
  }
  return { red, green, blue, luma };
}

/** Compute histogram from an HTMLCanvasElement (e.g. the rendered WebGL canvas) */
export function histogramFromCanvas(canvas: HTMLCanvasElement): HistogramBins | null {
  if (!canvas || canvas.width === 0) return null;
  try {
    const scale = Math.min(DOWNSCALE / canvas.width, DOWNSCALE / canvas.height, 1);
    const w = Math.round(canvas.width * scale);
    const h = Math.round(canvas.height * scale);
    const off = new OffscreenCanvas(w, h);
    const ctx = off.getContext('2d')!;
    ctx.drawImage(canvas, 0, 0, w, h);
    return histogramFromPixels(ctx.getImageData(0, 0, w, h).data);
  } catch {
    return null;
  }
}

/** Compute histogram from an image URL (fallback when no rendered canvas) */
export async function histogramFromUrl(imageUrl: string): Promise<HistogramBins | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const scale = Math.min(DOWNSCALE / img.width, DOWNSCALE / img.height, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, w, h);
      try {
        resolve(histogramFromPixels(ctx.getImageData(0, 0, w, h).data));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = imageUrl;
  });
}

/**
 * Normalize histogram bins for display.
 * Uses the top 0.5% percentile as maximum — this clips extreme outlier peaks
 * and shows more detail in the rest of the distribution.
 */
export function histogramMax(bins: number[]): number {
  const sorted = [...bins].sort((a, b) => b - a);
  return sorted[Math.floor(sorted.length * 0.005)] || 1;
}

/**
 * Draw histogram on a Canvas 2D context with the given style.
 */
export function drawHistogram(
  ctx: CanvasRenderingContext2D,
  bins: HistogramBins,
  w: number, h: number,
  style: HistogramStyle,
) {
  const mx = histogramMax(bins.luma);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = HISTOGRAM_BACKGROUND;
  ctx.fillRect(0, 0, w, h);

  const bottom = h - 1;
  const plotHeight = Math.max(0, h - 2);
  const trace = (arr: number[]) => {
    ctx.beginPath();
    for (let x = 0; x < 256; x++) {
      const px = (x / 255) * w;
      const py = bottom - Math.min(arr[x] / mx, 1) * plotHeight;
      if (x === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  };

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const layer of getHistogramLayers(style)) {
    trace(bins[layer.channel]);
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = layer.blend ?? 'source-over';
    if (layer.mode === 'fill') {
      ctx.lineTo(w, bottom);
      ctx.lineTo(0, bottom);
      ctx.closePath();
      ctx.fillStyle = layer.color;
      ctx.fill();
    } else {
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width ?? 1;
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Build SVG path data for a histogram channel.
 * Used by ToneCurve and LevelsPanel for their SVG-based histograms.
 */
export function buildSvgHistogramPaths(
  bins: HistogramBins,
  style: HistogramStyle,
  w: number, h: number,
  padX = 0, padY = 0,
): { fills: { d: string; color: string; opacity: number; blend?: 'screen' }[]; strokes: { d: string; color: string; opacity: number; width: number }[] } {
  const mx = histogramMax(bins.luma);

  const areaPath = (arr: number[]) => {
    let d = `M${padX},${h - padY}`;
    for (let x = 0; x < 256; x++) {
      const sx = padX + (x / 255) * (w - 2 * padX);
      const sy = (h - padY) - Math.min(arr[x] / mx, 1) * (h - 2 * padY);
      d += ` L${sx},${sy}`;
    }
    d += ` L${w - padX},${h - padY} Z`;
    return d;
  };

  const linePath = (arr: number[]) => {
    let d = '';
    for (let x = 0; x < 256; x++) {
      const sx = padX + (x / 255) * (w - 2 * padX);
      const sy = (h - padY) - Math.min(arr[x] / mx, 1) * (h - 2 * padY);
      d += x === 0 ? `M${sx},${sy}` : ` L${sx},${sy}`;
    }
    return d;
  };

  const fills: { d: string; color: string; opacity: number; blend?: 'screen' }[] = [];
  const strokes: { d: string; color: string; opacity: number; width: number }[] = [];

  for (const layer of getHistogramLayers(style)) {
    if (layer.mode === 'fill') {
      fills.push({ d: areaPath(bins[layer.channel]), color: layer.color, opacity: layer.opacity, blend: layer.blend });
    } else {
      strokes.push({
        d: linePath(bins[layer.channel]),
        color: layer.color,
        opacity: layer.opacity,
        width: layer.width ?? 1,
      });
    }
  }

  return { fills, strokes };
}
