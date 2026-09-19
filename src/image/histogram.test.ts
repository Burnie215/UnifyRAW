import { describe, expect, it } from 'vitest';
import {
  buildSvgHistogramPaths,
  getHistogramLayers,
  type HistogramBins,
} from './histogram';

const bins: HistogramBins = {
  red: Array.from({ length: 256 }, (_, index) => index + 1),
  green: Array.from({ length: 256 }, (_, index) => 256 - index),
  blue: Array.from({ length: 256 }, (_, index) => (index % 64) + 1),
  luma: Array.from({ length: 256 }, (_, index) => Math.max(1, 128 - Math.abs(index - 128))),
};

describe('histogram styles', () => {
  it('uses the same four filled channel layers everywhere', () => {
    const layers = getHistogramLayers('filled');
    expect(layers.map(({ channel, mode }) => ({ channel, mode }))).toEqual([
      { channel: 'luma', mode: 'fill' },
      { channel: 'red', mode: 'fill' },
      { channel: 'green', mode: 'fill' },
      { channel: 'blue', mode: 'fill' },
    ]);

    const svg = buildSvgHistogramPaths(bins, 'filled', 120, 40);
    expect(svg.fills.map(({ color, opacity }) => ({ color, opacity }))).toEqual(
      layers.map(({ color, opacity }) => ({ color, opacity })),
    );
    expect(svg.strokes).toHaveLength(0);
  });

  it('uses only channel lines for the lines style', () => {
    const layers = getHistogramLayers('lines');
    expect(layers.every(({ mode }) => mode === 'stroke')).toBe(true);

    const svg = buildSvgHistogramPaths(bins, 'lines', 120, 40);
    expect(svg.fills).toHaveLength(0);
    expect(svg.strokes.map(({ color, opacity, width }) => ({ color, opacity, width }))).toEqual(
      layers.map(({ color, opacity, width }) => ({ color, opacity, width })),
    );
  });

  it('uses a luma fill and RGB lines for the hybrid style', () => {
    expect(getHistogramLayers('hybrid').map(({ channel, mode }) => ({ channel, mode }))).toEqual([
      { channel: 'luma', mode: 'fill' },
      { channel: 'red', mode: 'stroke' },
      { channel: 'green', mode: 'stroke' },
      { channel: 'blue', mode: 'stroke' },
    ]);

    const svg = buildSvgHistogramPaths(bins, 'hybrid', 120, 40);
    expect(svg.fills).toHaveLength(1);
    expect(svg.strokes).toHaveLength(3);
  });
});
