/**
 * Shared types between the main thread and the denoise worker.
 *
 * The worker receives Float32 RGBA pixel data (linear, [0,1]) plus model
 * metadata; it emits progress + a final Float32 RGBA result. Buffers are
 * transferred (not cloned) on both directions to keep the 100+ MB tile
 * traffic out of the structured-clone hot path.
 */
import type { DenoiseModelDescriptor } from './modelStore';

export interface DenoiseWorkerRequest {
  /** Float32 RGBA, row-major, linear [0,1] range. Transferred. */
  pixels: Float32Array;
  width: number;
  height: number;
  /** ArrayBuffer with the ONNX model. Transferred. */
  modelBytes: ArrayBuffer;
  descriptor: DenoiseModelDescriptor;
  /** Overlap between tiles in pixels. Defaults to 32. */
  overlap?: number;
}

export type DenoiseWorkerMessage =
  | { type: 'progress'; tilesDone: number; tilesTotal: number }
  | { type: 'result'; pixels: Float32Array; width: number; height: number }
  | { type: 'error'; message: string };
