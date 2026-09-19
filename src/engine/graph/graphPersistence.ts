/**
 * What a graph edit writes back into the document.
 *
 * The document is the one truth, the graph a view onto it. Which half of that
 * a change lands in is decided here, once, for the editor and the tests:
 *
 *  - projectable (the classic view can say the same thing) -> the edit is
 *    PROJECTED into the document and only the node layout is stored. That is
 *    what makes a param turned at a default node survive the way back, a
 *    photo switch and the next graph entry, where `syncDefaultNodeParams`
 *    would otherwise overwrite it from the sliders.
 *  - blocking (a custom LUT, a tap, a hand-wired branch) -> the graph is
 *    stored and `pipelineMode` flips to `'graph'`. From there the graph leads
 *    until the user walks back to the classic view.
 *
 * The plan's decision, in its own words: "`pipelineGraph` existiert nur in
 * graph-geführten Dokumenten. Knotenpositionen separat, damit das Layout
 * Moduswechsel überlebt." The editor did the opposite — every graph change,
 * a node nudged by two pixels included, stored the whole serialized graph on
 * the document, and nothing ever removed it again. A photo that was opened in
 * the graph view once carried ~12 KiB from then on, through every later save
 * and into all 50 `documentHistory` entries, whether or not the graph led it.
 *
 * Pure: no React, no GL. The editor calls it, the tests measure it.
 */
import type { PhotoDocument } from '../DocumentModel';
import { buildDocumentGraph } from './documentGraph';
import { serializeGraph } from './serialize';
import { graphContentKey } from './graphContentKey';
import type { BuilderSourceSpec } from './DefaultGraphBuilder';
import { projectToDocument, groupBlockedByNode, type BlockedNodeGroup, type ProjectToDocumentResult } from './projection/projectToDocument';
import { deepEqual } from './projection/paramsToAdjustments';
import type { RenderGraph } from './types';

/** What a graph edit did: the document to write, and what blocks the way back. */
export interface GraphEditResult {
  /** `doc` itself when the edit changed nothing the document holds — the
   *  writer takes that as "no write", so it costs no history entry. */
  document: PhotoDocument;
  blocked: BlockedNodeGroup[];
}

/**
 * One graph edit, one answer: the document after it and the gate's verdict.
 *
 * The single seam between the editor and the document. It projects while the
 * gate is open instead of waiting for the way back, because the way back is
 * not the only way out: switching photos remounts the editor (App.tsx,
 * `key={selectedPhoto.id}`) and everything not written by then is gone.
 */
export function documentAfterGraphEdit(
  doc: PhotoDocument,
  graph: RenderGraph,
  source: BuilderSourceSpec,
): GraphEditResult {
  let projected: ProjectToDocumentResult;
  try {
    projected = projectToDocument(graph, source, doc);
  } catch (e) {
    // The gate's old rule, kept: a projection that throws leaves the way back
    // OPEN and puts its evidence in the console. A wrongly locked button
    // costs the user more than a wrongly open one.
    console.warn('[graphPersistence] projection failed:', e);
    return { document: unlessUnchanged(doc, documentAfterGraphChange(doc, graph, source, false)), blocked: [] };
  }
  if (projected.ok) {
    // The projected document builds exactly this graph again, so
    // `documentAfterGraphChange` sees no deviation and stores the layout
    // alone — a classic photo stops carrying a `pipelineGraph` at all.
    return {
      document: unlessUnchanged(doc, documentAfterGraphChange(projected.document, graph, source, false)),
      blocked: [],
    };
  }
  return {
    document: unlessUnchanged(doc, documentAfterGraphChange(doc, graph, source, true)),
    blocked: groupBlockedByNode(projected.blocked),
  };
}

/** `after`, or `before` itself when the two say the same thing. */
function unlessUnchanged(before: PhotoDocument, after: PhotoDocument): PhotoDocument {
  return sameEdit(before, after) ? before : after;
}

