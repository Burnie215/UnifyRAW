/**
 * Overlay that surfaces the GraphCompiler's verdict as halos around the
 * offending nodes:
 *
 *   red     — a hard compile error,
 *   amber, dashed — a node that does not reach the output. It is left out of
 *             every render, so it cannot break one either,
 *   yellow  — a lossy linear→gamma conversion,
 *   purple  — a node the classic view cannot express (the gate of step 3 in
 *             the single-source-of-truth plan). Purple, not red: nothing is
 *             broken, the way back is just closed while it is there.
 *
 * The verdict is computed once per render by the host through
 * `useGraphCompileError` and handed in, so the halo, the host's message
 * column and its warning line always describe the same graph. The MESSAGE is
 * not shown here: it used to sit at bottom-left on top of the canvas'
 * shortcut hint, which covered it.
 *
 * Runs synchronously on every render — compile is < 1ms for typical
 * default-graph sizes. If perf becomes an issue we can debounce; for now
 * immediate feedback is more important.
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlockedNodeGroup, NodePosition, RenderGraph } from '../engine/graph';
import { GraphCompiler, getMainThreadNodeRegistry, LAYOUT_METRICS, pruneToOutput } from '../engine/graph';
import { formatBlockReasons } from '../i18n/gateReasons';

/** Edge produces RGBA16F (linear) but the consumer downcasts to RGBA8.
 *  Values > 1.0 get clamped — visible lossy banding in highlights. */
function findLossyConversions(graph: RenderGraph): Set<string> {
  const lossy = new Set<string>();
  const registry = getMainThreadNodeRegistry();
  for (const edge of graph.edges) {
    const fromNode = graph.nodes.get(edge.from.node);
    const toNode = graph.nodes.get(edge.to.node);
    if (!fromNode || !toNode) continue;
    const fromKind = registry.get(fromNode.kind);
    const toKind = registry.get(toNode.kind);
    if (!fromKind || !toKind) continue;
    // A linear→gamma transition is the warning case (HDR headroom lost).
    if (fromKind.outputSpace === 'linear' && toKind.inputSpace === 'gamma') {
      lossy.add(edge.to.node);
    }
  }
  return lossy;
}

export interface CompileErrorInfo {
  message: string;
  nodeId?: string;
}

export interface GraphValidation {
  /** The compiler's verdict on what renders, or null when it compiles. */
  error: CompileErrorInfo | null;
  /** Nodes that do not reach the output; every render leaves them out. */
  dropped: string[];
}

/** Validates the graph as it renders — pruned to the ancestors of its output,
 *  the same way `buildDocumentGraph` hands a stored graph to every surface. */
export function useGraphCompileError(graph: RenderGraph): GraphValidation {
  const compiler = useMemo(() => new GraphCompiler(getMainThreadNodeRegistry()), []);
  return useMemo(() => {
    const { graph: rendered, dropped } = pruneToOutput(graph);
    try {
      const err = compiler.validate(rendered);
      return { error: err ? { message: err.message, nodeId: err.nodeIds?.[0] } : null, dropped };
    } catch (e) {
      // Non-CompileError = compiler bug; still surface it instead of hiding.
      return { error: { message: e instanceof Error ? e.message : String(e) }, dropped };
    }
  }, [graph, compiler]);
}

export interface GraphValidationOverlayProps {
  graph: RenderGraph;
  positions: Record<string, NodePosition>;
  pan: { x: number; y: number };
  zoom: number;
  /** The host's `useGraphCompileError(graph).error`. */
  error: CompileErrorInfo | null;
  /** The host's `useGraphCompileError(graph).dropped`. */
  dropped: readonly string[];
  /** Nodes the projection cannot write back, with the reason per node. */
  blocked?: readonly BlockedNodeGroup[];
}

export function GraphValidationOverlay({
  graph, positions, pan, zoom, error, dropped, blocked = [],
}: GraphValidationOverlayProps) {
  const { t } = useTranslation();
  const lossyNodes = useMemo(() => findLossyConversions(graph), [graph]);

  const haloPos = error?.nodeId ? positions[error.nodeId] : null;
  if (!error && dropped.length === 0 && lossyNodes.size === 0 && blocked.length === 0) return null;

  return (
    <>
      <svg
        style={{
          position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
          pointerEvents: 'none',
        }}
      >
        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {/* Yellow halos: lossy conversions (RGBA16F → RGBA8 boundary) */}
          {Array.from(lossyNodes).map((id) => {
            const p = positions[id];
            if (!p) return null;
            return (
              <rect
                key={`lossy-${id}`}
                x={p.x - 3}
                y={p.y - 3}
                width={LAYOUT_METRICS.NODE_WIDTH + 6}
                height={LAYOUT_METRICS.NODE_HEIGHT + 6}
                rx={8}
                fill="none"
                stroke="rgba(245,166,35,0.6)"
                strokeWidth={2}
                strokeDasharray="3 2"
              />
            );
          })}
          {/* Amber dashed halos: nodes that do not reach the output. */}
          {dropped.map((id) => {
            const p = positions[id];
            if (!p) return null;
            return (
              <rect
                key={`dropped-${id}`}
                data-dropped-halo={id}
                x={p.x - 4}
                y={p.y - 4}
                width={LAYOUT_METRICS.NODE_WIDTH + 8}
                height={LAYOUT_METRICS.NODE_HEIGHT + 8}
                rx={8}
                fill="none"
                stroke="rgba(241,196,15,0.85)"
                strokeWidth={2}
                strokeDasharray="6 4"
              />
            );
          })}
          {/* Purple halos: nodes the classic view has no place for. The
              reason rides along as a <title>, so hovering the node in the
              canvas answers "why" without opening the list. */}
          {blocked.map(({ nodeId, reasons }) => {
            const p = positions[nodeId];
            if (!p) return null;
            return (
              <rect
                key={`gate-${nodeId}`}
                data-gate-halo={nodeId}
                x={p.x - 4}
                y={p.y - 4}
                width={LAYOUT_METRICS.NODE_WIDTH + 8}
                height={LAYOUT_METRICS.NODE_HEIGHT + 8}
                rx={8}
                fill="none"
                stroke="var(--gate-blocked, #9b59b6)"
                strokeWidth={3}
                // Only the 3px ring is hit-testable — `all` would cover the
                // node's own click and drag targets with an invisible fill.
                style={{ pointerEvents: 'stroke' }}
              >
                <title>{formatBlockReasons(reasons, t)}</title>
              </rect>
            );
          })}
          {/* Red halo: hard compile error */}
          {haloPos && (
            <rect
              x={haloPos.x - 4}
              y={haloPos.y - 4}
              width={LAYOUT_METRICS.NODE_WIDTH + 8}
              height={LAYOUT_METRICS.NODE_HEIGHT + 8}
              rx={8}
              fill="none"
              stroke="rgba(231,76,60,0.8)"
              strokeWidth={3}
              strokeDasharray="6 3"
            />
          )}
        </g>
      </svg>
    </>
  );
}
