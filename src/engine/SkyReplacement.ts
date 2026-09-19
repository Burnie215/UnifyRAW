/**
 * SkyReplacement — detect sky region and composite a replacement sky image.
 *
 * Flow:
 * 1. Detect sky mask via AI segmentation (or manual brush mask)
 * 2. Load replacement sky image from Blob
 * 3. Composite: replace sky pixels with replacement image, blended via mask
 *
 * The sky mask uses soft alpha edges for natural blending at the horizon.
 */

import type { BlendMode } from './DocumentModel';

export interface SkyReplacementConfig {
  skyBlob: Blob;
  opacity: number;           // 0-1
  blendMode: BlendMode;
  edgeFeather: number;       // 0-100, softness of mask edge
  horizonOffset: number;     // -50..50, shift sky position vertically
  flipSky: boolean;
}

export const DEFAULT_SKY_CONFIG: Omit<SkyReplacementConfig, 'skyBlob'> = {
  opacity: 1,
  blendMode: 'normal',
  edgeFeather: 15,
  horizonOffset: 0,
  flipSky: false,
};

/**
 * Composite a sky replacement onto the rendered image.
 * Takes the base rendered canvas and a sky mask (from AI segmentation).
 *
 * @param baseCanvas - The fully rendered image
 * @param skyMask - Alpha mask where white = sky, black = foreground (same dims as baseCanvas)
 * @param config - Sky replacement settings
 * @returns New canvas with sky replaced
 */
export async function compositeSkyReplacement(
  baseCanvas: OffscreenCanvas,
  skyMask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  config: SkyReplacementConfig,
): Promise<OffscreenCanvas> {
  const { width, height } = baseCanvas;
  const result = new OffscreenCanvas(width, height);
  const ctx = result.getContext('2d')!;

  // Draw base image
  ctx.drawImage(baseCanvas, 0, 0);

  // Load sky image
  const skyBitmap = await createImageBitmap(config.skyBlob);

  // Create sky canvas: scale + position sky to cover the sky region
  const skyCanvas = new OffscreenCanvas(width, height);
  const skyCtx = skyCanvas.getContext('2d')!;

  if (config.flipSky) {
    skyCtx.translate(width, 0);
    skyCtx.scale(-1, 1);
  }

  // Offset sky vertically
  const yOffset = (config.horizonOffset / 100) * height;

  // Cover-fit: scale sky image to fill width, crop height
  const skyAspect = skyBitmap.width / skyBitmap.height;
  const canvasAspect = width / height;
  let drawW: number, drawH: number, drawX: number, drawY: number;

  if (skyAspect > canvasAspect) {
    drawH = height;
    drawW = height * skyAspect;
    drawX = (width - drawW) / 2;
    drawY = yOffset;
  } else {
    drawW = width;
    drawH = width / skyAspect;
    drawX = 0;
    drawY = yOffset;
  }

  skyCtx.drawImage(skyBitmap, drawX, drawY, drawW, drawH);
  skyBitmap.close();

  // Apply feathered sky mask
  const featheredMask = featherMask(skyMask, maskWidth, maskHeight, config.edgeFeather);

  // Get pixel data for manual alpha compositing
  const baseData = ctx.getImageData(0, 0, width, height);
  const skyData = skyCtx.getImageData(0, 0, width, height);
  const out = baseData.data;
  const sky = skyData.data;
  const opacity = config.opacity;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Scale mask coords
      const mx = Math.floor((x / width) * maskWidth);
      const my = Math.floor((y / height) * maskHeight);
      const maskVal = featheredMask[my * maskWidth + mx] / 255;
      const alpha = maskVal * opacity;

      if (alpha > 0) {
        const i = (y * width + x) * 4;
        out[i]     = out[i]     + (sky[i]     - out[i])     * alpha;
        out[i + 1] = out[i + 1] + (sky[i + 1] - out[i + 1]) * alpha;
        out[i + 2] = out[i + 2] + (sky[i + 2] - out[i + 2]) * alpha;
      }
    }
  }

  ctx.putImageData(baseData, 0, 0);
  return result;
}

/**
 * Apply Gaussian-like feathering to a mask by box-blurring N times.
 * Approximates Gaussian blur for smooth sky/foreground transitions.
 */
function featherMask(
  mask: Uint8Array,
  width: number,
  height: number,
  featherAmount: number,
): Uint8Array {
  if (featherAmount <= 0) return mask;

  const radius = Math.max(1, Math.round(featherAmount * 0.5));
  let current = new Float32Array(mask);
  let next = new Float32Array(width * height);

  // 3-pass box blur ≈ Gaussian
  for (let pass = 0; pass < 3; pass++) {
    // Horizontal
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, count = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < width) {
            sum += current[y * width + nx];
            count++;
          }
        }
        next[y * width + x] = sum / count;
      }
    }
    [current, next] = [next, current];

    // Vertical
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny >= 0 && ny < height) {
            sum += current[ny * width + x];
            count++;
          }
        }
        next[y * width + x] = sum / count;
      }
    }
    [current, next] = [next, current];
  }

  const result = new Uint8Array(width * height);
  for (let i = 0; i < result.length; i++) {
    result[i] = Math.round(Math.max(0, Math.min(255, current[i])));
  }
  return result;
}
