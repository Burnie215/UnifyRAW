/**
 * Renders a thumbnail per `preview` node in the live graph and returns
 * blob-URLs keyed by node id. Used by the graph editor to show the
 * intermediate pipeline state directly in the node body.
 *
 * Strategy: for each preview-tap, clone the graph down to that node
 * (drop every downstream node + edge, set output = previewNode) and
 * render the sub-plan through the shared WorkerPipelineService. A
 * generation counter discards stale results when the user keeps
 * editing while a render is in flight.
 *
 * Performance: debounced 250ms after param / topology changes; moving a node
 * renders nothing. The source is fetched, downscaled and bound once per URL
 * (previewSource.ts) and shared with the output panel. A `revokeObjectURL`
 * cleanup runs on each replacement.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KIND_PREVIEW, getDefaultPipelineService, graphContentKey, maskNodeIdForLayer, previewSubgraph,
} from '../engine/graph';
import type { RenderGraph, WorkerPipelineService } from '../engine/graph';
import { renderMaskToCanvas } from '../engine/Mask';
import type { MaskDefinition } from '../engine/Mask';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';
import {
  acquirePreviewSource, createPreviewSourceKeeper, previewSourceSpecFor,
  type PreviewSourceLease,
} from './previewSource';

export { previewSubgraph } from '../engine/graph';

const DEBOUNCE_MS = 250;

/**
 * One layer mask the preview has to bind: the layered graph carries a
 * `mask:<layerId>` source node per masked layer, but the mask SHAPES live in
 * the document, not in the graph — the host has to hand them down.
 */
export interface PreviewMaskLayer {
  layerId: string;
  mask: MaskDefinition;
}

