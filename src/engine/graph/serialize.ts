/**
 * Round-trip between the live `RenderGraph` (Map-based, executor-friendly)
 * and the JSON-safe `SerializedGraph` (Array-based, document-friendly).
 *
 * Used by `PhotoDocument.pipelineGraph` for persistence; the document syncs
 * as a whole row under LWW (Yjs was dropped, GRAPH_SINGLE_SOURCE_OF_TRUTH_PLAN).
 */
import type { RenderGraph } from './types';
import type { SerializedGraph, SerializedNode, SerializedEdge } from '../DocumentModel';

export function serializeGraph(graph: RenderGraph): SerializedGraph {
  const nodes: SerializedNode[] = [];
  for (const node of graph.nodes.values()) {
    nodes.push({ id: node.id, kind: node.kind, params: node.params });
  }
  const edges: SerializedEdge[] = graph.edges.map((e) => ({
    id: e.id, from: { ...e.from }, to: { ...e.to },
  }));
  return {
    id: graph.id,
    nodes,
    edges,
    output: graph.output,
    metadata: {
      createdAt: graph.metadata.createdAt,
      updatedAt: graph.metadata.updatedAt,
      revision: graph.metadata.revision,
      nodePositions: graph.metadata.nodePositions
        ? { ...graph.metadata.nodePositions }
        : undefined,
    },
  };
}

export function hydrateGraph(s: SerializedGraph): RenderGraph {
  const nodes = new Map(s.nodes.map((n) => [n.id, { id: n.id, kind: n.kind, params: n.params }]));
  const edges = s.edges.map((e) => ({ id: e.id, from: { ...e.from }, to: { ...e.to } }));
  return {
    id: s.id,
    nodes,
    edges,
    output: s.output,
    metadata: {
      createdAt: s.metadata.createdAt,
      updatedAt: s.metadata.updatedAt,
      revision: s.metadata.revision,
      nodePositions: s.metadata.nodePositions
        ? { ...s.metadata.nodePositions }
        : undefined,
    },
  };
}
