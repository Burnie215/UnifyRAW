/**
 * Graph truncation helpers: derive a sub-graph whose terminal is an
 * intermediate node of a larger graph. Used by the graph editor's node
 * previews (previewSubgraph) and the editor's pre-curve histogram snapshot
 * (subgraphBefore → renderDocUpTo). pruneToOutput keeps the terminal and only
 * drops what does not reach it.
 *
 * The sub-graph ids are deterministic and embed the parent graph id, so the
 * worker's plan cache treats each truncation point as its own cache slot.
 */
import type { RenderGraph, RenderNode } from './types';
import { KIND_CONVERT_LIN_TO_GAMMA } from './builtins';
import { KIND_OUTPUT_COLOR_SPACE } from './passKinds';
import { getMainThreadNodeRegistry } from './defaultPipelineService';

/**
 * Build a sub-graph whose terminal is `previewNodeId`: everything that does
 * not feed that node is dropped, along with their incident edges. The graph
 * id is suffixed so the worker's plan cache treats sub-graphs as distinct.
 *
 * Keeping the ANCESTORS rather than dropping the downstream matters as soon
 * as the document is layered: a base-chain or branch-chain preview sits in a
 * sibling branch of the layer's `mask:<id>` source node, which dropping only
 * the downstream leaves stranded in the sub-graph. PipelineService then
 * refuses the plan ("multiple unbound source nodes") and the preview stays
 * empty. Ancestors-only also spares the render the sibling branch's ~17
 * passes, whose result nothing reads.
 *
 * If `sourceDims` is supplied, any source-category nodes in the sub-graph
 * get their `width`/`height` params rewritten to match — the pipeline
 * sizes its FBOs from those params, so binding a downscaled bitmap to a
 * graph that still claims the original resolution leaves most of the
 * framebuffer black. Preview renderers pass the actual bitmap size here.
 */
export function previewSubgraph(
  graph: RenderGraph,
  previewNodeId: string,
  sourceDims?: { width: number; height: number },
): RenderGraph {
  const nodes = keepAncestorsOf(graph, previewNodeId);
  const edges = graph.edges.filter((e) => nodes.has(e.from.node) && nodes.has(e.to.node));
  // Whether display encoding was cut away is a question about the preview
  // node's OWN path, not about everything the prune removed: a sibling
  // branch carries its own OutputColorSpace, and counting that one would
  // double-encode previews taken from the gamma block.
  const downstream = collectDownstream(graph, previewNodeId);

  // Most of the default pipeline runs in working-linear space and only the
  // OutputColorSpace node encodes for display. Truncating before it hands the
  // caller linear pixels, which shown as-is look far too dark — so re-encode
  // whenever the cut is upstream of that node.
  const cutBeforeDisplayEncode = Array.from(downstream).some(
    (id) => graph.nodes.get(id)?.kind === KIND_OUTPUT_COLOR_SPACE,
  );
  let output = previewNodeId;
  let idSuffix = '';
  if (cutBeforeDisplayEncode) {
    const convertId = `__preview_gamma:${previewNodeId}`;
    nodes.set(convertId, { id: convertId, kind: KIND_CONVERT_LIN_TO_GAMMA, params: {} });
    edges.push({
      id: `e:${previewNodeId}→${convertId}`,
      from: { node: previewNodeId, port: 'out' },
      to: { node: convertId, port: 'in' },
    });
    output = convertId;
    idSuffix = '::g';
  }

  if (sourceDims) {
    const registry = getMainThreadNodeRegistry();
    for (const [id, node] of nodes) {
      const spec = registry.get(node.kind);
      if (spec?.category !== 'source') continue;
      const params = node.params as Record<string, unknown>;
      nodes.set(id, { ...node, params: { ...params, width: sourceDims.width, height: sourceDims.height } });
    }
  }

  return {
    // Revision-FREE id: every edit would otherwise mint a new plan-cache
    // slot per preview node. The cache's revision check (metadata below)
    // still forces a recompile after mutations — it just REPLACES the slot.
    id: `${graph.id}::preview::${previewNodeId}${idSuffix}::${sourceDims?.width ?? 0}x${sourceDims?.height ?? 0}`,
    nodes,
    edges,
    output,
    metadata: { ...graph.metadata },
  };
}

