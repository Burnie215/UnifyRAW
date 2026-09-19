/**
 * SVG bezier edge between two graph nodes. Geometry pulled from layout
 * positions + the kind's port layout.
 *
 * Resolves node→kind via the live `graph` (the caller owns the source of
 * truth) rather than string-parsing the node id. Keeps user-added nodes —
 * which don't follow the `default:<kind>` convention — rendered correctly.
 */
import type { Edge, NodePosition, RenderGraph } from '../engine/graph';
import { getMainThreadNodeRegistry, KIND_PREVIEW, LAYOUT_METRICS } from '../engine/graph';

const PREVIEW_THUMB_HEIGHT = 110;

export interface GraphEdgeProps {
  edge: Edge;
  positions: Record<string, NodePosition>;
  graph: RenderGraph;
}

export function GraphEdge({ edge, positions, graph }: GraphEdgeProps) {
  const fromPos = positions[edge.from.node];
  const toPos = positions[edge.to.node];
  if (!fromPos || !toPos) return null;

  const registry = getMainThreadNodeRegistry();
  const fromNode = graph.nodes.get(edge.from.node);
  const toNode = graph.nodes.get(edge.to.node);
  const fromKind = fromNode ? registry.get(fromNode.kind) : undefined;
  const toKind = toNode ? registry.get(toNode.kind) : undefined;

  const fromPortIdx = Math.max(0, fromKind?.outputPorts.findIndex((p) => p.id === edge.from.port) ?? 0);
  const toPortIdx = Math.max(0, toKind?.inputPorts.findIndex((p) => p.id === edge.to.port) ?? 0);
  const fromOuts = Math.max(1, fromKind?.outputPorts.length ?? 1);
  const toIns = Math.max(1, toKind?.inputPorts.length ?? 1);

  // Output anchor: bottom edge of producer (offset by preview-tap extra body).
  // Input anchor: top edge of consumer. Bezier control points sit on the
  // vertical axis so a top-down chain renders as smooth S-curves.
  const fromBodyH = LAYOUT_METRICS.NODE_HEIGHT
    + (graph.nodes.get(edge.from.node)?.kind === KIND_PREVIEW ? PREVIEW_THUMB_HEIGHT : 0);
  const sx = fromPos.x + (LAYOUT_METRICS.NODE_WIDTH / (fromOuts + 1)) * (fromPortIdx + 1);
  const sy = fromPos.y + fromBodyH;
  const tx = toPos.x + (LAYOUT_METRICS.NODE_WIDTH / (toIns + 1)) * (toPortIdx + 1);
  const ty = toPos.y;
  const dy = Math.max(Math.abs(ty - sy) * 0.5, 40);
  const d = `M ${sx} ${sy} C ${sx} ${sy + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`;

  return (
    <path
      d={d}
      stroke="rgba(180,180,180,0.7)"
      strokeWidth={1.5}
      fill="none"
      pointerEvents="stroke"
      data-edge-id={edge.id}
    >
      <title>{edge.from.node}:{edge.from.port} → {edge.to.node}:{edge.to.port}</title>
    </path>
  );
}
