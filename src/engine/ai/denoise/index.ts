/**
 * Public AI-denoise API. Used by the editor to compute a clean preview
 * variant on demand. Heavy work runs in a Web Worker.
 */
import { DENOISE_MODELS, loadDenoiseModel, type DenoiseModelDescriptor, type ModelFetchProgress } from './modelStore';
import type { DenoiseWorkerRequest, DenoiseWorkerMessage } from './denoiseProtocol';

export type DenoiseModelId = keyof typeof DENOISE_MODELS;

export interface AIDenoiseOptions {
  modelId: DenoiseModelId;
  pixels: Float32Array;        // RGBA, linear [0,1], row-major
  width: number;
  height: number;
  /** Called with [0..1] progress for model download (then tiles). */
  onProgress?: (stage: 'model-download' | 'inference', fraction: number) => void;
  /** Abort handle — terminates the worker if signalled. */
  signal?: AbortSignal;
}

export interface AIDenoiseResult {
  pixels: Float32Array;        // RGBA, linear [0,1], same dims as input
  width: number;
  height: number;
}

/**
 * Run AI denoise end-to-end: pull (or use cached) model bytes, spin up
 * the worker, blend tiles, return the cleaned image. Caller decides how
 * to mix it back with the original (see DENOISE_PLAN §3.1).
 */
export async function runAIDenoise(opts: AIDenoiseOptions): Promise<AIDenoiseResult> {
  const descriptor = DENOISE_MODELS[opts.modelId];
  if (!descriptor) throw new Error(`Unknown denoise model: ${opts.modelId}`);

  // 1. Get model bytes
  const modelBytes = await loadDenoiseModel(descriptor, (p: ModelFetchProgress) => {
    if (p.source === 'opfs' || p.source === 'memory') {
      opts.onProgress?.('model-download', 1);
    } else {
      opts.onProgress?.('model-download', p.total > 0 ? p.loaded / p.total : 0);
    }
  });

  if (opts.signal?.aborted) throw new DOMException('Denoise aborted', 'AbortError');

  // 2. Spawn worker. Vite handles `?worker` import natively.
  const worker = await spawnWorker();

  const abortHandler = () => worker.terminate();
  opts.signal?.addEventListener('abort', abortHandler);

  try {
    const result = await new Promise<AIDenoiseResult>((resolve, reject) => {
      worker.addEventListener('message', (ev: MessageEvent<DenoiseWorkerMessage>) => {
        const m = ev.data;
        if (m.type === 'progress') {
          opts.onProgress?.('inference', m.tilesDone / m.tilesTotal);
        } else if (m.type === 'result') {
          resolve({ pixels: m.pixels, width: m.width, height: m.height });
        } else if (m.type === 'error') {
          reject(new Error(m.message));
        }
      });
      worker.addEventListener('error', (e) => reject(new Error(e.message)));

      const req: DenoiseWorkerRequest = {
        pixels: opts.pixels,
        width: opts.width,
        height: opts.height,
        modelBytes,
        descriptor,
        overlap: 32,
      };
      // Transfer only the pixel buffer (single-use, we just decoded it).
      // The model bytes are structured-cloned, NOT transferred — they live
      // in the modelStore's in-memory cache for reuse across runs, and
      // transferring would detach the cached ArrayBuffer.
      worker.postMessage(req, [opts.pixels.buffer]);
    });
    return result;
  } finally {
    opts.signal?.removeEventListener('abort', abortHandler);
    worker.terminate();
  }
}

async function spawnWorker(): Promise<Worker> {
  // Vite-native module-worker import. The `new URL(...)` form is the
  // only one Vite picks up for bundling.
  return new Worker(new URL('./denoise.worker.ts', import.meta.url), { type: 'module' });
}

export { DENOISE_MODELS } from './modelStore';
export type { DenoiseModelDescriptor };
