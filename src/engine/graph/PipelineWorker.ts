/// <reference lib="WebWorker" />
/**
 * Dedicated worker that owns the WebGL2 OffscreenCanvas + all GL state.
 * Wraps an in-process `PipelineService` and exposes it over the
 * `workerProtocol` message bus.
 *
 * Lifecycle: one worker per `WorkerPipelineService` instance. The default
 * service singleton allocates a worker on first use and reuses it across
 * all consumers (preset thumbs, library edit-thumbs, exporter).
 *
 * Context-loss recovery: registers a `webglcontextlost` listener; on loss,
 * marks the context dirty and re-creates the PipelineService on the next
 * incoming request. Plans are NOT replayed automatically — callers re-issue
 * compile() if their handle becomes stale (the rebuild advances `epoch`).
 */
import { PipelineService } from './PipelineService';
import type { CompiledPlan } from './types';
import type { Raw16SourceData } from './sources';
import { requireHalfFloatColorBuffer } from '../webglCaps';
import {
  type WorkerRequest,
  type WorkerResponse,
  type WorkerSourcePayload,
  type PlanHandle,
} from './workerProtocol';

// ─── GL context + service lifecycle ────────────────────────────────

interface Ctx {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  svc: PipelineService;
  /** Monotonic — bumped on context loss so stale plan IDs can be detected. */
  epoch: number;
  /** Active plans by ID. */
  plans: Map<string, CompiledPlan>;
  /** Pre-bound source data by ID. ImageBitmaps live until unbindSource. */
  sources: Map<string, ImageBitmap | Raw16SourceData>;
  planCounter: number;
}

let ctx: Ctx | null = null;

let nextEpoch = 0;

function getOrCreateCtx(): Ctx {
  if (ctx) return ctx;
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('PipelineWorker: WebGL2 not available in this worker');
  // A worker owns a separate GL context, so the main-thread capability probe
  // cannot vouch for its RGBA16F attachments.
  requireHalfFloatColorBuffer(gl);

  // Context-loss recovery: drop everything; the next request rebuilds.
  canvas.addEventListener('webglcontextlost', (ev) => {
    ev.preventDefault(); // signal that we want a restore event
    if (ctx) {
      try { ctx.svc.release(); } catch { /* swallow */ }
      for (const s of ctx.sources.values()) {
        if (s instanceof ImageBitmap) {
          try { s.close(); } catch { /* */ }
        }
      }
      ctx = null;
    }
  });

  ctx = {
    canvas,
    gl,
    svc: new PipelineService(gl),
    epoch: ++nextEpoch,
    plans: new Map(),
    sources: new Map(),
    planCounter: 0,
  };
  return ctx;
}

// ─── Source materialisation ───────────────────────────────────────

function materialiseSource(payload: WorkerSourcePayload): ImageBitmap | Raw16SourceData {
  if (payload.kind === 'imageBitmap') return payload.bitmap;
  return {
    pixels: payload.pixels,
    width: payload.width,
    height: payload.height,
    channels: payload.channels,
  };
}

/** Resolve `extraSources` (nodeId -> sourceId) to bound source data. */
function resolveExtraSources(
  c: Ctx,
  extra?: Record<string, string>,
): Map<string, ImageBitmap | Raw16SourceData> | undefined {
  if (!extra) return undefined;
  const out = new Map<string, ImageBitmap | Raw16SourceData>();
  for (const [nodeId, sourceId] of Object.entries(extra)) {
    const data = c.sources.get(sourceId);
    if (!data) throw new Error(`extraSources: unknown sourceId ${sourceId} for node ${nodeId}`);
    out.set(nodeId, data);
  }
  return out;
}

// ─── Request dispatch ─────────────────────────────────────────────

