/**
 * One place that turns a `PhotoDocument` into the graph that renders it.
 *
 * Until now every surface carried its own copy of the same three decisions —
 * which layers count, what a layer looks like as a `BuilderLayer`, and which
 * masks have to be bound:
 *
 *   - the editor canvas       (`useRenderPipeline.renderDoc`)
 *   - the library thumbnails  (`ThumbnailRenderer.thumbnailGraph`)
 *   - the graph view          (`PhotoEditor.graphLayers`)
 *   - the exporter            — which had NO copy at all, and therefore
 *                               dropped every adjustment layer, presets
 *                               included: the canvas showed the look, the
 *                               exported file did not.
 *
 * Four copies of a rule are four chances to drift, and the export is what
 * drifted. So the rule lives here now and the surfaces ask.
 *
 * Pure — no GL, no React, no worker. The caller owns compiling, binding and
 * rasterizing; this module only says WHAT to render.
 */
import type { Adjustments } from '../../types';
import type { PhotoDocument } from '../DocumentModel';
import { documentToAdjustments } from '../DocumentModel';
import { hydrateGraph } from './serialize';
import { pruneToOutput } from './subgraph';
import { graphContentHash } from './graphContentKey';
import { layerAdjustmentsForRendering } from '../PresetLayer';
import type { MaskDefinition } from '../Mask';
import {
  adjustmentsToBuilderAdjustments,
  buildDefaultGraph,
  buildLayeredGraph,
  adjustmentNodeId,
  layeredParamsByNode,
  maskNodeIdForLayer,
  paramsByNodeFromAdjustments,
  spliceBaseStage,
  spliceRetouch,
  spliceCrop,
  type BuilderAdjustments,
  type BuilderLayer,
  type BuilderSourceSpec,
} from './DefaultGraphBuilder';
import type { BlendMode } from './compositorKinds';
import { KIND_IMAGE_BITMAP_SOURCE, KIND_RAW16_SOURCE } from './sources';
import { KIND_OUTPUT_COLOR_SPACE, KIND_TONE_CURVE } from './passKinds';
import { OUTPUT_COLOR_SPACES } from '../outputColorSpaces';
import type { RenderGraph, RenderNode } from './types';
import { isFullCropRect } from '../Crop';

/** A layer whose mask the caller has to rasterize and bind. */
export interface DocumentMaskLayer {
  layerId: string;
  mask: MaskDefinition;
  /** Node id the rasterized mask has to be bound to. */
  nodeId: string;
}

export interface DocumentGraph {
  graph: RenderGraph;
  sourceNodeId: string;
  /**
   * Execute-time param overrides. Empty for a graph-led document: there the
   * params live in the stored nodes, and overriding them with values derived
   * from the adjustments is exactly the one-way street this plan closes.
   */
  params: Map<string, unknown>;
  /** Empty when the document is a single chain. */
  layers: BuilderLayer[];
  /** Empty when no visible layer carries a mask. */
  maskLayers: DocumentMaskLayer[];
  /** True when the graph came out of the document instead of being built. */
  fromStoredGraph: boolean;
}

/**
 * The layers a document actually renders: visible adjustment layers with a
 * non-zero opacity, in document order.
 *
 * `layerAdjustmentsForRendering` is what keeps a layer from re-applying the
 * document's transform and effects — `mergeAdjustments` adds every number
 * with a zero point, so a transform left in a layer flips the image once per
 * layer (the regression of 2026-05-17, see the comment at
 * DocumentModel.ts:172). Fields without a zero point (`ABSOLUTE_FIELDS`)
 * override instead, which is what lets a preset layer keep its own grain
 * size and feather without doubling the base's.
 */
export function builderLayersForDocument(doc: PhotoDocument): BuilderLayer[] {
  return visibleAdjustmentLayers(doc).map((l) => ({
    id: l.id,
    adjustments: adjustmentsToBuilderAdjustments(layerAdjustmentsForRendering(l)),
    opacity: l.opacity,
    blendMode: l.blendMode as BlendMode,
    useMask: !!l.mask,
    presetSyncId: l.presetSyncId,
  }));
}

/** The mask shapes those layers need. They live on the document, never in the
 *  graph, so every renderer has to be handed them explicitly. */
export function maskLayersForDocument(doc: PhotoDocument): DocumentMaskLayer[] {
  return visibleAdjustmentLayers(doc)
    .filter((l) => !!l.mask)
    .map((l) => ({ layerId: l.id, mask: l.mask!, nodeId: maskNodeIdForLayer(l.id) }));
}

/** The base adjustments in builder units — the flattened document. */
export function builderBaseForDocument(doc: PhotoDocument): BuilderAdjustments {
  return adjustmentsToBuilderAdjustments(documentToAdjustments(doc));
}