/**
 * Build a sub-graph that renders everything UP TO (excluding) `stopNodeId`:
 * terminal becomes stopNode's primary ('in') producer; stopNode and its
 * downstream are dropped. Returns null when the stop node or its producer
 * doesn't exist; callers decide whether that means no preview or a fallback.
 *
 * `appendLinToGamma` tacks a lin→gamma convert onto the new terminal so
 * consumers get display-encoded pixels even when the truncation point sits
 * inside the linear block (the pre-toneCurve histogram case).
 */
export function subgraphBefore(
  graph: RenderGraph,
  stopNodeId: string,
  opts?: { appendLinToGamma?: boolean },
): RenderGraph | null {
  if (!graph.nodes.has(stopNodeId)) return null;
  const producerEdge = graph.edges.find(
    (e) => e.to.node === stopNodeId && e.to.port === 'in',
  );
  if (!producerEdge) return null;
  const terminalId = producerEdge.from.node;

  const nodes = keepAncestorsOf(graph, terminalId);
  const edges = graph.edges.filter((e) => nodes.has(e.from.node) && nodes.has(e.to.node));

  let output = terminalId;
  let idSuffix = '';
  if (opts?.appendLinToGamma) {
    const convertId = `__upto_gamma:${stopNodeId}`;
    nodes.set(convertId, { id: convertId, kind: KIND_CONVERT_LIN_TO_GAMMA, params: {} });
    edges.push({
      id: `e:${terminalId}→${convertId}`,
      from: { node: terminalId, port: 'out' },
      to: { node: convertId, port: 'in' },
    });
    output = convertId;
    idSuffix = '::g';
  }

  return {
    id: `${graph.id}::upto::${stopNodeId}${idSuffix}`,
    nodes,
    edges,
    output,
    metadata: { ...graph.metadata },
  };
}

/**
 * The graph as it renders: only what feeds `graph.output`. A node dropped
 * in the editor but not wired yet, or a side branch that ends nowhere,
 * contributes nothing to the picture — yet the compiler checks every node's
 * ports and would reject the whole graph over it. Unlike previewSubgraph the
 * id, the output and the source geometry are left alone; a caller that keys
 * a cache on the id derives it itself (storedGraphFor hashes the content).
 * Hands back the graph itself when nothing is dropped.
 */
export function pruneToOutput(graph: RenderGraph): { graph: RenderGraph; dropped: string[] } {
  const nodes = keepAncestorsOf(graph, graph.output);
  if (nodes.size === graph.nodes.size) return { graph, dropped: [] };
  const dropped = [...graph.nodes.keys()].filter((id) => !nodes.has(id));
  const edges = graph.edges.filter((e) => nodes.has(e.from.node) && nodes.has(e.to.node));
  return { graph: { ...graph, nodes, edges }, dropped };
}

/**
 * The nodes that feed `nodeId` (transitively), plus `nodeId` itself — i.e.
 * everything a render terminating there actually needs. Multi-input kinds
 * (Compositor: `in` + `layer` + `mask`) keep all of their feeding branches,
 * since the walk follows every incoming edge.
 */
function keepAncestorsOf(graph: RenderGraph, nodeId: string): Map<string, RenderNode> {
  const keep = new Set<string>();
  const queue: string[] = [];
  if (graph.nodes.has(nodeId)) { keep.add(nodeId); queue.push(nodeId); }
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of graph.edges) {
      if (e.to.node === id && !keep.has(e.from.node) && graph.nodes.has(e.from.node)) {
        keep.add(e.from.node);
        queue.push(e.from.node);
      }
    }
  }
  const nodes = new Map<string, RenderNode>();
  for (const [id, node] of graph.nodes) if (keep.has(id)) nodes.set(id, node);
  return nodes;
}

function collectDownstream(graph: RenderGraph, nodeId: string): Set<string> {
  const downstream = new Set<string>();
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of graph.edges) {
      if (e.from.node === id && e.to.node !== nodeId && !downstream.has(e.to.node)) {
        downstream.add(e.to.node);
        queue.push(e.to.node);
      }
    }
  }
  return downstream;
}