/**
 * Do these two documents describe the same edit?
 *
 * The stored graph counts along — on a graph-led photo the wiring IS the
 * edit — but only the parts the user authored. Every mutation stamps a fresh
 * revision and timestamp, and the graph's id carries the source geometry;
 * comparing those would call a re-selected node a change and hand the
 * document history a new entry for a picture nobody touched.
 */
function sameEdit(a: PhotoDocument, b: PhotoDocument): boolean {
  return (a.pipelineMode ?? 'classic') === (b.pipelineMode ?? 'classic')
    && deepEqual(a.layers, b.layers)
    && deepEqual(a.transform, b.transform)
    && deepEqual(a.finalEffects, b.finalEffects)
    && deepEqual(a.graphLayout, b.graphLayout)
    && deepEqual(authoredPartOf(a), authoredPartOf(b));
}

function authoredPartOf(doc: PhotoDocument): unknown {
  const stored = doc.pipelineGraph;
  if (!stored) return null;
  return {
    nodes: stored.nodes,
    edges: stored.edges,
    output: stored.output,
    positions: stored.metadata.nodePositions ?? null,
  };
}

/** The lower half of `documentAfterGraphEdit`: store the graph, or its layout
 *  alone. Called directly only where there is no projection to make — the way
 *  back to the classic view. */
export function documentAfterGraphChange(
  doc: PhotoDocument,
  graph: RenderGraph,
  source: BuilderSourceSpec,
  blocked: boolean,
): PhotoDocument {
  const graphLed = blocked || doc.pipelineMode === 'graph';
  if (graphLed || deviatesFromBuilt(doc, graph, source)) {
    return {
      ...doc,
      pipelineGraph: serializeGraph(graph),
      pipelineMode: blocked ? 'graph' : doc.pipelineMode,
      // The positions ride in the stored graph's metadata; a second copy
      // would be one more thing that can disagree with itself.
      graphLayout: undefined,
    };
  }
  return { ...doc, pipelineGraph: undefined, graphLayout: layoutOf(graph) };
}

/**
 * Leaving the graph view for the classic one. The classic view owns the truth
 * again, so the same rule applies with the flag flipped back — a graph that
 * says nothing the document does not already say has no reason to be stored.
 */
export function documentAfterReturnToClassic(
  doc: PhotoDocument,
  graph: RenderGraph | null,
  source: BuilderSourceSpec,
): PhotoDocument {
  const classic: PhotoDocument = { ...doc, pipelineMode: 'classic' };
  return graph ? documentAfterGraphChange(classic, graph, source, false) : classic;
}

/**
 * The layout a freshly built graph should wear: what the user arranged the
 * last time, if the document remembers it. Without this the positions would
 * only survive as long as the stored graph did.
 */
export function withStoredLayout(graph: RenderGraph, doc: PhotoDocument | null | undefined): RenderGraph {
  const layout = doc?.graphLayout;
  if (!layout || Object.keys(layout).length === 0) return graph;
  return {
    ...graph,
    metadata: {
      ...graph.metadata,
      nodePositions: { ...layout, ...(graph.metadata.nodePositions ?? {}) },
    },
  };
}

function layoutOf(graph: RenderGraph): Record<string, { x: number; y: number }> | undefined {
  const positions = graph.metadata.nodePositions;
  return positions && Object.keys(positions).length > 0 ? { ...positions } : undefined;
}

/**
 * Does this graph say anything the document does not already say?
 *
 * Compared are the nodes (id, kind, params), the wiring and the output — not
 * the positions, not the revision, and not the source node's geometry, which
 * belongs to whoever renders rather than to the edit.
 *
 * When in doubt this answers "yes": a comparison that fails for any other
 * reason stores the graph, which is exactly what happened before this rule
 * existed.
 */
function deviatesFromBuilt(
  doc: PhotoDocument,
  graph: RenderGraph,
  source: BuilderSourceSpec,
): boolean {
  try {
    return graphContentKey(graph) !== graphContentKey(buildDocumentGraph(doc, source).graph);
  } catch {
    return true;
  }
}
