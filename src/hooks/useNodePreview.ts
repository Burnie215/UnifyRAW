/**
 * Render a single preview thumbnail for an arbitrary node — used by the
 * graph editor's right-side output panel to show what the pipeline state
 * looks like after the currently-selected node.
 *
 * Mirrors usePreviewTapRenderer's subgraph + worker strategy, but
 * targets exactly one node (not every preview-tap in the graph). A
 * generation counter discards stale renders triggered by rapid selection
 * changes or slider drags. The source is the one previewSource.ts shares
 * with the preview taps.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDefaultPipelineService } from '../engine/graph';
import type { RenderGraph } from '../engine/graph';
import { previewSubgraph } from '../engine/graph';
import {
  bindPreviewMasks, imageBitmapToBlobUrl, maskSignature, previewGraphKey,
  type PreviewMaskLayer,
} from './usePreviewTapRenderer';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';
import {
  acquirePreviewSource, createPreviewSourceKeeper, previewSourceSpecFor,
  type PreviewSourceLease,
} from './previewSource';

const DEBOUNCE_MS = 250;

export interface NodePreviewResult {
  url: string | null;
  loading: boolean;
}

export function useNodePreview(
  graph: RenderGraph | null,
  nodeId: string | null,
  sourceUrl: string | null,
  maskLayers?: readonly PreviewMaskLayer[],
  /** The photo's 16-bit pixels; a RAW graph's source node takes nothing else. */
  rawPixels?: RawPixelData | null,
): NodePreviewResult {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generationRef = useRef(0);
  const currentUrlRef = useRef<string | null>(null);
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

  // Revoke the active URL on unmount; bump the generation so an in-flight
  // renderOnce revokes its fresh URL instead of leaking it.
  useEffect(() => () => {
    generationRef.current++;
    if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
    currentUrlRef.current = null;
    sourceKeeper.keep(null);
  }, [sourceKeeper]);

  useEffect(() => {
    const graph = graphRef.current;
    const spec = sourceSpecRef.current;
    if (!graph || !nodeId || !spec || !graph.nodes.has(nodeId)) {
      sourceKeeper.keep(null);
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }
      setUrl(null);
      setLoading(false);
      return;
    }

    const myGen = ++generationRef.current;
    setLoading(true);
    const timer = setTimeout(() => { void renderOnce(); }, DEBOUNCE_MS);

    async function renderOnce() {
      sourceKeeper.keep(spec!);
      let source: PreviewSourceLease;
      try {
        source = await acquirePreviewSource(spec!);
      } catch (e) {
        if (generationRef.current === myGen) {
          console.warn('[useNodePreview] source load failed', e);
          setLoading(false);
        }
        return;
      }
      if (generationRef.current !== myGen) { source.release(); return; }

      const svc = getDefaultPipelineService();
      let nextUrl: string | null = null;
      // Masks are rasterized at the DOWNSCALED preview size: previewSubgraph
      // rewrites every source node's width/height to the source dims, so a
      // native-size mask would sample against the wrong geometry.
      let masks: { extraSources: Record<string, string> | null; release: () => Promise<void> } | null = null;
      try {
        masks = await bindPreviewMasks(
          svc, graph!, maskLayersRef.current, source.dims, `node-preview-mask-${myGen}`,
        );
        const subgraph = previewSubgraph(graph!, nodeId!, source.dims);
        const planHandle = await svc.compile(subgraph);
        const out = await svc.renderToImageBitmap(
          planHandle, source.sourceId, undefined, masks.extraSources ?? undefined);
        nextUrl = await imageBitmapToBlobUrl(out.bitmap, 0.8);
        out.bitmap.close();
        void svc.releasePlan(planHandle).catch(() => { /* ignore */ });
      } catch (e) {
        if (generationRef.current === myGen) {
          console.warn('[useNodePreview] render failed', nodeId, e);
        }
      } finally {
        source.release();
        if (masks) await masks.release();
      }

      if (generationRef.current === myGen) {
        if (currentUrlRef.current) URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = nextUrl;
        setUrl(nextUrl);
        setLoading(false);
      } else if (nextUrl) {
        URL.revokeObjectURL(nextUrl);
      }
    }

    return () => { clearTimeout(timer); };
  }, [graphKey, nodeId, sourceKey, maskSig, sourceKeeper]);

  return { url, loading };
}
