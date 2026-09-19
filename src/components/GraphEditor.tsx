/**
 * Phase 4 — Node-Graph Editor canvas.
 *
 * SVG-based dataflow editor. Top-down layout (see autoLayout.ts for why the
 * plan's left-to-right was dropped: the editor sits in a vertical column).
 * Pointer-events drive all interactions so touch + mouse share one code path.
 *
 * Gestures (Figma/Miro convention — empty-drag pans):
 *   - Empty-drag           → pan
 *   - Shift+empty-drag     → box-select
 *   - Middle-drag / Alt-drag → pan (legacy fallback)
 *   - Wheel / pinch        → zoom anchored to cursor
 *   - Drag node            → move (whole selection moves together)
 *   - Drag from port       → connect (output→input) or disconnect (input→empty)
 *   - Delete key           → remove selected nodes
 *   - F                    → fit graph to view
 *   - 0                    → reset zoom to 100% at origin
 *
 * Undo is NOT handled here. The document owns the history: every change goes
 * out through `onChange`, and what comes back as the `graph` prop is played
 * into the editor (see the effect below). Ctrl-Z therefore falls through to
 * the PhotoEditor's document undo, and one keypress is one document step.
 *
 * Validation: GraphValidationOverlay reports compile errors as red halos
 * around the offending node + an inline hint, and nodes that do not reach the
 * output as amber halos + a yellow line: they are left out of the render.
 * Re-runs after every mutation.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BlockedNodeGroup, Edge as GraphEdgeType, NodePosition, RenderGraph } from '../engine/graph';
import { LAYOUT_METRICS, autoLayout, blockReasonId, graphContentKey } from '../engine/graph';
import { formatBlockReason } from '../i18n/gateReasons';
import { useGraphEditor, type GraphEditorState, type GraphEditorActions } from '../hooks/useGraphEditor';
import { usePersistedState } from '../hooks/usePersistedState';
import { usePreviewTapRenderer, type PreviewMaskLayer } from '../hooks/usePreviewTapRenderer';
import { NodeLibraryPanel } from './NodeLibraryPanel';
import { NodeInspectorPanel } from './NodeInspectorPanel';
import { SelectedNodeOutputPanel } from './SelectedNodeOutputPanel';
import { GraphNode } from './GraphNode';
import { GraphEdge } from './GraphEdge';
import { GraphValidationOverlay, useGraphCompileError } from './GraphValidationOverlay';
// The same label the nodes themselves carry — the engine owns that
// transformation, so the list does not invent a second spelling.
import { nodeKindLabel } from '../engine/graph';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';

export interface GraphEditorProps {
  /**
   * The host's graph. Cloned on mount, and played back into the editor
   * whenever the host sends one that says something else — a document undo,
   * the history panel, a sync pull. Pan, zoom and selection survive it.
   */
  graph: RenderGraph;
  /** Called whenever the graph changes — host persists into the document. */
  onChange: (graph: RenderGraph) => void;
  /** Source image for preview-tap rendering. Skipped when null. */
  previewSourceUrl?: string | null;
  /**
   * The photo's 16-bit pixels, when it has them. A RAW document's graph
   * carries a raw16 source node, which takes these and not the display JPEG.
   */
  previewRawPixels?: RawPixelData | null;
  /**
   * Rasterized-mask inputs for the layered graph's `mask:<layerId>` source
   * nodes. The shapes live in the document, so the host has to hand them in.
   */
  previewMaskLayers?: readonly PreviewMaskLayer[];
  /** Rebuilds the default graph from the current adjustments. */
  onReset?: () => void;
  /**
   * What stands in the way of writing this graph back as a document, one
   * entry per node — the gate of step 3. Empty (the default) means the way
   * back to the classic view is open.
   */
  blocked?: readonly BlockedNodeGroup[];
}

