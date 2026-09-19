/**
 * AI-based image segmentation for automatic masking.
 * Uses ONNX Runtime Web (WASM) with pre-trained models.
 *
 * Supported mask types:
 * - Sky detection
 * - Person/body segmentation
 * - Subject/foreground detection
 *
 * Models are loaded lazily on first use.
 * Place ONNX model files in public/models/
 */

import { loadWasmOrtRuntime } from './onnxWasmRuntime';

export type SegmentationType = 'sky' | 'person' | 'subject' | 'background' | 'foreground' | 'animal';

export interface SegmentationResult {
  /** Alpha mask: 0 = background, 255 = foreground */
  mask: Uint8Array;
  width: number;
  height: number;
  /** Confidence score 0..1 */
  confidence: number;
}

const MODEL_INPUT_SIZE = 512;

/**
 * Prepare image for model input: resize to 512x512, normalize to float32.
 */
async function prepareInput(imageUrl: string): Promise<{
  tensor: Float32Array;
  originalWidth: number;
  originalHeight: number;
}> {
  const img = await loadImage(imageUrl);
  const originalWidth = img.width;
  const originalHeight = img.height;

  const canvas = new OffscreenCanvas(MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

  const imageData = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
  const { data } = imageData;

  // Convert to CHW float32 normalized [0,1]
  const tensor = new Float32Array(3 * MODEL_INPUT_SIZE * MODEL_INPUT_SIZE);
  const pixelCount = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;

  for (let i = 0; i < pixelCount; i++) {
    tensor[i] = data[i * 4] / 255;                    // R
    tensor[pixelCount + i] = data[i * 4 + 1] / 255;   // G
    tensor[2 * pixelCount + i] = data[i * 4 + 2] / 255; // B
  }

  return { tensor, originalWidth, originalHeight };
}

/**
 * Scale model output mask back to original image dimensions.
 */
export function scaleMask(
  modelOutput: Float32Array | Uint8Array,
  modelSize: number,
  targetWidth: number,
  targetHeight: number,
  threshold: number = 0.5,
): Uint8Array {
  const result = new Uint8Array(targetWidth * targetHeight);

  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.floor((x / targetWidth) * modelSize);
      const sy = Math.floor((y / targetHeight) * modelSize);
      const val = modelOutput[sy * modelSize + sx];
      // Normalize: if float, threshold at 0.5; if uint8, threshold at 128
      const normalized = val > 1 ? val / 255 : val;
      result[y * targetWidth + x] = normalized > threshold ? 255 : 0;
    }
  }

  return result;
}

/**
 * Scale model output to target dimensions preserving soft alpha values.
 * Produces smooth 0-255 mask instead of binary threshold.
 */
function scaleMaskSoft(
  modelOutput: Float32Array | Uint8Array,
  modelSize: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array {
  const result = new Uint8Array(targetWidth * targetHeight);

  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const sx = Math.floor((x / targetWidth) * modelSize);
      const sy = Math.floor((y / targetHeight) * modelSize);
      const val = modelOutput[sy * modelSize + sx];
      // Normalize: if float [0,1] → [0,255]; if uint8 keep as-is
      const normalized = val > 1 ? val : Math.round(val * 255);
      result[y * targetWidth + x] = Math.max(0, Math.min(255, normalized));
    }
  }

  return result;
}

/**
 * Simple fallback segmentation when ONNX is not available.
 * Uses basic color/luminance heuristics.
 */
function fallbackSkyMask(imageUrl: string, width: number, height: number): Promise<SegmentationResult> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      const mask = new Uint8Array(width * height);

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          // Sky heuristic: blue-ish, bright, upper half weighted
          const blueRatio = b / (r + g + b + 1);
          const brightness = (r + g + b) / 3;
          const yWeight = 1 - (y / height);
          const isSky = blueRatio > 0.35 && brightness > 120 && yWeight > 0.3;
          mask[y * width + x] = isSky ? 255 : 0;
        }
      }

      resolve({ mask, width, height, confidence: 0.5 });
    };
    img.src = imageUrl;
  });
}

/**
 * Run AI segmentation on an image.
 * Tries ONNX Runtime first, falls back to heuristics.
 */
export async function segmentImage(
  imageUrl: string,
  type: SegmentationType,
): Promise<SegmentationResult> {
  try {
    // Try loading ONNX Runtime
    // Segmentation only uses the WASM execution provider. Importing the
    // provider-specific entry keeps WebGPU/WebGL and their larger fallback
    // runtime out of this lazy feature chunk.
    const ort = await loadWasmOrtRuntime();

    // U²-Net (~44MB) for subject/background/foreground, MODNet (~25MB) for person
    // Animal: MobileNet SSD for detection → U²-Net for mask
    const modelPaths: Record<SegmentationType, string> = {
      sky: '/models/sky-segmentation.onnx',
      person: '/models/modnet-person.onnx',
      subject: '/models/u2net-subject.onnx',
      background: '/models/u2net-subject.onnx',    // same model, mask inverted
      foreground: '/models/u2net-subject.onnx',     // alias for subject
      animal: '/models/u2net-subject.onnx',         // after MobileNet SSD bbox crop
    };

    const session = await ort.InferenceSession.create(modelPaths[type], {
      executionProviders: ['wasm'],
    });

    const { tensor, originalWidth, originalHeight } = await prepareInput(imageUrl);

    const feeds: Record<string, unknown> = {
      input: new ort.Tensor('float32', tensor, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]),
    };

    const results = await session.run(feeds as Parameters<typeof session.run>[0]);
    const outputKey = Object.keys(results)[0];
    const outputData = results[outputKey].data as Float32Array;

    const mask = scaleMaskSoft(outputData, MODEL_INPUT_SIZE, originalWidth, originalHeight);

    // Background = inverted subject mask
    if (type === 'background') {
      for (let i = 0; i < mask.length; i++) {
        mask[i] = 255 - mask[i];
      }
    }

    return { mask, width: originalWidth, height: originalHeight, confidence: 0.85 };
  } catch {
    // ONNX not available or model not found — use fallback
    const { originalWidth, originalHeight } = await prepareInput(imageUrl);

    if (type === 'sky') {
      return fallbackSkyMask(imageUrl, originalWidth, originalHeight);
    }

    if (type === 'background') {
      // Invert sky fallback as rough background estimate
      const skyResult = await fallbackSkyMask(imageUrl, originalWidth, originalHeight);
      for (let i = 0; i < skyResult.mask.length; i++) {
        skyResult.mask[i] = 255 - skyResult.mask[i];
      }
      skyResult.confidence = 0.3;
      return skyResult;
    }

    // For person/subject/foreground/animal without ONNX: return empty mask
    return {
      mask: new Uint8Array(originalWidth * originalHeight),
      width: originalWidth,
      height: originalHeight,
      confidence: 0,
    };
  }
}

/**
 * Convert segmentation result to a MaskDefinition-compatible canvas.
 */
export function segmentationToCanvas(result: SegmentationResult): OffscreenCanvas {
  const canvas = new OffscreenCanvas(result.width, result.height);
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(result.width, result.height);

  for (let i = 0; i < result.mask.length; i++) {
    const v = result.mask[i];
    imageData.data[i * 4] = v;
    imageData.data[i * 4 + 1] = v;
    imageData.data[i * 4 + 2] = v;
    imageData.data[i * 4 + 3] = 255;
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
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
