/**
 * Main-thread facade for the `PipelineWorker`. Same shape as the in-process
 * `PipelineService`, but every GL operation runs off-thread.
 *
 * API differences from in-process `PipelineService`:
 *   - `compile()` returns an opaque `PlanHandle` (planId + metadata) instead
 *     of the full `CompiledPlan`. Consumers treat the handle as a token.
 *   - Source data must be uploaded via `bindSource(sourceId, source)` before
 *     `renderTo*`. Sources are kept worker-side until `unbindSource(id)` so
 *     a single bitmap can back many preset renders without re-transferring.
 *   - All methods are async (already were on the in-process service).
 *
 * Use `getDefaultPipelineService()` for the shared production instance.
 */
import type { CompileOptions } from './GraphCompiler';
import type { RenderGraph } from './types';
import type { Raw16SourceData } from './sources';
import {
  type PlanHandle,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerSourcePayload,
  sourceTransferables,
} from './workerProtocol';

export type WorkerRenderSource = ImageBitmap | Raw16SourceData;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/** Body of a worker request (everything except the call id). */
type RequestBody = Omit<WorkerRequest, 'id'>;

export class WorkerPipelineService {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private released = false;

  constructor(worker?: Worker) {
    this.worker = worker ?? new Worker(
      new URL('./PipelineWorker.ts', import.meta.url),
      { type: 'module' },
    );
    this.worker.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    this.worker.addEventListener('error', (ev) => {
      // Surface the worker error to every in-flight caller so they don't
      // hang forever. Subsequent calls will spawn replacement work but the
      // worker itself stays alive until release().
      const err = new Error(`PipelineWorker error: ${ev.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  // ─── Plan lifecycle ───────────────────────────────────────────

  async compile(graph: RenderGraph, options?: CompileOptions): Promise<PlanHandle> {
    const body = { op: 'compile', graph, options } as RequestBody;
    return this.call<PlanHandle>(body);
  }

  async releasePlan(plan: PlanHandle): Promise<void> {
    const body = { op: 'releasePlan', planId: plan.planId } as RequestBody;
    await this.call<null>(body);
  }

  async clearPlanCache(): Promise<void> {
    const body = { op: 'clearPlanCache' } as RequestBody;
    await this.call<null>(body);
  }

  // ─── Source binding ───────────────────────────────────────────

  /**
   * Upload (transfer) source data to the worker under `sourceId`. The
   * source stays alive until `unbindSource(sourceId)`. Re-binding with the
   * same id replaces the prior binding and closes any prior ImageBitmap.
   */
  async bindSource(sourceId: string, source: WorkerRenderSource): Promise<void> {
    const payload = toPayload(source);
    const transfer = sourceTransferables(payload);
    const body = { op: 'bindSource', sourceId, payload } as RequestBody;
    await this.call<null>(body, transfer);
  }

  async unbindSource(sourceId: string): Promise<void> {
    const body = { op: 'unbindSource', sourceId } as RequestBody;
    await this.call<null>(body);
  }

  // ─── Render ───────────────────────────────────────────────────

  async renderToBlob(
    plan: PlanHandle,
    sourceId: string,
    paramsByNode?: Map<string, unknown>,
    options: { type?: string; quality?: number; maxDim?: number } = {},
    extraSources?: Record<string, string>,
  ): Promise<Blob> {
    const body = {
      op: 'renderToBlob',
      planId: plan.planId,
      sourceId,
      extraSources,
      encodeMaxDim: options.maxDim,
      paramsByNode: paramsByNode ? Object.fromEntries(paramsByNode) : undefined,
      encodeType: options.type,
      encodeQuality: options.quality,
    } as RequestBody;
    return this.call<Blob>(body);
  }

  async renderToPixels(
    plan: PlanHandle,
    sourceId: string,
    paramsByNode?: Map<string, unknown>,
    extraSources?: Record<string, string>,
  ): Promise<{ width: number; height: number; pixels: Uint8Array }> {
    const body = {
      op: 'renderToPixels',
      planId: plan.planId,
      sourceId,
      extraSources,
      paramsByNode: paramsByNode ? Object.fromEntries(paramsByNode) : undefined,
    } as RequestBody;
    return this.call<{ width: number; height: number; pixels: Uint8Array }>(body);
  }

  async renderToPixels16(
    plan: PlanHandle,
    sourceId: string,
    paramsByNode?: Map<string, unknown>,
    extraSources?: Record<string, string>,
  ): Promise<{ width: number; height: number; pixels: Uint16Array }> {
    const body = {
      op: 'renderToPixels16',
      planId: plan.planId,
      sourceId,
      extraSources,
      paramsByNode: paramsByNode ? Object.fromEntries(paramsByNode) : undefined,
    } as RequestBody;
    return this.call<{ width: number; height: number; pixels: Uint16Array }>(body);
  }

  /**
   * Render and return a directly-drawable ImageBitmap. Faster than
   * renderToBlob for the editor live-display flow — no JPEG/PNG encode,
   * the bitmap is transferred (not copied) from worker to main thread.
   */
  async renderToImageBitmap(
    plan: PlanHandle,
    sourceId: string,
    paramsByNode?: Map<string, unknown>,
    extraSources?: Record<string, string>,
  ): Promise<{ width: number; height: number; bitmap: ImageBitmap }> {
    const body = {
      op: 'renderToImageBitmap',
      planId: plan.planId,
      sourceId,
      extraSources,
      paramsByNode: paramsByNode ? Object.fromEntries(paramsByNode) : undefined,
    } as RequestBody;
    return this.call<{ width: number; height: number; bitmap: ImageBitmap }>(body);
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const body = { op: 'release' } as RequestBody;
    try { await this.call<null>(body); } catch { /* worker may already be dead */ }
    this.worker.terminate();
  }

  // ─── Internals ────────────────────────────────────────────────

  private call<T>(payload: Omit<WorkerRequest, 'id'>, transfer?: Transferable[]): Promise<T> {
    if (this.released) {
      return Promise.reject(new Error('WorkerPipelineService: already released'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const message = { id, ...payload } as WorkerRequest;
      this.worker.postMessage(message, transfer ?? []);
    });
  }
}

function toPayload(source: WorkerRenderSource): WorkerSourcePayload {
  if (source instanceof ImageBitmap) {
    return { kind: 'imageBitmap', bitmap: source };
  }
  return {
    kind: 'raw16',
    pixels: source.pixels,
    width: source.width,
    height: source.height,
    channels: source.channels,
  };
}