export function GraphEditor({ graph: hostGraph, onChange, previewSourceUrl, previewRawPixels, previewMaskLayers, onReset, blocked = [] }: GraphEditorProps) {
  const { t } = useTranslation();
  const [state, actions] = useGraphEditor(hostGraph);
  const { graph, selection } = state;

  // Push every mutation upstream. Effect avoids feedback loops by checking
  // revision — the host only sees post-mutate revisions.
  const lastEmittedRevision = useRef(graph.metadata.revision);
  useEffect(() => {
    if (graph.metadata.revision !== lastEmittedRevision.current) {
      lastEmittedRevision.current = graph.metadata.revision;
      onChange(graph);
    }
  }, [graph, onChange]);

  /**
   * The other direction: a graph the host changed without us.
   *
   * Only the prop is a dependency, so the effect does not run on our own
   * mutations — in that commit the prop is still the older object and
   * adopting it would undo the edit that just happened. What the host echoes
   * back after `onChange` is the same content, and the content check makes
   * that a no-op; a real document step (undo, history panel, sync) differs
   * and is adopted.
   */
  const liveGraphRef = useRef(graph);
  liveGraphRef.current = graph;
  useEffect(() => {
    if (hostGraph === liveGraphRef.current) return;
    if (graphContentKey(hostGraph) === graphContentKey(liveGraphRef.current)) return;
    actions.setGraph(hostGraph);
  }, [hostGraph, actions]);

  // ─── Pan / Zoom ────────────────────────────────────────────────
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  // ─── Pointer interaction state ──────────────────────────────────
  const [drag, setDrag] = useState<DragState | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Multi-pointer tracking for pinch-zoom + two-finger-pan (touch).
  // Pointer ID → last known client coords.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStateRef = useRef<{ dist: number; mid: { x: number; y: number }; pan: { x: number; y: number }; zoom: number } | null>(null);

  // ─── Auto-layout: filled in once on mount for missing positions ─
  const positions = useMemo(() => autoLayout(graph), [graph]);

  // Render-side positions with the transient node-drag offset applied.
  // Dragging stays local state; the graph (and undo history) get ONE
  // moveNodes commit on pointerup instead of one per pointermove.
  const displayPositions = useMemo(() => {
    if (drag?.kind !== 'nodes' || !drag.offset) return positions;
    const out: Record<string, NodePosition> = { ...positions };
    for (const id of drag.movingIds) {
      const s = drag.startPos.get(id) ?? { x: 0, y: 0 };
      out[id] = { x: s.x + drag.offset.dx, y: s.y + drag.offset.dy };
    }
    return out;
  }, [positions, drag]);

  // Per-preview-tap thumbnails (rendered through the worker pipeline).
  const previewThumbs = usePreviewTapRenderer(
    graph, previewSourceUrl ?? null, previewMaskLayers, previewRawPixels ?? null);

  // ─── Clipboard (in-app, not OS clipboard — avoids leaking nodes) ──
  const clipboardRef = useRef<{ nodes: { id: string; kind: string; params: unknown; position: NodePosition }[]; edges: { fromIdx: number; fromPort: string; toIdx: number; toPort: string }[] } | null>(null);

  const copySelection = useCallback(() => {
    if (selection.size === 0) return;
    const ids = Array.from(selection);
    const idToIdx = new Map(ids.map((id, i) => [id, i]));
    const nodes = ids.map((id) => {
      const n = graph.nodes.get(id)!;
      return { id: n.id, kind: n.kind, params: n.params, position: positions[id] ?? { x: 0, y: 0 } };
    });
    // Preserve edges fully inside the selection; index-based so the
    // paste round-trip keeps the subgraph wired even after id-rewrite.
    const edges = graph.edges
      .filter((e) => idToIdx.has(e.from.node) && idToIdx.has(e.to.node))
      .map((e) => ({
        fromIdx: idToIdx.get(e.from.node)!, fromPort: e.from.port,
        toIdx: idToIdx.get(e.to.node)!, toPort: e.to.port,
      }));
    clipboardRef.current = { nodes, edges };
  }, [graph, positions, selection]);

  const paste = useCallback(() => {
    const clip = clipboardRef.current;
    if (!clip || clip.nodes.length === 0) return;
    const newIds: string[] = [];
    const PASTE_OFFSET = 24;
    // Insert all nodes first (id-rewrite); then wire edges using newIds[].
    for (const n of clip.nodes) {
      const newId = `${n.kind}:${Math.random().toString(36).slice(2, 10)}`;
      newIds.push(newId);
      actions.addNode(
        { id: newId, kind: n.kind, params: n.params },
        { x: n.position.x + PASTE_OFFSET, y: n.position.y + PASTE_OFFSET },
      );
    }
    for (const e of clip.edges) {
      try { actions.connect(newIds[e.fromIdx], e.fromPort, newIds[e.toIdx], e.toPort); }
      catch { /* swallow — partial paste is OK */ }
    }
    actions.setSelection(new Set(newIds));
  }, [actions]);

  // ─── View commands (toolbar + shortcuts) ───────────────────────
  const zoomAtViewportCenter = useCallback((factor: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = rect.width / 2, cy = rect.height / 2;
    const newZoom = Math.max(0.25, Math.min(3, zoom * factor));
    setPan((p) => ({
      x: cx - (cx - p.x) * (newZoom / zoom),
      y: cy - (cy - p.y) * (newZoom / zoom),
    }));
    setZoom(newZoom);
  }, [zoom]);

  const fitToView = useCallback(() => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || graph.nodes.size === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of graph.nodes.keys()) {
      const p = positions[id]; if (!p) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + LAYOUT_METRICS.NODE_WIDTH);
      maxY = Math.max(maxY, p.y + LAYOUT_METRICS.NODE_HEIGHT);
    }
    if (!Number.isFinite(minX)) return;
    const PADDING = 40;
    const contentW = (maxX - minX) + PADDING * 2;
    const contentH = (maxY - minY) + PADDING * 2;
    const newZoom = Math.max(0.25, Math.min(1, Math.min(rect.width / contentW, rect.height / contentH)));
    setZoom(newZoom);
    setPan({
      x: (rect.width - (maxX - minX) * newZoom) / 2 - minX * newZoom,
      y: (rect.height - (maxY - minY) * newZoom) / 2 - minY * newZoom,
    });
  }, [graph.nodes, positions]);

  /**
   * Put one node in the middle of the canvas and select it — what the gate
   * list does on click. The zoom is left alone: the user picked it, and a
   * jump that also rescales the view loses them more than it helps.
   */
  const focusNode = useCallback((nodeId: string) => {
    actions.select(nodeId);
    const rect = svgRef.current?.getBoundingClientRect();
    const p = positions[nodeId];
    if (!rect || !p) return;
    setPan({
      x: rect.width / 2 - (p.x + LAYOUT_METRICS.NODE_WIDTH / 2) * zoom,
      y: rect.height / 2 - (p.y + LAYOUT_METRICS.NODE_HEIGHT / 2) * zoom,
    });
  }, [actions, positions, zoom]);

  const resetView = useCallback(() => {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, []);

  // ─── Keyboard ───────────────────────────────────────────────────
  useEffect(() => {
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLTextAreaElement) return;
      const meta = ev.ctrlKey || ev.metaKey;
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (selection.size > 0) {
          actions.removeNodes(selection);
          ev.preventDefault();
        }
      } else if (meta && ev.key.toLowerCase() === 'c') {
        copySelection();
        ev.preventDefault();
      } else if (meta && ev.key.toLowerCase() === 'v') {
        paste();
        ev.preventDefault();
      } else if (meta && ev.key.toLowerCase() === 'd') {
        // Ctrl/Cmd-D = duplicate = copy + immediate paste.
        copySelection();
        paste();
        ev.preventDefault();
      } else if (ev.key === 'Escape') {
        actions.select(null);
      } else if (!meta && ev.key.toLowerCase() === 'f') {
        fitToView();
        ev.preventDefault();
      } else if (!meta && ev.key === '0') {
        resetView();
        ev.preventDefault();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions, copySelection, fitToView, paste, resetView, selection]);

  // ─── Coordinate transform ──────────────────────────────────────
  const screenToCanvas = useCallback((sx: number, sy: number): NodePosition => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (sx - rect.left - pan.x) / zoom, y: (sy - rect.top - pan.y) / zoom };
  }, [pan, zoom]);

  // ─── Pointer handlers ──────────────────────────────────────────
  const onPointerDown = useCallback((ev: React.PointerEvent<SVGSVGElement>) => {
    // Track every active pointer so we can detect 2-finger pinches.
    pointersRef.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointersRef.current.size === 2) {
      // Initialise pinch reference frame; cancels any single-pointer drag.
      const pts = Array.from(pointersRef.current.values());
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      pinchStateRef.current = { dist, mid, pan, zoom };
      setDrag(null);
      ev.preventDefault();
      return;
    }
    const target = ev.target as Element;
    const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
    const portInfo = target.closest('[data-port-id]');
    const portKind = portInfo?.getAttribute('data-port-kind') as 'in' | 'out' | undefined;
    const portId = portInfo?.getAttribute('data-port-id') ?? undefined;

    const canvasPt = screenToCanvas(ev.clientX, ev.clientY);

    if (nodeId && portInfo && portKind && portId) {
      // Start edge-drag from this port.
      setDrag({
        kind: 'edge',
        from: { nodeId, portId, portKind },
        cursor: canvasPt,
      });
      ev.currentTarget.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }

    if (nodeId) {
      // Node selection + node-drag.
      const inSelection = selection.has(nodeId);
      if (!inSelection && !ev.shiftKey) actions.select(nodeId);
      else if (ev.shiftKey) actions.selectAdd(nodeId);
      const movingIds = ev.shiftKey || inSelection ? new Set(selection).add(nodeId) : new Set([nodeId]);
      const startPos = new Map<string, NodePosition>();
      for (const id of movingIds) startPos.set(id, positions[id] ?? { x: 0, y: 0 });
      setDrag({ kind: 'nodes', movingIds, startPos, startCursor: canvasPt });
      ev.currentTarget.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }

    if (ev.button === 1 || ev.altKey) {
      // Middle-click or alt-drag = pan (legacy fallback).
      setDrag({ kind: 'pan', startPan: pan, startCursor: { x: ev.clientX, y: ev.clientY } });
      ev.currentTarget.setPointerCapture(ev.pointerId);
      ev.preventDefault();
      return;
    }

    if (ev.shiftKey) {
      // Shift + empty-drag = box-select (Figma convention).
      setDrag({ kind: 'box', start: canvasPt, end: canvasPt });
      ev.currentTarget.setPointerCapture(ev.pointerId);
      return;
    }

    // Plain empty-drag = pan. Clear selection on tap (no drag).
    setDrag({ kind: 'pan', startPan: pan, startCursor: { x: ev.clientX, y: ev.clientY }, didMove: false });
    if (selection.size > 0) actions.select(null);
    ev.currentTarget.setPointerCapture(ev.pointerId);
  }, [actions, pan, positions, screenToCanvas, selection, zoom]);

  const onPointerMove = useCallback((ev: React.PointerEvent<SVGSVGElement>) => {
    // Update tracked pointer position; handle pinch first when active.
    if (pointersRef.current.has(ev.pointerId)) {
      pointersRef.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    }
    if (pinchStateRef.current && pointersRef.current.size >= 2) {
      const pts = Array.from(pointersRef.current.values()).slice(0, 2);
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const startState = pinchStateRef.current;
      const scale = dist / Math.max(1, startState.dist);
      const newZoom = Math.max(0.25, Math.min(3, startState.zoom * scale));
      const rect = svgRef.current?.getBoundingClientRect();
      if (rect) {
        // Anchor the zoom at the midpoint of the two fingers + add the
        // midpoint drift since pinch-start as a pan delta.
        const cx = startState.mid.x - rect.left;
        const cy = startState.mid.y - rect.top;
        const dx = mid.x - startState.mid.x;
        const dy = mid.y - startState.mid.y;
        setPan({
          x: cx - (cx - startState.pan.x) * (newZoom / startState.zoom) + dx,
          y: cy - (cy - startState.pan.y) * (newZoom / startState.zoom) + dy,
        });
        setZoom(newZoom);
      }
      ev.preventDefault();
      return;
    }
    if (!drag) return;
    if (drag.kind === 'pan') {
      const dx = ev.clientX - drag.startCursor.x;
      const dy = ev.clientY - drag.startCursor.y;
      setPan({ x: drag.startPan.x + dx, y: drag.startPan.y + dy });
      if (!drag.didMove && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        setDrag({ ...drag, didMove: true });
      }
      return;
    }
    const canvasPt = screenToCanvas(ev.clientX, ev.clientY);
    if (drag.kind === 'nodes') {
      // Transient: positions render from displayPositions; the single
      // moveNodes (= one undo entry, one onChange) happens on pointerup.
      const dx = canvasPt.x - drag.startCursor.x;
      const dy = canvasPt.y - drag.startCursor.y;
      setDrag({ ...drag, offset: { dx, dy } });
      return;
    }
    if (drag.kind === 'edge') {
      setDrag({ ...drag, cursor: canvasPt });
      return;
    }
    if (drag.kind === 'box') {
      setDrag({ ...drag, end: canvasPt });
      const { start, end } = { ...drag, end: canvasPt };
      const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x);
      const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y);
      const inBox = new Set<string>();
      for (const [id] of graph.nodes) {
        const p = positions[id]; if (!p) continue;
        if (p.x >= minX - LAYOUT_METRICS.NODE_WIDTH && p.x <= maxX
            && p.y >= minY - LAYOUT_METRICS.NODE_HEIGHT && p.y <= maxY) {
          inBox.add(id);
        }
      }
      actions.setSelection(inBox);
    }
  }, [actions, drag, graph.nodes, positions, screenToCanvas]);

  const onPointerUp = useCallback((ev: React.PointerEvent<SVGSVGElement>) => {
    // Release tracking and end pinch if either finger came up.
    pointersRef.current.delete(ev.pointerId);
    if (pinchStateRef.current && pointersRef.current.size < 2) {
      pinchStateRef.current = null;
      ev.currentTarget.releasePointerCapture(ev.pointerId);
      return;
    }
    if (!drag) return;
    if (drag.kind === 'nodes' && drag.offset && (drag.offset.dx !== 0 || drag.offset.dy !== 0)) {
      const deltas = new Map<string, NodePosition>();
      for (const [id, start] of drag.startPos) {
        deltas.set(id, { x: start.x + drag.offset.dx, y: start.y + drag.offset.dy });
      }
      actions.moveNodes(deltas);
    }
    if (drag.kind === 'edge') {
      // Drop onto another port? The pointer is captured by the canvas for the
      // whole drag, so `ev.target` is the canvas, never the port under the
      // cursor - the hit test has to come from the coordinates.
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const dropPort = target?.closest('[data-port-id]') ?? null;
      const dropNode = target?.closest('[data-node-id]')?.getAttribute('data-node-id');
      const dropPortKind = dropPort?.getAttribute('data-port-kind') as 'in' | 'out' | undefined;
      const dropPortId = dropPort?.getAttribute('data-port-id') ?? undefined;
      if (dropNode && dropPortKind && dropPortId && dropPortKind !== drag.from.portKind) {
        try {
          if (drag.from.portKind === 'out') {
            actions.connect(drag.from.nodeId, drag.from.portId, dropNode, dropPortId);
          } else {
            actions.connect(dropNode, dropPortId, drag.from.nodeId, drag.from.portId);
          }
        } catch (e) {
          console.warn('[GraphEditor] connect rejected:', e instanceof Error ? e.message : e);
        }
      } else if (!dropPort && drag.from.portKind === 'in') {
        // Drop on empty space from an input port → disconnect any edge feeding it.
        const incoming = graph.edges.find((e) =>
          e.to.node === drag.from.nodeId && e.to.port === drag.from.portId,
        );
        if (incoming) actions.removeEdge(incoming.id);
      }
    }
    ev.currentTarget.releasePointerCapture(ev.pointerId);
    setDrag(null);
  }, [actions, drag, graph.edges]);

  // Native non-passive listener: React attaches JSX onWheel passively at the
  // root, so ev.preventDefault() there is a no-op and the browser would
  // scroll/zoom the page alongside the canvas zoom.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handler = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      const newZoom = Math.max(0.25, Math.min(3, zoom * factor));
      // Zoom around the cursor.
      setPan((p) => ({
        x: cx - (cx - p.x) * (newZoom / zoom),
        y: cy - (cy - p.y) * (newZoom / zoom),
      }));
      setZoom(newZoom);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [zoom]);

  // ─── Drop from library panel ───────────────────────────────────
  const onCanvasDrop = useCallback((ev: React.DragEvent<HTMLDivElement>) => {
    ev.preventDefault();
    const json = ev.dataTransfer.getData('application/x-graph-node');
    if (!json) return;
    try {
      const newNode = JSON.parse(json) as { id: string; kind: string; params: unknown };
      const pos = screenToCanvas(ev.clientX, ev.clientY);
      actions.addNode(newNode, pos);
    } catch { /* malformed */ }
  }, [actions, screenToCanvas]);

  const onCanvasDragOver = useCallback((ev: React.DragEvent<HTMLDivElement>) => {
    if (ev.dataTransfer.types.includes('application/x-graph-node')) ev.preventDefault();
  }, []);

  // ─── Render ────────────────────────────────────────────────────
  const selectedNodeId = selection.size === 1 ? Array.from(selection)[0] : null;
  const selectedNode = selectedNodeId ? graph.nodes.get(selectedNodeId) ?? null : null;

  // Sidebar visibility — collapsible to give the canvas more room. Persisted
  // in localStorage so the user's choice survives editor remounts.
  const [libraryOpen, setLibraryOpen] = usePersistedState('graph-library-open', true);
  const [inspectorOpen, setInspectorOpen] = usePersistedState('graph-inspector-open', true);
  const [outputOpen, setOutputOpen] = usePersistedState('graph-output-open', true);

  // The compiler's verdict, computed once here and handed to the overlay.
  // The message used to be drawn inside the overlay at bottom-left, where the
  // shortcut hint sat on top of it; both now live in the one stacked column
  // below.
  const { error: compileError, dropped } = useGraphCompileError(graph);

  // Auto-fit once on mount so the graph appears centred regardless of the
  // viewport size (Settings-dialog vs. full-screen editor). RAF deferral
  // gives the SVG a layout pass first so getBoundingClientRect is sane.
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (didInitialFit.current) return;
    if (graph.nodes.size === 0) return;
    didInitialFit.current = true;
    const handle = requestAnimationFrame(() => fitToView());
    return () => cancelAnimationFrame(handle);
  }, [fitToView, graph.nodes.size]);

  return (
    <div
      className="graph-editor"
      style={{
        // ps-canvas (host) is position: relative — fill it absolutely so
        // child flex panels get a concrete height to scroll inside.
        position: 'absolute', inset: 0,
        display: 'flex', minHeight: 0,
      }}
    >
      {libraryOpen ? <NodeLibraryPanel /> : null}
      {inspectorOpen ? (
        <NodeInspectorPanel
          variant="rail"
          railSide="left"
          node={selectedNode}
          onParamsChange={(params) => selectedNodeId && actions.setNodeParams(selectedNodeId, params)}
          onDelete={selectedNodeId ? () => actions.removeNodes([selectedNodeId]) : undefined}
        />
      ) : null}
      <div
        className="graph-editor-canvas"
        style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--bg-canvas, #1a1a1a)' }}
        onDrop={onCanvasDrop}
        onDragOver={onCanvasDragOver}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          style={{
            display: 'block', touchAction: 'none',
            cursor: drag?.kind === 'pan' ? 'grabbing' : drag?.kind === 'box' ? 'crosshair' : 'grab',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            {/* Edges first (behind nodes) */}
            {graph.edges.map((edge) => (
              <GraphEdge key={edge.id} edge={edge} positions={displayPositions} graph={graph} />
            ))}
            {/* In-flight edge during drag */}
            {drag?.kind === 'edge' && (
              <DraftEdge from={drag.from} positions={displayPositions} cursor={drag.cursor} />
            )}
            {/* Nodes */}
            {Array.from(graph.nodes.values()).map((node) => (
              <GraphNode
                key={node.id}
                node={node}
                position={displayPositions[node.id] ?? { x: 0, y: 0 }}
                selected={selection.has(node.id)}
                previewUrl={previewThumbs.get(node.id)}
              />
            ))}
            {/* Box-select rubber band */}
            {drag?.kind === 'box' && (() => {
              const { start, end } = drag;
              const x = Math.min(start.x, end.x), y = Math.min(start.y, end.y);
              const w = Math.abs(end.x - start.x), h = Math.abs(end.y - start.y);
              return <rect x={x} y={y} width={w} height={h} fill="rgba(74,158,255,0.1)" stroke="rgba(74,158,255,0.5)" strokeWidth={1 / zoom} />;
            })()}
          </g>
        </svg>
        <GraphValidationOverlay
          graph={graph} positions={displayPositions} pan={pan} zoom={zoom} blocked={blocked}
          error={compileError} dropped={dropped}
        />

        {/* View toolbar (top-right). Hover-tooltips spell out the shortcut. */}
        <div style={{
          position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4,
          padding: 4, borderRadius: 6, background: 'rgba(0,0,0,0.55)',
          backdropFilter: 'blur(4px)',
        }}>
          <ToolbarBtn testId="library" title={t('graphEditor.toolbar.library')} onClick={() => setLibraryOpen((v) => !v)} active={libraryOpen}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="5" height="12" rx="1" /><path d="M9 4h5M9 8h5M9 12h3" /></svg>
          </ToolbarBtn>
          <div style={{ width: 1, background: 'rgba(255,255,255,0.1)', margin: '2px 2px' }} />
          <ToolbarBtn testId="zoom-out" title={t('graphEditor.toolbar.zoomOut')} onClick={() => zoomAtViewportCenter(1 / 1.2)}>−</ToolbarBtn>
          <ToolbarBtn testId="fit" title={t('graphEditor.toolbar.fitToView')} onClick={fitToView}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" /></svg>
          </ToolbarBtn>
          <ToolbarBtn testId="actual-size" title={t('graphEditor.toolbar.actualSize')} onClick={resetView}>1:1</ToolbarBtn>
          <ToolbarBtn testId="zoom-in" title={t('graphEditor.toolbar.zoomIn')} onClick={() => zoomAtViewportCenter(1.2)}>+</ToolbarBtn>
          <div style={{ width: 1, background: 'rgba(255,255,255,0.1)', margin: '2px 2px' }} />
          <ToolbarBtn testId="inspector" title={t('graphEditor.toolbar.inspector')} onClick={() => setInspectorOpen((v) => !v)} active={inspectorOpen}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="5" height="12" rx="1" /><path d="M9 4h5M9 8h5M11 12h3" /></svg>
          </ToolbarBtn>
          {onReset && (
            <ToolbarBtn
              testId="reset"
              title={t('graphEditor.toolbar.reset')}
              onClick={() => {
                if (window.confirm(t('graphEditor.toolbar.resetConfirm'))) onReset();
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 7a5 5 0 105-5 5 5 0 00-3.5 1.5L2 5" />
                <path d="M2 2v3h3" />
              </svg>
            </ToolbarBtn>
          )}
          <ToolbarBtn testId="output" title={t('graphEditor.toolbar.output')} onClick={() => setOutputOpen((v) => !v)} active={outputOpen}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="2" width="5" height="12" rx="1" /><path d="M11 6v6M9.5 8v4M12.5 10v2" /></svg>
          </ToolbarBtn>
        </div>

        {/* Status + shortcut hint (bottom). */}
        <div style={{
          position: 'absolute', bottom: 8, right: 8,
          padding: '4px 8px', borderRadius: 4, fontSize: 11, color: 'var(--text-tertiary, #888)',
          background: 'rgba(0,0,0,0.4)', pointerEvents: 'none',
        }}>
          {Math.round(zoom * 100)}% · {t('graphEditor.status.nodes', { count: graph.nodes.size })} · {t('graphEditor.status.edges', { count: graph.edges.length })}
        </div>
        {/* One stacked column at bottom-left, so nothing covers anything:
            what is in the way, then the compile error, then the shortcuts. */}
        <div style={{
          position: 'absolute', bottom: 8, left: 8, right: 336,
          display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6,
          pointerEvents: 'none',
        }}>
          {blocked.length > 0 && (
            <div data-gate-list={blocked.length} style={{
              // Only the entries take the pointer. The panel sits over the
              // canvas, and swallowing clicks on the nodes underneath it
              // would make the list get in the way of fixing what it
              // complains about.
              pointerEvents: 'none', maxWidth: 420, maxHeight: '40%', overflowY: 'auto',
              padding: 8, borderRadius: 6,
              background: 'rgba(0,0,0,0.72)', border: '1px solid var(--gate-blocked, #9b59b6)',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: 'var(--gate-blocked, #9b59b6)',
              }}>
                {t('graphEditor.blocked.title', { count: blocked.length })}
              </div>
              {blocked.map(({ nodeId, reasons }) => (
                <button
                  key={nodeId}
                  type="button"
                  data-gate-entry={nodeId}
                  onClick={() => focusNode(nodeId)}
                  title={t('graphEditor.blocked.jumpTo', { nodeId })}
                  style={{
                    pointerEvents: 'auto',
                    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    padding: '4px 6px', borderRadius: 4,
                    border: 'none', background: 'rgba(255,255,255,0.06)',
                    color: 'var(--text-secondary, #999)', fontSize: 11, lineHeight: 1.4,
                  }}
                >
                  {/* Name on its own line, reasons under it. Several reasons
                      start with the node's own name, and inline they would
                      read as a stutter. */}
                  <span style={{ display: 'block', color: 'var(--text-primary, #e0e0e0)' }}>
                    {nodeKindLabel(graph.nodes.get(nodeId)?.kind ?? nodeId)}
                  </span>
                  {reasons.map((reason) => (
                    <span key={blockReasonId(reason)} style={{ display: 'block' }}>
                      {formatBlockReason(reason, t)}
                    </span>
                  ))}
                </button>
              ))}
            </div>
          )}
          {compileError && (
            <div style={{
              padding: '6px 10px', borderRadius: 4,
              background: 'rgba(231,76,60,0.85)', color: '#fff',
              fontSize: 11, lineHeight: 1.4,
            }}>
              ⚠ {compileError.message}
            </div>
          )}
          {dropped.length > 0 && (
            <div data-dropped-warning={dropped.length} style={{
              padding: '6px 10px', borderRadius: 4,
              background: 'rgba(241,196,15,0.85)', color: '#1a1a1a',
              fontSize: 11, lineHeight: 1.4,
            }}>
              {t('graphEditor.dropped', { count: dropped.length })}
            </div>
          )}
          <div style={{
            padding: '4px 8px', borderRadius: 4, fontSize: 10, color: 'var(--text-tertiary, #888)',
            background: 'rgba(0,0,0,0.4)', lineHeight: 1.4,
          }}>
            Pan: Drag · Box-Select: Shift+Drag · Zoom: Wheel · Fit: F · 1:1: 0
          </div>
        </div>

      </div>
      {outputOpen ? (
        <SelectedNodeOutputPanel
          graph={graph}
          node={selectedNode}
          sourceUrl={previewSourceUrl}
          rawPixels={previewRawPixels}
          maskLayers={previewMaskLayers}
        />
      ) : null}
    </div>
  );
}

function ToolbarBtn({
  children, onClick, title, testId, active = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  /** Locale-free handle for scripts; the title follows the UI language. */
  testId: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      data-testid={`graph-toolbar-${testId}`}
      onClick={onClick}
      style={{
        minWidth: 26, height: 24, padding: '0 6px', fontSize: 11,
        background: active ? 'rgba(74,158,255,0.25)' : 'transparent',
        color: active ? '#fff' : 'var(--text-secondary, #ccc)',
        border: 'none', borderRadius: 3, cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseEnter={(ev) => { if (!active) (ev.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)'; }}
      onMouseLeave={(ev) => { if (!active) (ev.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
    >{children}</button>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────

type DragState =
  | { kind: 'nodes'; movingIds: Set<string>; startPos: Map<string, NodePosition>; startCursor: NodePosition; offset?: { dx: number; dy: number } }
  | { kind: 'edge'; from: { nodeId: string; portId: string; portKind: 'in' | 'out' }; cursor: NodePosition }
  | { kind: 'pan'; startPan: { x: number; y: number }; startCursor: { x: number; y: number }; didMove?: boolean }
  | { kind: 'box'; start: NodePosition; end: NodePosition };

function DraftEdge({
  from, positions, cursor,
}: {
  from: { nodeId: string; portId: string; portKind: 'in' | 'out' };
  positions: Record<string, NodePosition>;
  cursor: NodePosition;
}) {
  // Top-down convention: outputs sit on the bottom edge, inputs on the top.
  // Vertically-anchored bezier control points so the draft curve mirrors
  // the eventual GraphEdge geometry.
  const nodePos = positions[from.nodeId] ?? { x: 0, y: 0 };
  const portX = nodePos.x + LAYOUT_METRICS.NODE_WIDTH / 2;
  const portY = nodePos.y + (from.portKind === 'out' ? LAYOUT_METRICS.NODE_HEIGHT : 0);
  const sx = portX, sy = portY;
  const tx = cursor.x, ty = cursor.y;
  const cy = (sy + ty) / 2;
  const d = `M ${sx} ${sy} C ${sx} ${cy}, ${tx} ${cy}, ${tx} ${ty}`;
  return (
    <path d={d} stroke="rgba(74,158,255,0.7)" strokeWidth={2} fill="none" strokeDasharray="4 3" pointerEvents="none" />
  );
}

// Re-export hook types so other modules can import everything from here.
export type { GraphEditorState, GraphEditorActions };
export type Edge = GraphEdgeType;
