/**
 * Auto-layout for graph nodes — simplified Sugiyama (longest-path layering
 * + median-heuristic row ordering).
 *
 * Layout direction is **top-down**: each layer of the dataflow sits one
 * row below the previous, with siblings within a layer spread sideways.
 * This wins back horizontal space in the photo-editor's vertical column
 * arrangement — a deep pipeline becomes a long vertical strip instead
 * of a thin horizontal line.
 */
import type { RenderGraph, NodePosition } from './types';

// `COL_WIDTH` now spreads siblings inside one layer (horizontal step).
// `ROW_HEIGHT` is the gap between successive layers (vertical step).
const COL_WIDTH = 200;
const ROW_HEIGHT = 130;
const X_MARGIN = 40;
const Y_MARGIN = 40;

/**
 * Compute positions for every node in `graph`. Returns a fresh mapping
 * (does NOT mutate the graph). Caller can copy into `graph.metadata.nodePositions`
 * for persistence, or apply ephemerally.
 *
 * Respects existing positions in `graph.metadata.nodePositions` — those
 * take precedence so users don't lose manual arrangements when adding nodes.
 */
export function autoLayout(graph: RenderGraph): Record<string, NodePosition> {
  const existing = graph.metadata.nodePositions ?? {};
  const out: Record<string, NodePosition> = { ...existing };

  // Layer assignment: longest-path from sources to each node.
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const [id] of graph.nodes) { incoming.set(id, []); outgoing.set(id, []); }
  for (const edge of graph.edges) {
    if (incoming.has(edge.to.node)) incoming.get(edge.to.node)!.push(edge.from.node);
    if (outgoing.has(edge.from.node)) outgoing.get(edge.from.node)!.push(edge.to.node);
  }

  const layer = new Map<string, number>();
  const visiting = new Set<string>();

  function depth(id: string): number {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0; // cycle guard — shouldn't happen for valid graphs
    visiting.add(id);
    const preds = incoming.get(id) ?? [];
    const d = preds.length === 0 ? 0 : Math.max(...preds.map(depth)) + 1;
    visiting.delete(id);
    layer.set(id, d);
    return d;
  }
  for (const [id] of graph.nodes) depth(id);

  // Group nodes by layer.
  const byLayer = new Map<number, string[]>();
  for (const [id, l] of layer) {
    let arr = byLayer.get(l);
    if (!arr) { arr = []; byLayer.set(l, arr); }
    arr.push(id);
  }

  // Row order within each layer: stable by id for now. Median-of-predecessor
  // ordering reduces crossings in deeper layers; Phase 4-iteration 2 swap.
  const sortedLayers = Array.from(byLayer.keys()).sort((a, b) => a - b);
  for (const l of sortedLayers) {
    byLayer.get(l)!.sort();
  }

  // Assign coordinates. Skip nodes that already have user-set positions.
  // Top-down: depth → y, sibling index → x.
  for (const l of sortedLayers) {
    const ids = byLayer.get(l)!;
    for (let col = 0; col < ids.length; col++) {
      const id = ids[col];
      if (existing[id]) continue;
      out[id] = {
        x: X_MARGIN + col * COL_WIDTH,
        y: Y_MARGIN + l * ROW_HEIGHT,
      };
    }
  }
  return out;
}

/** Sugiyama layout constants exposed for the renderer (so node dimensions
 *  + spacing stay in one place). */
export const LAYOUT_METRICS = {
  COL_WIDTH,
  ROW_HEIGHT,
  X_MARGIN,
  Y_MARGIN,
  NODE_WIDTH: 180,
  NODE_HEIGHT: 80,
  PORT_RADIUS: 6,
} as const;
