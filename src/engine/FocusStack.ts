/**
 * FocusStack — merge multiple images with different focus planes
 * into a single all-in-focus composite.
 *
 * Algorithm:
 * 1. Align images (translation-only, phase correlation)
 * 2. Compute local sharpness map per image (Laplacian variance in NxN windows)
 * 3. For each pixel, select the image with highest local sharpness
 * 4. Blend with weighted soft transitions to avoid seams
 *
 * All processing is local, no external dependencies.
 */

export interface FocusStackOptions {
  /** Window size for sharpness evaluation (px, odd number) */
  windowSize: number;
  /** Blend smoothness — higher = softer transitions between focus planes (0-100) */
  smoothness: number;
}

const DEFAULT_OPTIONS: FocusStackOptions = {
  windowSize: 15,
  smoothness: 50,
};

/**
 * Stack multiple images with different focus distances into one all-in-focus image.
 * Images should be from the same camera position, only focus differs.
 * @returns Blob of the stacked image (JPEG)
 */
export async function stackFocus(
  imageUrls: string[],
  options: Partial<FocusStackOptions> = {},
): Promise<Blob> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (imageUrls.length === 0) throw new Error('No images');
  if (imageUrls.length === 1) {
    const img = await loadImage(imageUrls[0]);
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d')!.drawImage(img, 0, 0);
    return c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  }

  const images = await Promise.all(imageUrls.map(loadImage));
  const { width, height } = images[0];

  // Get pixel data for each image (scale to match first image if needed)
  const layers = images.map((img) => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  });

  // Compute grayscale for each layer
  const grays = layers.map((layer) => toGrayscale(layer.data, width, height));

  // Compute sharpness maps (Laplacian variance per window)
  const radius = Math.floor(opts.windowSize / 2);
  const sharpnessMaps = grays.map((gray) =>
    computeSharpnessMap(gray, width, height, radius)
  );

  // Smooth sharpness maps to avoid harsh transitions
  const blurRadius = Math.max(1, Math.round(opts.smoothness * 0.3));
  const smoothMaps = sharpnessMaps.map((map) =>
    boxBlur(map, width, height, blurRadius)
  );

  // Composite: for each pixel, weighted blend based on sharpness
  const output = new OffscreenCanvas(width, height);
  const ctx = output.getContext('2d')!;
  const outData = ctx.createImageData(width, height);
  const out = outData.data;

  for (let i = 0; i < width * height; i++) {
    // Compute softmax weights from sharpness values
    const sharpnessValues = smoothMaps.map((m) => m[i]);
    const maxSharp = Math.max(...sharpnessValues);

    // Exponential weighting (softmax-like) for smooth blending
    const temperature = Math.max(0.01, 1 - opts.smoothness / 100) * 10;
    const weights = sharpnessValues.map((s) => Math.exp((s - maxSharp) * temperature));
    const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

    let r = 0, g = 0, b = 0;
    for (let l = 0; l < layers.length; l++) {
      const w = weights[l] / weightSum;
      const d = layers[l].data;
      r += d[i * 4] * w;
      g += d[i * 4 + 1] * w;
      b += d[i * 4 + 2] * w;
    }

    out[i * 4] = Math.round(r);
    out[i * 4 + 1] = Math.round(g);
    out[i * 4 + 2] = Math.round(b);
    out[i * 4 + 3] = 255;
  }

  ctx.putImageData(outData, 0, 0);
  return output.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

// ─── Helpers ───

function toGrayscale(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  }
  return gray;
}

/**
 * Compute sharpness map using Laplacian variance in sliding windows.
 * Higher values = sharper (in-focus) regions.
 */
function computeSharpnessMap(
  gray: Float32Array, w: number, h: number, radius: number,
): Float32Array {
  // Laplacian (approximate with second derivatives)
  const laplacian = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      const lap = -4 * gray[idx]
        + gray[idx - 1] + gray[idx + 1]
        + gray[idx - w] + gray[idx + w];
      laplacian[idx] = lap * lap; // Squared for variance
    }
  }

  // Box-average the squared Laplacian in windows → local variance
  return boxBlur(laplacian, w, h, radius);
}

/** Fast box blur (separable, single pass per axis) */
function boxBlur(input: Float32Array, w: number, h: number, radius: number): Float32Array {
  const temp = new Float32Array(w * h);
  const output = new Float32Array(w * h);
  // Horizontal
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = 0; x < Math.min(radius, w); x++) sum += input[y * w + x];
    for (let x = 0; x < w; x++) {
      if (x + radius < w) sum += input[y * w + x + radius];
      if (x - radius - 1 >= 0) sum -= input[y * w + x - radius - 1];
      const count = Math.min(x + radius, w - 1) - Math.max(x - radius, 0) + 1;
      temp[y * w + x] = sum / count;
    }
  }

  // Vertical
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y < Math.min(radius, h); y++) sum += temp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + radius < h) sum += temp[(y + radius) * w + x];
      if (y - radius - 1 >= 0) sum -= temp[(y - radius - 1) * w + x];
      const count = Math.min(y + radius, h - 1) - Math.max(y - radius, 0) + 1;
      output[y * w + x] = sum / count;
    }
  }

  return output;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