/**
 * Does this document need the document graph, or is the flat chain built
 * from its adjustments the whole picture?
 *
 * Four things the adjustments cannot say: a stored graph, a layer stack,
 * retouch spots, and the persisted crop rectangle. The canvas asks this
 * before choosing between `render` and
 * `renderDoc` - and it is a question rather than a list at the call site
 * because the list keeps growing and the caller that missed an entry would be
 * the surface showing a different picture from all the others.
 */
export function needsDocumentGraph(doc: PhotoDocument | null | undefined): boolean {
  if (!doc) return false;
  return isGraphLed(doc)
    || (doc.retouch?.length ?? 0) > 0
    || !isFullCropRect(doc.transform.crop)
    || doc.layers.some((l) => l.visible && l.type === 'adjustment');
}

/** Is this photo's truth the stored graph rather than its adjustments? */
export function isGraphLed(doc: PhotoDocument | null | undefined): boolean {
  return !!doc && doc.pipelineMode === 'graph' && !!doc.pipelineGraph;
}

/**
 * The graph and params that render this document through `source`.
 *
 * Three cases, and this is the only place that decides between them:
 *
 *  - graph-led  → the STORED graph, params baked into its nodes. Step 4 of
 *                 the plan: from here on the graph is what renders, and the
 *                 adjustments are the derived side.
 *  - layers     → the layered graph, params handed in per node.
 *  - neither    → byte for byte the single chain the flat path always built.
 */
export function buildDocumentGraph(
  doc: PhotoDocument,
  source: BuilderSourceSpec,
  overrideBase?: BuilderAdjustments,
): DocumentGraph {
  if (isGraphLed(doc)) return storedGraphFor(doc, source);
  const base = overrideBase ?? builderBaseForDocument(doc);
  const layers = builderLayersForDocument(doc);

  if (layers.length === 0) {
    const { graph, sourceNodeId } = buildDefaultGraph(base, source);
    const withRetouch = spliceRetouch(graph, doc.retouch).graph;
    return {
      graph: spliceCrop(withRetouch, doc.transform.crop).graph, sourceNodeId,
      params: paramsByNodeFromAdjustments(base, source),
      layers: [],
      maskLayers: [],
      fromStoredGraph: false,
    };
  }
  const { graph, sourceNodeId } = buildLayeredGraph(base, layers, source);
  const withRetouch = spliceRetouch(graph, doc.retouch).graph;
  return {
    graph: spliceCrop(withRetouch, doc.transform.crop).graph, sourceNodeId,
    params: layeredParamsByNode(base, layers, source),
    layers,
    maskLayers: maskLayersForDocument(doc),
    fromStoredGraph: false,
  };
}

/**
 * The tone-curve node whose input is the histogram background.
 *
 * Built documents have a named base chain and one named chain per visible
 * adjustment layer. A graph-led document can have arbitrary ids and several
 * serial curves, so walk the primary input path from the output back to the
 * source and retain the earliest curve in flow order.
 */
export function preCurveStopNodeFor(
  spec: DocumentGraph,
  activeLayerId: string | null,
): string | null {
  if (!spec.fromStoredGraph) {
    const layerId = activeLayerId && spec.layers.some((layer) => layer.id === activeLayerId)
      ? activeLayerId
      : undefined;
    const id = adjustmentNodeId(KIND_TONE_CURVE, layerId);
    return spec.graph.nodes.has(id) ? id : null;
  }

  let cursor: string | undefined = spec.graph.output;
  let first: string | null = null;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    if (spec.graph.nodes.get(cursor)?.kind === KIND_TONE_CURVE) first = cursor;
    cursor = spec.graph.edges.find(
      (edge) => edge.to.node === cursor && edge.to.port === 'in',
    )?.from.node;
  }
  return first;
}

/**
 * The flat single chain for a caller that has no document at all.
 *
 * Legacy shape, kept because two callers still have it: `exportPhoto`
 * without a document, and a thumbnail queued from bare adjustments (sync
 * rows written before documents existed). Same answer the document path
 * gives for a document without layers — but spelled once, here, instead of
 * once per caller.
 */
export function buildAdjustmentsGraph(
  adjustments: Adjustments,
  source: BuilderSourceSpec,
): DocumentGraph {
  const base = adjustmentsToBuilderAdjustments(adjustments);
  const { graph, sourceNodeId } = buildDefaultGraph(base, source);
  return {
    graph, sourceNodeId,
    params: paramsByNodeFromAdjustments(base, source),
    layers: [],
    maskLayers: [],
    fromStoredGraph: false,
  };
}

