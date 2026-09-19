/**
 * useGraphEditor — single React hook owning the Phase-4 graph editor's
 * mutable graph. Pure data; rendering lives in `GraphEditor.tsx`.
 *
 * Mutations bump `graph.metadata.revision` so consumers (live preview)
 * can recompile on topology change without diffing the structure. The
 * counter is read and raised OUTSIDE the state updater: React may call an
 * updater twice (StrictMode, concurrent rendering), and a counter raised
 * inside it would hand the two calls two different revisions for one edit.
 *
 * There is no undo stack here. The document owns the history — every edit
 * travels through it (see `documentAfterGraphEdit`), and one Ctrl-Z that
 * stepped two stacks of different depths was the bug, not the feature. What
 * the document hands back arrives as `setGraph`.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { RenderGraph, RenderNode, NodePosition, Edge } from '../engine/graph';

export interface GraphEditorState {
  /** Live graph the editor renders against. */
  graph: RenderGraph;
  /** Node ids currently selected (box-select / shift-click). */
  selection: Set<string>;
}

export interface GraphEditorActions {
  /** Play a graph from outside back (document undo, history panel, sync,
   *  reset). Keeps the selection that still has nodes. */
  setGraph(graph: RenderGraph): void;
  /** Single-node selection (clears prior). */
  select(nodeId: string | null): void;
  /** Add `nodeId` to the existing selection. */
  selectAdd(nodeId: string): void;
  setSelection(ids: Set<string>): void;
  /** Bulk-move (drag of multiple selected nodes). */
  moveNodes(deltas: Map<string, NodePosition>): void;
  setNodeParams(nodeId: string, params: unknown): void;
  /** Insert a new node at `position` with default params per its schema. */
  addNode(node: RenderNode, position: NodePosition): void;
  removeNodes(ids: Iterable<string>): void;
  /** Connect (from-node:from-port) → (to-node:to-port). Throws if it would
   *  create a duplicate edge or a cycle. */
  connect(fromNode: string, fromPort: string, toNode: string, toPort: string): void;
  removeEdge(edgeId: string): void;
}

export function useGraphEditor(initial: RenderGraph): [GraphEditorState, GraphEditorActions] {
  const [graph, setGraphState] = useState<RenderGraph>(() => cloneGraph(initial));
  const [selection, setSelectionState] = useState<Set<string>>(() => new Set());
  // Monotonic revision counter: a graph played back from the document carries
  // old CONTENT but gets a FRESH revision. Reusing one would let a later
  // mutation mint an (id, revision) pair that plan caches have already seen
  // for a different topology — they would serve the undone plan (C6).
  const revisionRef = useRef(initial.metadata.revision);
  // `connect` validates against the live graph without making the action
  // object change identity on every edit: an effect that plays the document
  // back keys on `actions`, and a new one per mutation would re-run it.
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const mutate = useCallback((updater: (prev: RenderGraph) => RenderGraph) => {
    const revision = ++revisionRef.current;
    const updatedAt = Date.now();
    setGraphState((prev) => {
      const next = updater(cloneGraph(prev));
      next.metadata.revision = revision;
      next.metadata.updatedAt = updatedAt;
      return next;
    });
  }, []);

  const actions = useMemo<GraphEditorActions>(() => ({
    setGraph(g) {
      // Above everything seen so far, including the incoming graph's own.
      revisionRef.current = Math.max(revisionRef.current, g.metadata.revision) + 1;
      const next = cloneGraph(g);
      next.metadata.revision = revisionRef.current;
      setGraphState(next);
      setSelectionState((prev) => {
        const kept = new Set([...prev].filter((id) => next.nodes.has(id)));
        return kept.size === prev.size ? prev : kept;
      });
    },
    select(id) {
      setSelectionState(id === null ? new Set() : new Set([id]));
    },
    selectAdd(id) {
      setSelectionState((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
    },
    setSelection(ids) {
      setSelectionState(new Set(ids));
    },
    moveNodes(deltas) {
      mutate((g) => {
        const positions = { ...(g.metadata.nodePositions ?? {}) };
        for (const [id, pos] of deltas) positions[id] = pos;
        g.metadata.nodePositions = positions;
        return g;
      });
    },
    setNodeParams(nodeId, params) {
      mutate((g) => {
        const node = g.nodes.get(nodeId);
        if (!node) return g;
        g.nodes.set(nodeId, { ...node, params });
        return g;
      });
    },
    addNode(node, position) {
      mutate((g) => {
        g.nodes.set(node.id, node);
        const positions = { ...(g.metadata.nodePositions ?? {}) };
        positions[node.id] = position;
        g.metadata.nodePositions = positions;
        return g;
      });
    },
    removeNodes(ids) {
      const idSet = new Set(ids);
      mutate((g) => removeNodesFromGraph(g, idSet));
      setSelectionState((prev) => {
        const next = new Set(prev);
        for (const id of idSet) next.delete(id);
        return next;
      });
    },
    connect(fromNode, fromPort, toNode, toPort) {
      const live = graphRef.current;
      // Validation: duplicate edge?
      const dup = live.edges.some((e) =>
        e.from.node === fromNode && e.from.port === fromPort &&
        e.to.node === toNode && e.to.port === toPort,
      );
      if (dup) throw new Error('connect: duplicate edge');
      // Cycle check: would adding this edge introduce a cycle?
      if (introducesCycle(live, fromNode, toNode)) {
        throw new Error('connect: would create cycle');
      }
      mutate((g) => {
        const id = `e:${fromNode}.${fromPort}→${toNode}.${toPort}:${g.metadata.revision + 1}`;
        g.edges = [...g.edges, { id, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } }];
        return g;
      });
    },
    removeEdge(edgeId) {
      mutate((g) => {
        g.edges = g.edges.filter((e) => e.id !== edgeId);
        return g;
      });
    },
  }), [mutate]);

  const state = useMemo<GraphEditorState>(() => ({ graph, selection }), [graph, selection]);

  return [state, actions];
}

// ─── Helpers ──────────────────────────────────────────────────────

function cloneGraph(g: RenderGraph): RenderGraph {
  return {
    id: g.id,
    nodes: new Map(g.nodes),
    edges: g.edges.slice(),
    output: g.output,
    metadata: {
      ...g.metadata,
      nodePositions: g.metadata.nodePositions ? { ...g.metadata.nodePositions } : undefined,
    },
  };
}

/**
 * Delete `removed` from the graph and close the gap behind them.
 *
 * Mutates and returns `g` — callers hand in a clone (see `mutate`). Pure
 * enough to test directly, which is why the whole operation lives here
 * instead of inline in the hook.
 */
export function removeNodesFromGraph(g: RenderGraph, removed: Set<string>): RenderGraph {
  // Read the still-intact topology first: healEdges needs to see what each
  // removed node sat between before its edges disappear.
  const healed = healEdges(g, removed);
  // Deleting the terminal hands the role to whatever fed it. Only when
  // nothing did (the whole chain went) do we fall back to an arbitrary
  // survivor, which still beats an empty output.
  const inheritedOutput = removed.has(g.output)
    ? survivingProducer(g, removed, g.output)?.node
    : undefined;

  for (const id of removed) g.nodes.delete(id);
  g.edges = [
    ...g.edges.filter((e) => !removed.has(e.from.node) && !removed.has(e.to.node)),
    ...healed,
  ];
  if (removed.has(g.output)) {
    g.output = inheritedOutput ?? Array.from(g.nodes.keys()).pop() ?? '';
  }
  if (g.metadata.nodePositions) {
    const next = { ...g.metadata.nodePositions };
    for (const id of removed) delete next[id];
    g.metadata.nodePositions = next;
  }
  return g;
}

/**
 * Walk upstream from `nodeId` across removed nodes until a surviving one is
 * found, and return the port that feeds the chain. Only the primary 'in'
 * port is followed: kinds with a second input ('layer' on compositors and
 * mask combinators) have no single obvious stand-in, so the walk stops there
 * and the caller leaves that gap for the user to rewire.
 */
function survivingProducer(
  g: RenderGraph, removed: Set<string>, nodeId: string,
): { node: string; port: string } | null {
  let cur = nodeId;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const edge = g.edges.find((e) => e.to.node === cur && e.to.port === 'in');
    if (!edge) return null;
    if (!removed.has(edge.from.node)) return { ...edge.from };
    cur = edge.from.node;
  }
  return null;
}

