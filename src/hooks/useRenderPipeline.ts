/**
 * useRenderPipeline — async, worker-backed editor render hook.
 *
 * Phase 1.B/D3 migration: this hook now talks exclusively to the shared
 * `WorkerPipelineService`. All renders run off-thread; the main thread
 * only ferries source data + adjustment params + receives back a
 * directly-drawable `ImageBitmap`.
 *
 * API differences vs the pre-migration hook:
 *   - `render` / `renderDocUpTo` / `renderDoc` return `Promise<ImageBitmap | null>`.
 *   - `setImage` / `setImageRaw` are async and own the worker-side source binding.
 *   - Consumers (useWebGLRenderer) coalesce per-frame render requests.
 *
 * One intentional gap tracked as a decision point:
 *   1. **CleanPreview / AI-denoise mix** is unsupported until the
 *      AIDenoiseMix pass is ported to a graph-layer kind. The API reports
 *      that honestly: `hasCleanPreview()` returns false and the setters are
 *      no-ops, so AIDenoisePanel can show a "not available" state instead
 *      of claiming an active preview that render() ignores.
 */
import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import type { Adjustments } from '../types';
import type { PhotoDocument } from '../engine/DocumentModel';
import { documentToAdjustments } from '../engine/DocumentModel';
import { isFullCropRect } from '../engine/Crop';
import { renderMaskToCanvas } from '../engine/Mask';
import { editorIsSupported } from '../engine/webglCaps';
import { getOutputColorSpace } from '../engine/outputColorSpaces';
import type { LensCoefficients } from '../engine/lensProfile';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';
import { perfLog } from '../platform/perfLog';
import {
  getDefaultPipelineService,
  buildDefaultGraph,
  buildLayeredGraph,
  adjustmentsToBuilderAdjustments,
  paramsByNodeFromAdjustments,
  layeredParamsByNode,
  graphSpaceSignature,
  buildDocumentGraph,
  isGraphLed,
  builderBaseForDocument,
  builderLayersForDocument,
  maskLayersForDocument,
  subgraphBefore,
  type PlanHandle,
  type BuilderSourceSpec,
  type BuilderLayer,
  type Raw16SourceData,
  type BuilderAdjustments,
  type HslDetailViewSelected,
} from '../engine/graph';

const SOURCE_ID = 'editor-source';

/**
 * Transient per-render editor state that is not part of the persisted
 * Adjustments: the HSL "view selected range" visualization.
 */
export interface RenderOverlay {
  viewSelected?: HslDetailViewSelected;
}

function applyOverlay(builderAdj: BuilderAdjustments, overlay?: RenderOverlay): BuilderAdjustments {
  if (!overlay?.viewSelected) return builderAdj;
  return {
    ...builderAdj,
    hslViewSelected: overlay.viewSelected,
  };
}

interface PipelineState {
  plan: PlanHandle | null;
  builderSource: BuilderSourceSpec | null;
  /** Space signature the current plan was compiled with (Phase-3 toggles).
   *  Convert-node placement is structural, so a signature change forces a
   *  recompile — params alone cannot move nodes between spaces. */
  planSpaceSig: string;
}

const EMPTY_SPACE_SIG = graphSpaceSignature({});

