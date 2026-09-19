/**
 * Synthetic test patterns for compat tests. Generated programmatically so
 * the repo doesn't need to ship binary fixtures yet. Each fixture targets
 * a specific class of pixel paths the pipeline must handle bit-identically.
 *
 * Real-photo fixtures land in tests/fixtures/ via Git-LFS once the browser
 * test environment is wired up.
 */

export interface SyntheticPattern {
  name: string;
  width: number;
  height: number;
  /** Description of what edge case this targets. */
  intent: string;
  /** RGBA8 byte buffer, length = width * height * 4. */
  pixels: Uint8Array;
}

/** Linear gradient from black to white along x. Exercises tone math at every
 *  luminance level — perfect for tone-curve / levels / exposure tests. */
export function gradientHorizontal(width = 256, height = 32): SyntheticPattern {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x / (width - 1)) * 255);
      const i = (y * width + x) * 4;
      pixels[i] = v;
      pixels[i + 1] = v;
      pixels[i + 2] = v;
      pixels[i + 3] = 255;
    }
  }
  return {
    name: 'gradient-horizontal',
    width, height,
    intent: 'tone / levels / curves luminance sweep',
    pixels,
  };
}

/** RGB primaries + secondaries swatches. Tests channel separation and HSL math. */
export function colorSwatches(swatchSize = 32): SyntheticPattern {
  const swatches: Array<[number, number, number]> = [
    [255, 0,   0],   // red
    [255, 128, 0],   // orange
    [255, 255, 0],   // yellow
    [0,   255, 0],   // green
    [0,   255, 255], // aqua
    [0,   0,   255], // blue
    [128, 0,   255], // purple
    [255, 0,   255], // magenta
  ];
  const cols = 4, rows = 2;
  const width = cols * swatchSize, height = rows * swatchSize;
  const pixels = new Uint8Array(width * height * 4);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [sr, sg, sb] = swatches[r * cols + c];
      for (let y = 0; y < swatchSize; y++) {
        for (let x = 0; x < swatchSize; x++) {
          const px = (r * swatchSize + y) * width + (c * swatchSize + x);
          const i = px * 4;
          pixels[i] = sr;
          pixels[i + 1] = sg;
          pixels[i + 2] = sb;
          pixels[i + 3] = 255;
        }
      }
    }
  }
  return {
    name: 'color-swatches',
    width, height,
    intent: 'HSL / BW / color-grading hue paths',
    pixels,
  };
}

/** Checkerboard of clipping-corner cases: pure white, pure black, 50% gray. */
export function clippingCorners(): SyntheticPattern {
  const width = 16, height = 16;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Quadrants: TL=black, TR=white, BL=mid, BR=near-black-but-not-zero
      let v: number;
      if (y < 8 && x < 8) v = 0;
      else if (y < 8) v = 255;
      else if (x < 8) v = 128;
      else v = 4;
      pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255;
    }
  }
  return {
    name: 'clipping-corners',
    width, height,
    intent: 'clamp paths at black/white/mid + near-black',
    pixels,
  };
}

/** Sharp 1px lines for sharpen + neighbour-sampling validation. */
export function sharpEdges(width = 64, height = 64): SyntheticPattern {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const onEdge = x === width / 2 || y === height / 2;
      const v = onEdge ? 255 : 32;
      const i = (y * width + x) * 4;
      pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255;
    }
  }
  return {
    name: 'sharp-edges',
    width, height,
    intent: 'sharpen / clarity neighbour-sampling',
    pixels,
  };
}

/** All standard fixtures in one array — convenience for parameterised tests. */
export const STANDARD_FIXTURES: ReadonlyArray<SyntheticPattern> = [
  gradientHorizontal(),
  colorSwatches(),
  clippingCorners(),
  sharpEdges(),
];