/**
 * Bridge the gap a deletion would leave: every consumer that was fed by a
 * removed node gets re-wired to whatever fed that node, so the chain closes
 * itself instead of falling into two halves. Deleting a run of neighbours at
 * once still lands on the first surviving producer.
 *
 * The consumer's own target port is preserved, so removing a node upstream of
 * a compositor reconnects into the same input it was feeding.
 */
function healEdges(g: RenderGraph, removed: Set<string>): Edge[] {
  const healed: Edge[] = [];
  const exists = (from: { node: string; port: string }, to: { node: string; port: string }) =>
    g.edges.some((e) =>
      e.from.node === from.node && e.from.port === from.port &&
      e.to.node === to.node && e.to.port === to.port) ||
    healed.some((e) =>
      e.from.node === from.node && e.from.port === from.port &&
      e.to.node === to.node && e.to.port === to.port);

  for (const edge of g.edges) {
    // Only edges that leave the removed set and land on a survivor.
    if (!removed.has(edge.from.node) || removed.has(edge.to.node)) continue;
    const from = survivingProducer(g, removed, edge.from.node);
    if (!from || exists(from, edge.to)) continue;
    healed.push({
      id: `e:${from.node}.${from.port}→${edge.to.node}.${edge.to.port}:${g.metadata.revision + 1}`,
      from,
      to: { ...edge.to },
    });
  }
  return healed;
}

/** True iff adding an edge `from → to` would introduce a cycle. */
function introducesCycle(g: RenderGraph, fromNode: string, toNode: string): boolean {
  if (fromNode === toNode) return true;
  // Walk forward from `toNode` along edges; if we reach `fromNode` we'd loop.
  const visited = new Set<string>();
  const stack = [toNode];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === fromNode) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const edge of g.edges) {
      if (edge.from.node === cur) stack.push(edge.to.node);
    }
  }
  return false;
}

/** Build a fresh default-params object for a kind's `paramSchema`. Used by
 *  the library panel when the user drops a new node onto the canvas. */
export function defaultParamsForSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {};
  const s = schema as { type?: string; properties?: Record<string, unknown>; default?: unknown };
  if (s.type !== 'object' || !s.properties) return {};
  const out: Record<string, unknown> = {};
  for (const [key, propSchema] of Object.entries(s.properties)) {
    const p = propSchema as { default?: unknown; type?: string; properties?: unknown };
    if ('default' in p) out[key] = p.default;
    else if (p.type === 'object') out[key] = defaultParamsForSchema(p);
    else if (p.type === 'array') out[key] = [];
    else if (p.type === 'number' || p.type === 'integer') out[key] = 0;
    else if (p.type === 'boolean') out[key] = false;
    else if (p.type === 'string') out[key] = '';
  }
  return out;
}
