/**
 * HDRMerge — merge multiple exposures into a single HDR image.
 *
 * Algorithm: Exposure-weighted averaging (Debevec-style simplified).
 * 1. Load all bracketed exposures
 * 2. Estimate relative exposure from EXIF or pixel brightness
 * 3. Weight pixels by quality (mid-tones weighted higher, clipped pixels down-weighted)
 * 4. Merge into linear HDR buffer (Float32)
 * 5. Tone-map to LDR (Reinhard global operator)
 * 6. Output as Blob (JPEG/PNG)
 *
 * All processing is local, no external dependencies.
 */

export interface HDRInput {
  url: string;
  /** Relative EV offset (0 = base, -2 = 2 stops under, +2 = 2 stops over) */
  ev: number;
}

export interface HDROptions {
  /** Ghost reduction strength 0-100 (reduces artifacts from moving objects) */
  ghostReduction: number;
  /** Tone mapping strength 0-100 */
  toneMappingStrength: number;
}

const DEFAULT_OPTIONS: HDROptions = {
  ghostReduction: 50,
  toneMappingStrength: 50,
};

/**
 * Merge multiple exposures into a tone-mapped HDR image.
 * @returns Blob of the merged image (JPEG)
 */
export async function mergeHDR(
  inputs: HDRInput[],
  options: Partial<HDROptions> = {},
): Promise<Blob> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (inputs.length === 0) throw new Error('No inputs');
  if (inputs.length === 1) {
    // Single image — just return as-is
    const img = await loadImage(inputs[0].url);
    const canvas = new OffscreenCanvas(img.width, img.height);
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  }

  // Load all images
  const images = await Promise.all(inputs.map(async (input) => {
    const img = await loadImage(input.url);
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    return {
      data: ctx.getImageData(0, 0, img.width, img.height),
      ev: input.ev,
      width: img.width,
      height: img.height,
    };
  }));

  // Use dimensions of first image
  const { width, height } = images[0];

  // Merge into HDR buffer (linear float per channel)
  const hdr = new Float32Array(width * height * 3);
  const weightSum = new Float32Array(width * height);

  for (const img of images) {
    const evScale = Math.pow(2, -img.ev); // Normalize to base exposure
    const d = img.data.data;

    // Scale image if different size
    let pixels = d;
    if (img.width !== width || img.height !== height) {
      const scaled = scaleImageData(img.data, width, height);
      pixels = scaled.data;
    }

    for (let i = 0; i < width * height; i++) {
      const r = pixels[i * 4] / 255;
      const g = pixels[i * 4 + 1] / 255;
      const b = pixels[i * 4 + 2] / 255;

      // Weight: triangle function — highest weight for mid-tones
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const w = weightFunction(lum, opts.ghostReduction / 100);

      hdr[i * 3]     += r * evScale * w;
      hdr[i * 3 + 1] += g * evScale * w;
      hdr[i * 3 + 2] += b * evScale * w;
      weightSum[i] += w;
    }
  }

  // Normalize
  for (let i = 0; i < width * height; i++) {
    const ws = weightSum[i] || 1;
    hdr[i * 3]     /= ws;
    hdr[i * 3 + 1] /= ws;
    hdr[i * 3 + 2] /= ws;
  }

  // Tone map (Reinhard global)
  const strength = opts.toneMappingStrength / 100;
  const output = new OffscreenCanvas(width, height);
  const ctx = output.getContext('2d')!;
  const outData = ctx.createImageData(width, height);
  const out = outData.data;

  // Find average luminance for Reinhard key
  let lumSum = 0;
  const epsilon = 0.001;
  for (let i = 0; i < width * height; i++) {
    const lum = 0.299 * hdr[i * 3] + 0.587 * hdr[i * 3 + 1] + 0.114 * hdr[i * 3 + 2];
    lumSum += Math.log(lum + epsilon);
  }
  const avgLum = Math.exp(lumSum / (width * height));
  const key = 0.18 / (avgLum + epsilon);

  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      const v = hdr[i * 3 + c] * key;
      // Reinhard: L / (1 + L), blended with linear based on strength
      const mapped = v / (1 + v);
      const linear = Math.min(1, hdr[i * 3 + c]);
      const final = linear * (1 - strength) + mapped * strength;
      out[i * 4 + c] = Math.round(Math.max(0, Math.min(255, final * 255)));
    }
    out[i * 4 + 3] = 255;
  }

  ctx.putImageData(outData, 0, 0);
  return output.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

/**
 * Auto-detect EV offsets from EXIF exposure times.
 * Returns relative EV values (first image = 0).
 */
export function estimateEVFromExif(
  exposures: { shutterSpeed?: string | null; iso?: number | null; aperture?: number | null }[],
): number[] {
  const evs = exposures.map((e) => {
    const t = parseShutterSpeed(e.shutterSpeed);
    const iso = e.iso ?? 100;
    const f = e.aperture ?? 5.6;
    if (t <= 0) return 0;
    // EV = log2(f² / t) - log2(iso / 100)
    return Math.log2((f * f) / t) - Math.log2(iso / 100);
  });

  const base = evs[0];
  return evs.map((ev) => ev - base);
}

// ─── Helpers ───

function weightFunction(luminance: number, ghostFactor: number): number {
  // Triangle weight: peaks at 0.5, zero at 0 and 1
  // ghostFactor narrows the peak (higher = more aggressive clipping rejection)
  const center = 0.5;
  const width = 0.5 - ghostFactor * 0.3; // 0.5 at ghost=0, 0.2 at ghost=1
  const dist = Math.abs(luminance - center);
  return Math.max(0, 1 - dist / Math.max(width, 0.05));
}

function scaleImageData(src: ImageData, targetW: number, targetH: number): ImageData {
  const canvas = new OffscreenCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d')!;
  const srcCanvas = new OffscreenCanvas(src.width, src.height);
  srcCanvas.getContext('2d')!.putImageData(src, 0, 0);
  ctx.drawImage(srcCanvas, 0, 0, targetW, targetH);
  return ctx.getImageData(0, 0, targetW, targetH);
}

function parseShutterSpeed(s: string | null | undefined): number {
  if (!s) return 0;
  if (s.includes('/')) {
    const [num, den] = s.split('/').map(Number);
    return den > 0 ? num / den : 0;
  }
  return Number(s) || 0;
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