/**
 * The document's own graph, made ready to render.
 *
 * Four normalizations. Three are facts about the image or its destination
 * rather than edits:
 *
 *  - the source node's geometry is refreshed from the spec the caller is
 *    rendering through. A stored graph remembers the size it was built at,
 *    and the same document can be rendered at preview size, at full RAW
 *    resolution or into a thumbnail.
 *  - the output colour space node is refreshed the same way. Which space the
 *    pixels come out in is a property of where they are going - canvas,
 *    thumbnail, export file - not of the edit; a stored graph carries
 *    whatever space was set when it was saved, which is how a graph-led photo
 *    ended up as the third answer to "what space does this export in" (F030).
 *  - only masks whose node the graph actually contains are handed back.
 *    A mask added to the document after the graph was stored has no input
 *    to be bound to, and binding it to a missing node is an error rather
 *    than a picture.
 *
 * The third is bookkeeping, and it is not optional: the graph id gets the
 * geometry appended. `PipelineService.compile` caches plans by `graph.id`
 * alone, on the documented convention that the builder seeds the id from
 * the dimensions — and a stored graph breaks that convention, because its
 * id was frozen at the size it was built at while the geometry above is
 * rewritten per caller. Without this, the editor and the 300px thumbnail
 * share one cache slot, and whoever compiles first decides the size for
 * everyone: measured in the app as an editor canvas of 300x150 and an
 * export whose pixels came out tiled and shifted.
 *
 * The content needs the same treatment. A built graph takes its params per
 * render from the param map; a stored graph carries them baked into its
 * nodes and hands in no map at all. Two graph-led photos of one size - or
 * one whose camera profile changed underneath it - would otherwise render
 * with the params of whichever plan was compiled first. So the id also
 * carries a hash of nodes and wiring, taken after the base stage is spliced
 * in so that the profile's values count.
 */
function storedGraphFor(doc: PhotoDocument, source: BuilderSourceSpec): DocumentGraph {
  // The camera profile is a fact about the sensor, not an edit, so it belongs
  // in a stored graph as much as in a built one. Without it, switching a RAW
  // to graph mode would quietly undevelop it.
  // Only what reaches the output renders: a node the user dropped but has not
  // wired yet is a normal state mid-edit, and left in it would fail the
  // compile on the canvas, in the thumbnail job and in the export alike.
  const withBase = spliceBaseStage(pruneToOutput(hydrateGraph(doc.pipelineGraph!)).graph, source).graph;
  // After the base stage, for the same reason it sits behind it in a built
  // graph. A stored graph that already carries a retouch node keeps its own:
  // there the graph is the truth and the document's list is the derived side.
  const withRetouch = spliceRetouch(withBase, doc.retouch).graph;
  const graph = spliceCrop(withRetouch, doc.transform.crop).graph;
  const nodes = new Map(graph.nodes);
  let sourceNodeId = '';
  for (const [id, node] of nodes) {
    if (node.kind === KIND_OUTPUT_COLOR_SPACE) {
      nodes.set(id, withOutputColorSpace(node, source));
      continue;
    }
    if (node.kind !== KIND_IMAGE_BITMAP_SOURCE && node.kind !== KIND_RAW16_SOURCE) continue;
    sourceNodeId = id;
    nodes.set(id, withGeometry(node, source));
  }
  return {
    graph: { ...graph, id: storedGraphId(graph, source), nodes },
    sourceNodeId,
    params: new Map(),
    layers: [],
    maskLayers: maskLayersForDocument(doc).filter((m) => nodes.has(m.nodeId)),
    fromStoredGraph: true,
  };
}

/** The stored id, qualified by the geometry and the output space it is about
 *  to render at and by what it contains.
 *
 *  The output space belongs here for the same reason the geometry does: it is
 *  rewritten per caller above, it is compiled into the node's params rather
 *  than handed in per render, and `PipelineService.compile` caches by
 *  `graph.id` alone. Without it the editor canvas and an Adobe-RGB export of
 *  the same photo share one plan, and whoever compiled first picks the space
 *  for both. */
function storedGraphId(graph: RenderGraph, source: BuilderSourceSpec): string {
  const { width, height, pixelRatio } = source.geometry;
  const ocs = source.outputColorSpaceId ?? 'srgb';
  return `stored:${graph.id}@${width}x${height}@${pixelRatio}@${ocs}#${graphContentHash(graph)}`;
}

function withOutputColorSpace(node: RenderNode, source: BuilderSourceSpec): RenderNode {
  const id = source.outputColorSpaceId ?? 'srgb';
  const def = OUTPUT_COLOR_SPACES[id] ?? OUTPUT_COLOR_SPACES['srgb'];
  const params = (node.params && typeof node.params === 'object')
    ? node.params as Record<string, unknown>
    : {};
  return {
    ...node,
    params: { ...params, matrix: [...def.matrix], gammaType: def.gammaType },
  };
}

function withGeometry(node: RenderNode, source: BuilderSourceSpec): RenderNode {
  const params = (node.params && typeof node.params === 'object')
    ? node.params as Record<string, unknown>
    : {};
  return {
    ...node,
    params: {
      ...params,
      width: source.geometry.width,
      height: source.geometry.height,
      pixelRatio: source.geometry.pixelRatio,
    },
  };
}

function visibleAdjustmentLayers(doc: PhotoDocument) {
  return doc.layers.filter((l) => l.visible && l.type === 'adjustment' && l.opacity > 0);
}