export function usePreviewTapRenderer(
  graph: RenderGraph | null,
  sourceUrl: string | null,
  maskLayers?: readonly PreviewMaskLayer[],
  /** The photo's 16-bit pixels; a RAW graph's source node takes nothing else. */
  rawPixels?: RawPixelData | null,
): Map<string, string> {
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const generationRef = useRef(0);
  const urlsRef = useRef<Map<string, string>>(new Map());
  // Content signature, not array identity: the host rebuilds the mask list on
  // every document change, and re-rendering on an unchanged mask set is waste.
  const maskSig = useMemo(() => maskSignature(maskLayers), [maskLayers]);
  const maskLayersRef = useRef(maskLayers);
  maskLayersRef.current = maskLayers;
  const graphKey = useMemo(() => previewGraphKey(graph), [graph]);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [sourceKeeper] = useState(createPreviewSourceKeeper);
  // The spec is a fresh object per render (the graph is), so the effect hangs
  // on its KEY: a node drag mints a new graph but the same source.
  const sourceSpec = previewSourceSpecFor(graph, sourceUrl, rawPixels);
  const sourceKey = sourceSpec?.key ?? null;
  const sourceSpecRef = useRef(sourceSpec);
  sourceSpecRef.current = sourceSpec;

  // Revoke all blob URLs when the component unmounts. Bump the generation
  // so an in-flight renderAll drops (and revokes) its fresh URLs instead of
  // installing them into a ref nobody will ever clean up again.
  useEffect(() => () => {
    generationRef.current++;
    for (const url of urlsRef.current.values()) URL.revokeObjectURL(url);
    urlsRef.current.clear();
    sourceKeeper.keep(null);
  }, [sourceKeeper]);

  useEffect(() => {
    const graph = graphRef.current;
    const spec = sourceSpecRef.current;
    if (!graph || !spec) {
      sourceKeeper.keep(null);
      revokeAll(urlsRef.current);
      setPreviews(new Map());
      return;
    }
    const previewNodes = Array.from(graph.nodes.values()).filter((n) => n.kind === KIND_PREVIEW);
    if (previewNodes.length === 0) {
      sourceKeeper.keep(null);
      revokeAll(urlsRef.current);
      setPreviews(new Map());
      return;
    }

    const myGen = ++generationRef.current;
    const timer = setTimeout(() => { void renderAll(); }, DEBOUNCE_MS);

    async function renderAll() {
      sourceKeeper.keep(spec!);
      let source: PreviewSourceLease;
      try {
        source = await acquirePreviewSource(spec!);
      } catch (e) {
        if (generationRef.current === myGen) {
          console.warn('[usePreviewTapRenderer] source load failed', e);
        }
        return;
      }
      if (generationRef.current !== myGen) { source.release(); return; }

      const svc = getDefaultPipelineService();
      const results = new Map<string, string>();
      try {
        // Masks are rasterized at the DOWNSCALED preview size: previewSubgraph
        // rewrites every source node's width/height to the source dims, so a
        // native-size mask would sample against the wrong geometry.
        const masks = await bindPreviewMasks(
          svc, graph!, maskLayersRef.current, source.dims, `preview-tap-mask-${myGen}`,
        );
        for (const node of previewNodes) {
          if (generationRef.current !== myGen) break;
          try {
            const subgraph = previewSubgraph(graph!, node.id, source.dims);
            const planHandle = await svc.compile(subgraph);
            const out = await svc.renderToImageBitmap(
              planHandle, source.sourceId, undefined, masks.extraSources ?? undefined);
            // Encode to a blob URL so the SVG <image> tag can display it.
            const url = await imageBitmapToBlobUrl(out.bitmap);
            results.set(node.id, url);
            out.bitmap.close();
            // Drop the worker-side handle; the plan cache slot (revision-free
            // id) is replaced on the next recompile.
            void svc.releasePlan(planHandle).catch(() => { /* ignore */ });
          } catch (e) {
            console.warn('[usePreviewTapRenderer] render failed', node.id, e);
          }
        }
        await masks.release();
      } finally {
        source.release();
      }

      if (generationRef.current === myGen) {
        revokeAll(urlsRef.current);
        urlsRef.current = results;
        setPreviews(new Map(results));
      } else {
        revokeAll(results);
      }
    }

    return () => { clearTimeout(timer); };
  }, [graphKey, sourceKey, maskSig, sourceKeeper]);

  return previews;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * What a preview depends on in its graph: the content, not the object. A node
 * move mints a new graph and revision but cannot change a preview, so it must
 * not re-render one. The id rides along because the builder puts the geometry
 * into it.
 */
export function previewGraphKey(graph: RenderGraph | null): string {
  return graph ? `${graph.id}\n${graphContentKey(graph)}` : '';
}

export function maskSignature(maskLayers?: readonly PreviewMaskLayer[]): string {
  if (!maskLayers || maskLayers.length === 0) return '';
  return maskLayers.map((m) => `${m.layerId}:${JSON.stringify(m.mask)}`).join('|');
}

/**
 * Rasterize + bind the layer masks the graph's `mask:<layerId>` source nodes
 * expect, mirroring what `useRenderPipeline.renderDoc` does for the classic
 * canvas. Without this the compositor's `u_mask` samples whatever texture unit
 * happens to be bound.
 *
 * Bindings are per render cycle and released through the returned callback, so
 * a layer (or a mask) that disappears simply never gets rebound.
 */
export async function bindPreviewMasks(
  svc: WorkerPipelineService,
  graph: RenderGraph,
  maskLayers: readonly PreviewMaskLayer[] | undefined,
  dims: { width: number; height: number },
  idPrefix: string,
): Promise<{ extraSources: Record<string, string> | null; release: () => Promise<void> }> {
  const bound: string[] = [];
  const release = async () => {
    for (const id of bound) {
      try { await svc.unbindSource(id); } catch { /* */ }
    }
    bound.length = 0;
  };
  if (!maskLayers || maskLayers.length === 0) return { extraSources: null, release };

  const extraSources: Record<string, string> = {};
  for (const { layerId, mask } of maskLayers) {
    const nodeId = maskNodeIdForLayer(layerId);
    if (!graph.nodes.has(nodeId)) continue;
    const sourceId = `${idPrefix}-${layerId}`;
    try {
      const bitmap = await createImageBitmap(renderMaskToCanvas(mask, dims.width, dims.height));
      await svc.bindSource(sourceId, bitmap);
    } catch (e) {
      console.warn('[previewMasks] bind failed', layerId, e);
      continue;
    }
    bound.push(sourceId);
    extraSources[nodeId] = sourceId;
  }
  return { extraSources: bound.length > 0 ? extraSources : null, release };
}

function revokeAll(map: Map<string, string>): void {
  for (const url of map.values()) URL.revokeObjectURL(url);
  map.clear();
}

export async function imageBitmapToBlobUrl(bitmap: ImageBitmap, quality = 0.7): Promise<string> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('imageBitmapToBlobUrl: 2d context unavailable');
  // renderToImageBitmap returns image-order (upright) bitmaps.
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return URL.createObjectURL(blob);
}