async function handle(req: WorkerRequest): Promise<WorkerResponse> {
  const c = getOrCreateCtx();
  switch (req.op) {
    case 'compile': {
      const plan = await c.svc.compile(req.graph, req.options);
      const planId = `plan-${c.epoch}-${++c.planCounter}`;
      c.plans.set(planId, plan);
      const terminal = plan.perNodeFbo.get(plan.output) ?? [...plan.perNodeFbo.values()].pop();
      const handle: PlanHandle = {
        planId,
        graphRevision: plan.graphRevision,
        terminalGeometry: terminal ? terminal.geometry : null,
      };
      return { id: req.id, ok: true, op: 'compile', result: handle };
    }
    case 'releasePlan': {
      c.plans.delete(req.planId);
      return { id: req.id, ok: true, op: 'releasePlan', result: null };
    }
    case 'bindSource': {
      // Replace any prior binding under this id (caller is responsible
      // for not orphaning ImageBitmaps; the old binding is closed below).
      const prior = c.sources.get(req.sourceId);
      if (prior && prior instanceof ImageBitmap) {
        try { prior.close(); } catch { /* */ }
      }
      c.sources.set(req.sourceId, materialiseSource(req.payload));
      return { id: req.id, ok: true, op: 'bindSource', result: null };
    }
    case 'unbindSource': {
      const prior = c.sources.get(req.sourceId);
      if (prior && prior instanceof ImageBitmap) {
        try { prior.close(); } catch { /* */ }
      }
      c.sources.delete(req.sourceId);
      return { id: req.id, ok: true, op: 'unbindSource', result: null };
    }
    case 'renderToBlob': {
      const plan = c.plans.get(req.planId);
      const source = c.sources.get(req.sourceId);
      if (!plan) throw new Error(`renderToBlob: unknown planId ${req.planId}`);
      if (!source) throw new Error(`renderToBlob: unknown sourceId ${req.sourceId}`);
      const paramsMap = req.paramsByNode ? new Map(Object.entries(req.paramsByNode)) : undefined;
      const blob = await c.svc.renderToBlob(plan, source, paramsMap, {
        type: req.encodeType,
        quality: req.encodeQuality,
        maxDim: req.encodeMaxDim,
      }, resolveExtraSources(c, req.extraSources));
      return { id: req.id, ok: true, op: 'renderToBlob', result: blob };
    }
    case 'renderToPixels': {
      const plan = c.plans.get(req.planId);
      const source = c.sources.get(req.sourceId);
      if (!plan) throw new Error(`renderToPixels: unknown planId ${req.planId}`);
      if (!source) throw new Error(`renderToPixels: unknown sourceId ${req.sourceId}`);
      const paramsMap = req.paramsByNode ? new Map(Object.entries(req.paramsByNode)) : undefined;
      const result = await c.svc.renderToPixels(plan, source, paramsMap, resolveExtraSources(c, req.extraSources));
      return { id: req.id, ok: true, op: 'renderToPixels', result };
    }
    case 'renderToPixels16': {
      const plan = c.plans.get(req.planId);
      const source = c.sources.get(req.sourceId);
      if (!plan) throw new Error(`renderToPixels16: unknown planId ${req.planId}`);
      if (!source) throw new Error(`renderToPixels16: unknown sourceId ${req.sourceId}`);
      const paramsMap = req.paramsByNode ? new Map(Object.entries(req.paramsByNode)) : undefined;
      const result = await c.svc.renderToPixels16(
        plan, source, paramsMap, resolveExtraSources(c, req.extraSources));
      return { id: req.id, ok: true, op: 'renderToPixels16', result };
    }
    case 'renderToImageBitmap': {
      const plan = c.plans.get(req.planId);
      const source = c.sources.get(req.sourceId);
      if (!plan) throw new Error(`renderToImageBitmap: unknown planId ${req.planId}`);
      if (!source) throw new Error(`renderToImageBitmap: unknown sourceId ${req.sourceId}`);
      const paramsMap = req.paramsByNode ? new Map(Object.entries(req.paramsByNode)) : undefined;
      // GPU-side blit + transferToImageBitmap — no readPixels stall, no
      // CPU frame copies. ImageBitmap is transferable, so the postMessage
      // hop stays cheap.
      const result = await c.svc.renderToImageBitmap(
        plan, source, paramsMap, resolveExtraSources(c, req.extraSources));
      return { id: req.id, ok: true, op: 'renderToImageBitmap', result };
    }
    case 'clearPlanCache': {
      c.svc.clearPlanCache();
      c.plans.clear();
      return { id: req.id, ok: true, op: 'clearPlanCache', result: null };
    }
    case 'release': {
      try { c.svc.release(); } catch { /* */ }
      for (const s of c.sources.values()) {
        if (s instanceof ImageBitmap) { try { s.close(); } catch { /* */ } }
      }
      ctx = null;
      return { id: req.id, ok: true, op: 'release', result: null };
    }
  }
}

self.addEventListener('message', async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    const resp = await handle(req);
    // Transfer the pixel buffer / bitmap back to main thread when possible.
    // Blobs from renderToBlob are clone-only (no transfer slot).
    const transfer: Transferable[] = [];
    if (resp.ok && (resp.op === 'renderToPixels' || resp.op === 'renderToPixels16')) {
      transfer.push(resp.result.pixels.buffer);
    } else if (resp.ok && resp.op === 'renderToImageBitmap') {
      transfer.push(resp.result.bitmap);
    }
    (self as unknown as Worker).postMessage(resp, transfer);
  } catch (e) {
    const err: WorkerResponse = {
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as Worker).postMessage(err);
  }
});