export function useRenderPipeline() {
  const stateRef = useRef<PipelineState>({ plan: null, builderSource: null, planSpaceSig: EMPTY_SPACE_SIG });
  /** Yjs-style generation counter — bumped on every source switch.
   *  Lets callers detect stale in-flight renders after a setImage. */
  const generationRef = useRef(0);
  /** Per-document layered plan cache. Keyed by graphId so multi-layer
   *  documents skip recompile on slider drags. */
  const layeredPlanRef = useRef<Map<string, PlanHandle>>(new Map());
  /** Layer info that was used for the current layered plan, kept so
   *  renderDoc can rebuild paramsByNode from the live document. */
  const layeredLayersRef = useRef<BuilderLayer[]>([]);
  /** layerId -> signature of the mask bitmap currently bound worker-side.
   *  Rebind only when the mask definition or geometry changes. */
  const maskSignaturesRef = useRef<Map<string, string>>(new Map());
  /** Truncated document plans for renderDocUpTo, keyed by graph id + revision.
   *  At most a couple per source (per stop pass × space signature). */
  const upToPlanRef = useRef<Map<string, PlanHandle>>(new Map());

  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const serviceRef = useRef<ReturnType<typeof getDefaultPipelineService> | null>(null);
  // GPU capability, decided once per session: can the worker render the
  // 16-bit HDR chain? Deliberately NOT "is a raw16 source bound" — callers
  // gate setImageRaw on this, so a source-state flag would deadlock the
  // 16-bit path (the flag would only flip after the call it gates).
  const hdrCapable = useMemo(() => editorIsSupported(), []);

  const retryInitialization = useCallback(() => {
    setReady(false);
    setError(false);
    try {
      serviceRef.current = getDefaultPipelineService();
      setReady(true);
    } catch {
      serviceRef.current = null;
      setError(true);
    }
  }, []);

  useEffect(() => {
    const layeredPlans = layeredPlanRef.current;
    const maskSignatures = maskSignaturesRef.current;
    const upToPlans = upToPlanRef.current;
    retryInitialization();
    return () => {
      // Don't release the shared worker on unmount — other hooks use it.
      // The worker lives for the session; sources/plans get unbound below.
      const svc = serviceRef.current;
      if (!svc) return;
      void svc.unbindSource(SOURCE_ID);
      for (const handle of layeredPlans.values()) void svc.releasePlan(handle);
      layeredPlans.clear();
      for (const layerId of maskSignatures.keys()) {
        void svc.unbindSource(`editor-mask-${layerId}`);
      }
      maskSignatures.clear();
      for (const handle of upToPlans.values()) void svc.releasePlan(handle);
      upToPlans.clear();
      if (stateRef.current.plan) void svc.releasePlan(stateRef.current.plan);
      stateRef.current = { plan: null, builderSource: null, planSpaceSig: EMPTY_SPACE_SIG };
    };
  }, [retryInitialization]);

  // ─── Source binding ──────────────────────────────────────────────

  const setImage = useCallback(async (source: string | Blob): Promise<{ w: number; h: number }> => {
    const svc = getDefaultPipelineService();
    // Claim the generation up-front: any older in-flight setImage/setImageRaw
    // becomes stale and must not bind its (now outdated) source over ours.
    const myGen = ++generationRef.current;
    let blob: Blob = source instanceof Blob ? source : await fetch(source).then(r => r.blob());
    if (blob instanceof File) {
      const readStart = performance.now();
      const buf = await blob.arrayBuffer();
      const readTime = Math.round(performance.now() - readStart);
      const throughput = Math.round(buf.byteLength / 1024 / (readTime / 1000));
      blob = new Blob([buf], { type: blob.type || 'image/jpeg' });
      perfLog.mark('image-load', `file materialized (${Math.round(blob.size / 1024)}KB in ${readTime}ms = ${throughput}KB/s)`);
    } else {
      perfLog.mark('image-load', `blob ready (${Math.round(blob.size / 1024)}KB)`);
    }

    const bitmap = await createImageBitmap(blob);
    perfLog.mark('image-load', `decoded ${bitmap.width}x${bitmap.height}`);
    const nativeDims = { w: bitmap.width, h: bitmap.height };

    const MAX_DISPLAY = 4096;
    let gpuBitmap = bitmap;
    if (Math.max(bitmap.width, bitmap.height) > MAX_DISPLAY) {
      const scale = MAX_DISPLAY / Math.max(bitmap.width, bitmap.height);
      gpuBitmap = await createImageBitmap(bitmap, {
        resizeWidth: Math.round(bitmap.width * scale),
        resizeHeight: Math.round(bitmap.height * scale),
        resizeQuality: 'medium',
      });
      bitmap.close();
      perfLog.mark('image-load', `downscaled to ${gpuBitmap.width}x${gpuBitmap.height}`);
    }

    const builderSource: BuilderSourceSpec = {
      kind: 'imageBitmap',
      geometry: { width: gpuBitmap.width, height: gpuBitmap.height, pixelRatio: 1 },
      outputColorSpaceId: getOutputColorSpace(),
    };
    const { graph } = buildDefaultGraph({}, builderSource);
    const newPlan = await svc.compile(graph);

    // A newer setImage/setImageRaw started while we decoded/compiled:
    // last-to-START wins, not last-to-finish. Don't bind the stale source.
    if (generationRef.current !== myGen) {
      gpuBitmap.close();
      void svc.releasePlan(newPlan);
      return nativeDims;
    }

    // Drop prior plan + binding; bind the new bitmap (transferred to worker).
    if (stateRef.current.plan) {
      void svc.releasePlan(stateRef.current.plan);
    }
    await svc.bindSource(SOURCE_ID, gpuBitmap);
    stateRef.current = { plan: newPlan, builderSource, planSpaceSig: EMPTY_SPACE_SIG };
    // Layered plan cache + mask bindings are per-source — drop on switch.
    for (const handle of layeredPlanRef.current.values()) void svc.releasePlan(handle);
    layeredPlanRef.current.clear();
    layeredLayersRef.current = [];
    for (const layerId of maskSignaturesRef.current.keys()) {
      void svc.unbindSource(`editor-mask-${layerId}`);
    }
    maskSignaturesRef.current.clear();
    for (const handle of upToPlanRef.current.values()) void svc.releasePlan(handle);
    upToPlanRef.current.clear();

    perfLog.mark('image-load', 'uploaded to GPU');
    return nativeDims;
  }, []);

  const setImageRaw = useCallback(async (
    raw: RawPixelData,
    /** The photo's camera base development, or null when it has none. */
    baseAdjustments: BuilderAdjustments | null,
    /** The photo's lens correction, or null when the lens is unknown. */
    lensProfile: LensCoefficients | null,
  ): Promise<{ w: number; h: number }> => {
    if (raw.bits !== 16 || !(raw.data instanceof Uint16Array)) {
      throw new Error('setImageRaw expects 16-bit Uint16Array data');
    }
    const svc = getDefaultPipelineService();
    const myGen = ++generationRef.current;
    const builderSource: BuilderSourceSpec = {
      kind: 'raw16',
      geometry: { width: raw.width, height: raw.height, pixelRatio: 1 },
      channels: raw.channels,
      calibration: {
        asShotNeutral: raw.asShotNeutral ?? null,
        colorMatrix: raw.colorMatrix ?? null,
      },
      baseAdjustments,
      lensProfile,
      outputColorSpaceId: getOutputColorSpace(),
    };
    const { graph } = buildDefaultGraph({}, builderSource);
    const newPlan = await svc.compile(graph);

    if (generationRef.current !== myGen) {
      void svc.releasePlan(newPlan);
      return { w: raw.width, h: raw.height };
    }

    // Clone the buffer — bindSource transfers it, but the editor may keep
    // a reference for re-binding or re-export. Only the call that goes on to
    // bind pays for the copy; a superseded one would copy up to 144 MB and
    // then throw it away.
    const raw16: Raw16SourceData = {
      pixels: new Uint16Array(raw.data),
      width: raw.width,
      height: raw.height,
      channels: raw.channels,
    };

    if (stateRef.current.plan) {
      void svc.releasePlan(stateRef.current.plan);
    }
    await svc.bindSource(SOURCE_ID, raw16);
    stateRef.current = { plan: newPlan, builderSource, planSpaceSig: EMPTY_SPACE_SIG };
    for (const handle of layeredPlanRef.current.values()) void svc.releasePlan(handle);
    layeredPlanRef.current.clear();
    layeredLayersRef.current = [];
    for (const layerId of maskSignaturesRef.current.keys()) {
      void svc.unbindSource(`editor-mask-${layerId}`);
    }
    maskSignaturesRef.current.clear();
    for (const handle of upToPlanRef.current.values()) void svc.releasePlan(handle);
    upToPlanRef.current.clear();

    perfLog.mark('image-load', `16-bit ${raw.width}x${raw.height} uploaded to worker`);
    return { w: raw.width, h: raw.height };
  }, []);

  // ─── Render ──────────────────────────────────────────────────────

  const render = useCallback(async (
    adj: Adjustments,
    overlay?: RenderOverlay,
  ): Promise<ImageBitmap | null> => {
    const { builderSource } = stateRef.current;
    if (!stateRef.current.plan || !builderSource) return null;
    const svc = getDefaultPipelineService();
    try {
      const builderAdj = applyOverlay(adjustmentsToBuilderAdjustments(adj), overlay);
      // Phase-3 space toggles change convert-node PLACEMENT, which is decided
      // at compile time — recompile when the signature differs from the plan.
      const spaceSig = graphSpaceSignature(builderAdj);
      if (spaceSig !== stateRef.current.planSpaceSig) {
        const { graph } = buildDefaultGraph(builderAdj, builderSource);
        const newPlan = await svc.compile(graph);
        if (stateRef.current.plan) void svc.releasePlan(stateRef.current.plan);
        stateRef.current = { ...stateRef.current, plan: newPlan, planSpaceSig: spaceSig };
      }
      const params = paramsByNodeFromAdjustments(builderAdj, builderSource);
      const { bitmap } = await svc.renderToImageBitmap(stateRef.current.plan!, SOURCE_ID, params);
      return bitmap;
    } catch (e) {
      console.warn('[useRenderPipeline] render failed:', e);
      return null;
    }
  }, []);

  const bindDocMasks = useCallback(async (
    maskLayers: ReturnType<typeof maskLayersForDocument>,
    builderSource: BuilderSourceSpec,
  ): Promise<Record<string, string>> => {
    const svc = getDefaultPipelineService();
    const extraSources: Record<string, string> = {};
    const activeMaskIds = new Set<string>();
    for (const { layerId, mask, nodeId } of maskLayers) {
      activeMaskIds.add(layerId);
      const geom = builderSource.geometry;
      const maskSourceId = `editor-mask-${layerId}`;
      const sig = `${geom.width}x${geom.height}:${JSON.stringify(mask)}`;
      if (maskSignaturesRef.current.get(layerId) !== sig) {
        const maskCanvas = renderMaskToCanvas(mask, geom.width, geom.height);
        const maskBitmap = await createImageBitmap(maskCanvas);
        await svc.bindSource(maskSourceId, maskBitmap);
        maskSignaturesRef.current.set(layerId, sig);
      }
      extraSources[nodeId] = maskSourceId;
    }
    for (const layerId of [...maskSignaturesRef.current.keys()]) {
      if (!activeMaskIds.has(layerId)) {
        void svc.unbindSource(`editor-mask-${layerId}`);
        maskSignaturesRef.current.delete(layerId);
      }
    }
    return extraSources;
  }, []);

  /** Render a document up to (but not including) an exact graph node. */
  const renderDocUpTo = useCallback(async (
    doc: PhotoDocument,
    stopNodeId: string,
    overlay?: RenderOverlay,
  ): Promise<ImageBitmap | null> => {
    const { builderSource } = stateRef.current;
    if (!builderSource) return null;
    const svc = getDefaultPipelineService();
    try {
      const baseAdj = applyOverlay(builderBaseForDocument(doc), overlay);
      const spec = buildDocumentGraph(doc, builderSource, baseAdj);
      const sub = subgraphBefore(spec.graph, stopNodeId, { appendLinToGamma: true });
      // A missing stop is an invalid tap, not permission to render the full
      // document and silently feed post-curve pixels to the histogram.
      if (!sub) return null;
      const cacheKey = `${sub.id}:${sub.metadata.revision}`;
      let plan = upToPlanRef.current.get(cacheKey);
      if (!plan) {
        plan = await svc.compile(sub);
        for (const [key, handle] of upToPlanRef.current) {
          if (key !== cacheKey) void svc.releasePlan(handle);
        }
        upToPlanRef.current.clear();
        upToPlanRef.current.set(cacheKey, plan);
      }
      const docSources = await bindDocMasks(spec.maskLayers, builderSource);
      const extraSources = Object.fromEntries(
        Object.entries(docSources).filter(([nodeId]) => sub.nodes.has(nodeId)),
      );
      const { bitmap } = await svc.renderToImageBitmap(
        plan,
        SOURCE_ID,
        spec.params.size > 0 ? spec.params : undefined,
        Object.keys(extraSources).length > 0 ? extraSources : undefined,
      );
      return bitmap;
    } catch (e) {
      console.warn('[useRenderPipeline] renderDocUpTo failed:', e);
      return null;
    }
  }, [bindDocMasks]);

  const renderDoc = useCallback(async (
    doc: PhotoDocument,
    overlay?: RenderOverlay,
  ): Promise<ImageBitmap | null> => {
    const { builderSource } = stateRef.current;
    if (!builderSource) return null;
    const svc = getDefaultPipelineService();
    try {
      const baseAdj = applyOverlay(builderBaseForDocument(doc), overlay);
      // What this document renders as — the one place that decides between
      // the stored graph, the layered graph and the single chain. The
      // exporter and the thumbnails ask the same function; they used to each
      // keep their own copy, and the exporter's copy was missing entirely.
      const graphLed = isGraphLed(doc);
      const layers = graphLed ? [] : builderLayersForDocument(doc);
      // Retouch spots are a document field, and `buildDocumentGraph` is the
      // only thing that knows where their node goes. The two shortcuts below
      // build their graph from the adjustments alone, so a retouched photo
      // takes the document path even without layers - otherwise the canvas is
      // the one surface that does not show what the export and the thumbnail
      // do (F009).
      const retouched = !graphLed && (doc.retouch?.length ?? 0) > 0;
      const cropped = !graphLed && !isFullCropRect(doc.transform.crop);

      // Neither a graph nor layers nor retouch/crop → standard single-chain render.
      if (!graphLed && layers.length === 0 && !retouched && !cropped) {
        return render(documentToAdjustments(doc), overlay);
      }

      // Rasterize + bind layer masks (worker keeps them across renders);
      // drop bindings whose layer disappeared or lost its mask.
      const spec = graphLed || retouched || cropped ? buildDocumentGraph(doc, builderSource, baseAdj) : null;
      const extraSources = await bindDocMasks(
        spec?.maskLayers ?? maskLayersForDocument(doc),
        builderSource,
      );

      /**
       * Step 4: a graph-led photo renders its STORED graph. Its params live
       * in the nodes, so nothing is handed in as an override — feeding it
       * values derived from the adjustments would be the one-way street this
       * plan closes, only pointing the other way. A built graph that came
       * through here for its retouch node is the other case, and it does hand
       * its params in; `DocumentGraph.params` is empty for the stored one and
       * holds the map for the built one, which is the difference spelled out.
       *
       * The plan is cached on the graph's revision, which the editor bumps on
       * every mutation, topology and params alike. That means a recompile per
       * edit; the graph view's own preview already works that way, and the
       * alternative would be guessing which mutations are topological.
       */
      if (spec) {
        const revision = spec.graph.metadata.revision;
        const graphKey = `graph:${spec.graph.id}:${revision}:${builderSource.geometry.width}x${builderSource.geometry.height}`;
        let graphPlan = layeredPlanRef.current.get(graphKey);
        if (!graphPlan) {
          graphPlan = await svc.compile(spec.graph);
          for (const [k, h] of layeredPlanRef.current) {
            if (k !== graphKey) void svc.releasePlan(h);
          }
          layeredPlanRef.current.clear();
          layeredPlanRef.current.set(graphKey, graphPlan);
          layeredLayersRef.current = [];
        }
        const { bitmap } = await svc.renderToImageBitmap(
          graphPlan, SOURCE_ID, spec.params.size > 0 ? spec.params : undefined,
          Object.keys(extraSources).length > 0 ? extraSources : undefined,
        );
        return bitmap;
      }

      // Layer set identity → reuse compiled layered plan; otherwise recompile.
      // Space signature is part of the identity: toggles move convert nodes.
      const layerKey = layers.map((l) => `${l.id}:${l.useMask ? 'm' : ''}`).join('|');
      const cacheKey = `layered:${layerKey}:${graphSpaceSignature(baseAdj)}`;
      let plan = layeredPlanRef.current.get(cacheKey);
      if (!plan || !layersEqual(layeredLayersRef.current, layers)) {
        const { graph } = buildLayeredGraph(baseAdj, layers, builderSource);
        plan = await svc.compile(graph);
        // Drop any other cached layered plan — the topology changed.
        for (const [k, h] of layeredPlanRef.current) {
          if (k !== cacheKey) void svc.releasePlan(h);
        }
        layeredPlanRef.current.clear();
        layeredPlanRef.current.set(cacheKey, plan);
        layeredLayersRef.current = layers;
      }

      const params = layeredParamsByNode(baseAdj, layers, builderSource);
      const { bitmap } = await svc.renderToImageBitmap(
        plan, SOURCE_ID, params,
        Object.keys(extraSources).length > 0 ? extraSources : undefined,
      );
      return bitmap;
    } catch (e) {
      console.warn('[useRenderPipeline] renderDoc failed:', e);
      return null;
    }
  }, [bindDocMasks, render]);

  // ─── AI Denoise — unsupported until the aiDenoiseMix graph kind lands ──
  // Honest no-ops: hasCleanPreview() must report false so AIDenoisePanel
  // shows "not available" instead of a fake active state, and no multi-MB
  // buffer gets pinned that render() would never read.

  const setCleanPreview = useCallback((_data: Float32Array | Uint8Array, _w: number, _h: number) => {
    console.warn('[useRenderPipeline] setCleanPreview: AI denoise mix is not supported by the graph engine yet');
  }, []);
  const clearCleanPreview = useCallback(() => { /* nothing stored */ }, []);
  const hasCleanPreview = useCallback(() => false, []);

  /**
   * The source spec the canvas is currently rendering through — RAW files get
   * `raw16` here, which selects a different chain (`chainForSource` prepends
   * WhiteBalanceRaw + ColorMatrix and drops the SDR WhiteBalance node) and
   * carries the camera calibration plus the chosen output color space.
   *
   * Exposed because the graph view has to build its graph from the same spec.
   * Assembling a second one from the photo's metadata would put a copy of this
   * decision next to the original, which is the very split this plan is
   * closing. Returns null until an image is loaded.
   */
  const getBuilderSource = useCallback(() => stateRef.current.builderSource, []);

  return useMemo(() => ({
    ready, error, hdr: hdrCapable,
    // Flips to true once the aiDenoiseMix graph kind is implemented.
    cleanPreviewSupported: false,
    setImage, setImageRaw, render, renderDocUpTo, renderDoc, getBuilderSource,
    retryInitialization,
    setCleanPreview, clearCleanPreview, hasCleanPreview,
  }), [ready, error, hdrCapable, setImage, setImageRaw, render, renderDocUpTo, renderDoc,
       retryInitialization,
       getBuilderSource, setCleanPreview, clearCleanPreview, hasCleanPreview]);
}

function layersEqual(a: BuilderLayer[], b: BuilderLayer[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].useMask !== b[i].useMask) return false;
  }
  return true;
}
