/**
 * Wire protocol between the main-thread `WorkerPipelineService` facade and
 * the `PipelineWorker` that owns the WebGL2 context.
 *
 * Design:
 *   - The worker owns the GL context + plan cache. Main-thread holds opaque
 *     `PlanHandle` tokens (planId + minimal metadata).
 *   - Source data (ImageBitmap / Uint16Array) is uploaded once via
 *     `bindSource` (transfer-friendly) and re-used across multiple renders
 *     by sourceId. This matches `PipelineExecutor.bindExternalData()`'s
 *     model and avoids per-render clone traffic.
 *   - Every request carries a monotonically-increasing `id`; responses
 *     echo it so the client can demultiplex concurrent calls.
 */
import type { Geometry, RenderGraph } from './types';
import type { CompileOptions } from './GraphCompiler';

// ─── Source data shapes (worker side) ─────────────────────────────

export type WorkerSourcePayload =
  | { kind: 'imageBitmap'; bitmap: ImageBitmap }
  | {
      kind: 'raw16';
      pixels: Uint16Array;
      width: number;
      height: number;
      channels: 3 | 4;
    };

// ─── Requests (main → worker) ─────────────────────────────────────

export type WorkerRequest =
  | {
      id: number;
      op: 'compile';
      /** RenderGraph is structured-clone-safe (Map of plain objects). */
      graph: RenderGraph;
      options?: CompileOptions;
    }
  | {
      id: number;
      op: 'releasePlan';
      planId: string;
    }
  | {
      id: number;
      op: 'bindSource';
      sourceId: string;
      payload: WorkerSourcePayload;
    }
  | {
      id: number;
      op: 'unbindSource';
      sourceId: string;
    }
  | {
      id: number;
      op: 'renderToBlob';
      planId: string;
      sourceId: string;
      /** Additional source bindings by NODE id (e.g. mask sources):
       *  nodeId -> previously-bound sourceId. */
      extraSources?: Record<string, string>;
      /** Map serialized as plain object — worker rebuilds the Map. */
      paramsByNode?: Record<string, unknown>;
      encodeType?: string;
      encodeQuality?: number;
      encodeMaxDim?: number;
    }
  | {
      id: number;
      op: 'renderToPixels';
      planId: string;
      sourceId: string;
      /** Additional source bindings by NODE id (e.g. mask sources):
       *  nodeId -> previously-bound sourceId. */
      extraSources?: Record<string, string>;
      paramsByNode?: Record<string, unknown>;
    }
  | {
      id: number;
      op: 'renderToPixels16';
      planId: string;
      sourceId: string;
      extraSources?: Record<string, string>;
      paramsByNode?: Record<string, unknown>;
    }
  | {
      id: number;
      op: 'renderToImageBitmap';
      planId: string;
      sourceId: string;
      /** Additional source bindings by NODE id (e.g. mask sources):
       *  nodeId -> previously-bound sourceId. */
      extraSources?: Record<string, string>;
      paramsByNode?: Record<string, unknown>;
    }
  | {
      id: number;
      op: 'clearPlanCache';
    }
  | {
      id: number;
      op: 'release';
    };

// ─── Responses (worker → main) ────────────────────────────────────

/**
 * Lightweight handle the main thread holds in lieu of the in-worker
 * CompiledPlan. The worker dereferences `planId` back to the live plan.
 */
export interface PlanHandle {
  planId: string;
  /** Snapshot of graph.metadata.revision at compile time — matches CompiledPlan.graphRevision. */
  graphRevision: number;
  /** Terminal-node FBO geometry — useful for consumers that need to know
   *  the output dimensions before they `renderTo*`. */
  terminalGeometry: Geometry | null;
}

export type WorkerResponse =
  | { id: number; ok: true; op: 'compile';         result: PlanHandle }
  | { id: number; ok: true; op: 'releasePlan';     result: null }
  | { id: number; ok: true; op: 'bindSource';      result: null }
  | { id: number; ok: true; op: 'unbindSource';    result: null }
  | { id: number; ok: true; op: 'renderToBlob';    result: Blob }
  | {
      id: number;
      ok: true;
      op: 'renderToPixels';
      result: { width: number; height: number; pixels: Uint8Array };
    }
  | {
      id: number;
      ok: true;
      op: 'renderToPixels16';
      result: { width: number; height: number; pixels: Uint16Array };
    }
  | { id: number; ok: true; op: 'renderToImageBitmap'; result: { width: number; height: number; bitmap: ImageBitmap } }
  | { id: number; ok: true; op: 'clearPlanCache';  result: null }
  | { id: number; ok: true; op: 'release';         result: null }
  | { id: number; ok: false; error: string };

// ─── Helpers ──────────────────────────────────────────────────────

/** Determine which buffers (if any) should be transferred for a source. */
export function sourceTransferables(payload: WorkerSourcePayload): Transferable[] {
  if (payload.kind === 'imageBitmap') return [payload.bitmap];
  // Uint16Array's underlying buffer is transferable; the SharedArrayBuffer
  // path is currently unused. ArrayBufferView views back the same buffer.
  if (payload.pixels.buffer instanceof ArrayBuffer) return [payload.pixels.buffer];
  return [];
}
