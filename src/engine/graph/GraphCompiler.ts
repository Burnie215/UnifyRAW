import type {
  CompiledPlan,
  ColorSpace,
  Edge,
  FboBinding,
  FboFormat,
  Geometry,
  NodeKindSpec,
  RenderGraph,
  RenderNode,
  SegmentSpec,
} from './types';
import { readColorSpaceOverride } from './types';
import type { NodeRegistry } from './NodeRegistry';
import {
  pickConvertKind,
  KIND_CONVERT_LIN_TO_GAMMA,
  KIND_CONVERT_GAMMA_TO_LIN,
  KIND_TAP,
} from './builtins';

export interface CompileOptions {
  /**
   * Request a captured snapshot after each named node. Compiler synthesises
   * a Tap node downstream of each — labels become CompiledPlan.taps keys
   * the executor exposes to external readers (Histogram, preCurveCanvas).
   */
  captureAfter?: ReadonlyArray<{ nodeId: string; label: string }>;
  /** Keep the terminal output at this precision. RGBA16F is propagated back
   * through every color path contributing to the output so an earlier layer
   * or compositor boundary cannot quantize the result first. Omitted keeps
   * preview and thumbnail compilation byte-for-byte compatible. */
  terminalFormat?: FboFormat;
}

/**
 * Compiles a RenderGraph into a CompiledPlan the executor can run.
 *
 * Phase 0 pipeline:
 *   1. resolveEdges       — index incoming/outgoing per node, catch dangling refs
 *   2. earlyValidate      — port existence, type match, multiplicity
 *                           (color-space mismatch left for convert insertion)
 *   3. topologicalOrder   — Kahn, deterministic tie-break by id
 *   4. resolveSpaces      — pin every node's effective input/output space
 *                           (resolves 'either' against neighbors)
 *   5. insertConverts     — synthesise convert nodes at space boundaries
 *                           (emits augmented graph)
 *   6. propagateGeometry  — walk augmented graph, transform geometries
 *   7. identitySkips      — pre-pass for runtime skip-list
 *   8. buildSegments      — group augmented order into RGBA8/RGBA16F segments
 *   9. assignFbos         — ping-pong pool index per node within its segment
 *  10. taps + async       — placeholders for Phase 0 (filled in next subtasks)
 */
export class GraphCompiler {
  private readonly registry: NodeRegistry;

  constructor(registry: NodeRegistry) {
    this.registry = registry;
  }

  async compile(graph: RenderGraph, options?: CompileOptions): Promise<CompiledPlan> {
    return this.compileSync(graph, options);
  }

  /**
   * Synchronous validation for UI feedback (GraphValidationOverlay): runs
   * the full compile pipeline (it is synchronous throughout — async node
   * prepare() promises are only CREATED here, not awaited) and reports the
   * first CompileError instead of throwing.
   */
  validate(graph: RenderGraph): CompileError | null {
    try {
      this.compileSync(graph);
      return null;
    } catch (e) {
      if (e instanceof CompileError) return e;
      throw e;
    }
  }

  private compileSync(graph: RenderGraph, options?: CompileOptions): CompiledPlan {
    if (!graph.nodes.has(graph.output)) {
      throw new CompileError(`output node '${graph.output}' is not in the graph`);
    }

    const resolved = resolveEdges(graph);
    // Topo-sort first so cycles are reported before downstream validation
    // would mask them with secondary errors (e.g. multiplicity on a node
    // that receives a back-edge).
    const orderOriginal = topologicalOrder(graph.nodes, resolved);
    earlyValidate(graph, resolved, this.registry);

    const spaces = resolveSpaces(graph, orderOriginal, resolved, this.registry);

    const afterConverts = insertConverts(graph, spaces, this.registry);
    const afterTaps = insertTaps(afterConverts.graph, options?.captureAfter ?? [], this.registry);

    // After insertion every edge is space-aligned; sanity-check it and use the
    // fully-augmented topology from here on.
    const augResolved = resolveEdges(afterTaps.graph);
    const augOrder = topologicalOrder(afterTaps.graph.nodes, augResolved);
    lateValidateSpaces(afterTaps.graph, this.registry);

    const geometries = propagateGeometry(afterTaps.graph, augOrder, augResolved, this.registry);
    const outputGeom = geometries.get(graph.output);
    if (!outputGeom) {
      throw new CompileError(`output node '${graph.output}' has no resolved geometry`);
    }

    const identitySkips = computeIdentitySkips(afterTaps.graph, this.registry);
    const segments = buildSegments(afterTaps.graph, augOrder, geometries, this.registry);
    const terminalFormat = options?.terminalFormat;
    if (terminalFormat) applyTerminalFormat(
      afterTaps.graph, afterTaps.graph.output, segments, terminalFormat, this.registry,
    );
    const perNodeFbo = assignFbos(segments);

    const asyncDependencies = invokeAsyncPrepare(
      afterTaps.graph, augOrder, augResolved, geometries, this.registry,
    );

    return {
      graphId: graph.id,
      graphRevision: graph.metadata.revision,
      augmentedNodes: afterTaps.graph.nodes,
      augmentedEdges: afterTaps.graph.edges,
      output: afterTaps.graph.output,
      terminalFormat,
      topologicalOrder: augOrder,
      perNodeFbo,
      insertedConverts: afterConverts.insertedConverts,
      insertedTaps: afterTaps.insertedTapEdges,
      taps: afterTaps.taps,
      identitySkips,
      segments,
      asyncDependencies,
    };
  }
}

// ─── Errors ───────────────────────────────────────────────────────

export class CompileError extends Error {
  readonly nodeIds?: readonly string[];

  constructor(message: string, nodeIds?: readonly string[]) {
    super(message);
    this.name = 'CompileError';
    this.nodeIds = nodeIds;
  }
}

// ─── Edge resolution ──────────────────────────────────────────────

interface ResolvedEdges {
  incoming: Map<string, Edge[]>;
  outgoing: Map<string, Edge[]>;
}

function resolveEdges(graph: RenderGraph): ResolvedEdges {
  const incoming = new Map<string, Edge[]>();
  const outgoing = new Map<string, Edge[]>();
  for (const id of graph.nodes.keys()) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.from.node)) {
      throw new CompileError(`edge '${edge.id}' refers to missing source node '${edge.from.node}'`, [edge.from.node]);
    }
    if (!graph.nodes.has(edge.to.node)) {
      throw new CompileError(`edge '${edge.id}' refers to missing target node '${edge.to.node}'`, [edge.to.node]);
    }
    outgoing.get(edge.from.node)!.push(edge);
    incoming.get(edge.to.node)!.push(edge);
  }
  return { incoming, outgoing };
}

// ─── Topological sort ─────────────────────────────────────────────

function topologicalOrder(nodes: Map<string, RenderNode>, resolved: ResolvedEdges): string[] {
  const inDegree = new Map<string, number>();
  for (const [id, edges] of resolved.incoming) inDegree.set(id, edges.length);

  const ready: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) ready.push(id);
  ready.sort();

  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const edge of resolved.outgoing.get(id) ?? []) {
      const next = inDegree.get(edge.to.node)! - 1;
      inDegree.set(edge.to.node, next);
      if (next === 0) insertSorted(ready, edge.to.node);
    }
  }

  if (order.length !== nodes.size) {
    const stuck = Array.from(inDegree.entries()).filter(([, d]) => d > 0).map(([id]) => id);
    throw new CompileError(`cycle detected involving nodes: ${stuck.join(', ')}`, stuck);
  }
  return order;
}

function insertSorted(arr: string[], value: string): void {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1; else hi = mid;
  }
  arr.splice(lo, 0, value);
}

// ─── Early validation (port + type + multiplicity) ────────────────

function earlyValidate(graph: RenderGraph, resolved: ResolvedEdges, registry: NodeRegistry): void {
  for (const edge of graph.edges) {
    const fromKind = registry.require(graph.nodes.get(edge.from.node)!.kind);
    const toKind = registry.require(graph.nodes.get(edge.to.node)!.kind);

    const fromPort = fromKind.outputPorts.find((p) => p.id === edge.from.port);
    if (!fromPort) {
      throw new CompileError(
        `edge '${edge.id}': kind '${fromKind.kind}' has no output port '${edge.from.port}'`,
        [edge.from.node],
      );
    }
    const toPort = toKind.inputPorts.find((p) => p.id === edge.to.port);
    if (!toPort) {
      throw new CompileError(
        `edge '${edge.id}': kind '${toKind.kind}' has no input port '${edge.to.port}'`,
        [edge.to.node],
      );
    }
    if (fromPort.type !== toPort.type) {
      throw new CompileError(
        `edge '${edge.id}': type mismatch '${fromPort.type}' -> '${toPort.type}'`,
        [edge.from.node, edge.to.node],
      );
    }
  }

  for (const [nodeId, edges] of resolved.incoming) {
    const kind = registry.require(graph.nodes.get(nodeId)!.kind);
    for (const port of kind.inputPorts) {
      const incomingForPort = edges.filter((e) => e.to.port === port.id);
      const allowed = port.multiplicity ?? 'one';
      if (allowed === 'one' && incomingForPort.length !== 1) {
        throw new CompileError(
          `node '${nodeId}' (kind '${kind.kind}') input port '${port.id}' ` +
            `expected exactly 1 incoming edge, got ${incomingForPort.length}`,
          [nodeId],
        );
      }
    }
  }
}

// ─── Effective space resolution (resolves 'either') ───────────────

interface EffectiveSpace {
  input: 'linear' | 'gamma';
  output: 'linear' | 'gamma';
}

/**
 * Walks nodes in topological order and pins each node's effective input and
 * output color space. 'either' is resolved greedily against the producer's
 * output (input side) or the resolved input (output side, passthrough).
 *
 * For source/decoder nodes with no input and `inputSpace: 'either'`, falls
 * back to `preferredSpace` or 'gamma' as final default. Decoder kinds are
 * expected to declare concrete inputSpace; the fallback exists only for
 * synthetic test fixtures.
 */
function resolveSpaces(
  graph: RenderGraph,
  order: string[],
  resolved: ResolvedEdges,
  registry: NodeRegistry,
): Map<string, EffectiveSpace> {
  const out = new Map<string, EffectiveSpace>();

  for (const nodeId of order) {
    const node = graph.nodes.get(nodeId)!;
    const kind = registry.require(node.kind);
    const incoming = resolved.incoming.get(nodeId) ?? [];
    // Phase 3: per-node override beats the kind's declared spaces.
    const override = readColorSpaceOverride(node.params);

    // Determine effective input space.
    let effInput: 'linear' | 'gamma';
    if (override?.inputSpace) {
      effInput = override.inputSpace;
    } else if (kind.inputSpace === 'either') {
      if (incoming.length > 0) {
        const upstream = out.get(incoming[0].from.node);
        // Upstream must be resolved already (topo order).
        effInput = upstream?.output ?? (kind.preferredSpace === 'linear' ? 'linear' : 'gamma');
      } else {
        effInput = kind.preferredSpace === 'linear' ? 'linear' : 'gamma';
      }
    } else {
      effInput = kind.inputSpace;
    }

    // Determine effective output space.
    let effOutput: 'linear' | 'gamma';
    if (override?.outputSpace) {
      effOutput = override.outputSpace;
    } else if (kind.outputSpace === 'either') {
      effOutput = effInput; // passthrough
    } else {
      effOutput = kind.outputSpace;
    }

    out.set(nodeId, { input: effInput, output: effOutput });
  }
  return out;
}

// ─── Convert insertion ────────────────────────────────────────────

interface AugmentedGraph {
  graph: RenderGraph;
  insertedConverts: Edge[];
}

/**
 * Emits an augmented graph with ColorSpaceConvert nodes inserted wherever a
 * producer's effective output space differs from the consumer's effective
 * input space. Requires the convert kinds to be registered.
 */
function insertConverts(
  graph: RenderGraph,
  spaces: Map<string, EffectiveSpace>,
  registry: NodeRegistry,
): AugmentedGraph {
  const newNodes = new Map(graph.nodes);
  const newEdges: Edge[] = [];
  const insertedConverts: Edge[] = [];
  let convertCounter = 0;
  let needRegistry = false;

  for (const edge of graph.edges) {
    const fromSpace = spaces.get(edge.from.node)?.output;
    const toSpace = spaces.get(edge.to.node)?.input;

    if (!fromSpace || !toSpace || fromSpace === toSpace) {
      // No convert needed — keep edge as-is.
      newEdges.push(edge);
      continue;
    }

    // Need a convert.
    needRegistry = true;
    const convertKind = pickConvertKind(fromSpace, toSpace);
    const convertId = `__convert_${++convertCounter}`;
    newNodes.set(convertId, { id: convertId, kind: convertKind, params: {} });

    const preEdge: Edge = {
      id: `${edge.id}__pre`,
      from: edge.from,
      to: { node: convertId, port: 'in' },
    };
    const postEdge: Edge = {
      id: `${edge.id}__post`,
      from: { node: convertId, port: 'out' },
      to: edge.to,
    };
    newEdges.push(preEdge, postEdge);
    insertedConverts.push(preEdge, postEdge);
  }

  if (needRegistry &&
      !(registry.has(KIND_CONVERT_LIN_TO_GAMMA) && registry.has(KIND_CONVERT_GAMMA_TO_LIN))) {
    throw new CompileError(
      `graph requires color-space conversion but convert kinds are not registered ` +
        `(call registerBuiltinConverts(registry) before compile)`,
    );
  }

  return {
    graph: {
      id: graph.id,
      nodes: newNodes,
      edges: newEdges,
      output: graph.output,
      metadata: graph.metadata,
    },
    insertedConverts,
  };
}

// ─── Tap insertion ────────────────────────────────────────────────

interface TapInsertionResult {
  graph: RenderGraph;
  /** Edges added by tap synthesis (source-node -> tap-node). */
  insertedTapEdges: Edge[];
  /** label -> tap node id, surfaced to the executor for external reads. */
  taps: Map<string, string>;
}

/**
 * Synthesises Tap nodes for each captureAfter request. Each tap captures
 * the output of its source node into a dedicated FBO that the executor
 * preserves (segmentation forces a boundary at tap nodes).
 *
 * Duplicate labels and missing source nodes throw — caller-side bugs that
 * deserve loud failure.
 */
function insertTaps(
  graph: RenderGraph,
  captures: ReadonlyArray<{ nodeId: string; label: string }>,
  registry: NodeRegistry,
): TapInsertionResult {
  if (captures.length === 0) {
    return { graph, insertedTapEdges: [], taps: new Map() };
  }

  if (!registry.has(KIND_TAP)) {
    throw new CompileError(
      `compile options request captureAfter taps but the tap kind is not registered ` +
        `(call registerBuiltinConverts(registry) before compile)`,
    );
  }

  const newNodes = new Map(graph.nodes);
  let newEdges: Edge[] = [...graph.edges];
  const insertedTapEdges: Edge[] = [];
  const taps = new Map<string, string>();
  // captureAfter for the same source node must yield a stable, single tap —
  // we don't allow stacking taps on the same node (would just duplicate FBOs).
  const tapsBySource = new Map<string, string>();
  let outputOverride: string | null = null;

  let counter = 0;
  for (const { nodeId, label } of captures) {
    if (!graph.nodes.has(nodeId)) {
      throw new CompileError(
        `captureAfter target node '${nodeId}' is not in the graph`,
        [nodeId],
      );
    }
    if (taps.has(label)) {
      throw new CompileError(`captureAfter label '${label}' is used more than once`);
    }
    if (tapsBySource.has(nodeId)) {
      // Two labels for the same source — point the second label at the
      // same tap node (single FBO, two names). Avoids stacked tap pile-ups.
      taps.set(label, tapsBySource.get(nodeId)!);
      continue;
    }

    const sourceNode = graph.nodes.get(nodeId)!;
    const sourceKind = registry.require(sourceNode.kind);
    const sourceOutPort = sourceKind.outputPorts[0];
    if (!sourceOutPort) {
      throw new CompileError(
        `captureAfter target '${nodeId}' (kind '${sourceKind.kind}') has no output port to tap`,
        [nodeId],
      );
    }

    const tapId = `__tap_${++counter}`;
    newNodes.set(tapId, { id: tapId, kind: KIND_TAP, params: { label } });

    // Rewire: every edge that used to consume sourceNode.<sourceOutPort> now
    // consumes the tap's output port instead. The tap itself takes a single
    // edge from sourceNode → tap.in. Net effect: tap is in-line, downstream
    // ordering naturally puts tap before original consumers via topo-sort.
    const downstreamEdges = newEdges.filter(
      (e) => e.from.node === nodeId && e.from.port === sourceOutPort.id,
    );
    newEdges = newEdges.filter(
      (e) => !(e.from.node === nodeId && e.from.port === sourceOutPort.id),
    );

    const tapInEdge: Edge = {
      id: `__tapIn_${counter}`,
      from: { node: nodeId, port: sourceOutPort.id },
      to: { node: tapId, port: 'in' },
    };
    newEdges.push(tapInEdge);
    insertedTapEdges.push(tapInEdge);

    for (let i = 0; i < downstreamEdges.length; i++) {
      const original = downstreamEdges[i];
      const rerouted: Edge = {
        id: `__tapOut_${counter}_${i}`,
        from: { node: tapId, port: 'out' },
        to: original.to,
      };
      newEdges.push(rerouted);
      insertedTapEdges.push(rerouted);
    }

    // If the tapped node was the graph output, the tap takes its place so
    // the executor still reaches a terminal.
    if (nodeId === graph.output) outputOverride = tapId;

    tapsBySource.set(nodeId, tapId);
    taps.set(label, tapId);
  }

  return {
    graph: {
      id: graph.id,
      nodes: newNodes,
      edges: newEdges,
      output: outputOverride ?? graph.output,
      metadata: graph.metadata,
    },
    insertedTapEdges,
    taps,
  };
}

// ─── Late validation: space-match (sanity) ────────────────────────

function lateValidateSpaces(graph: RenderGraph, registry: NodeRegistry): void {
  for (const edge of graph.edges) {
    const fromKind = registry.require(graph.nodes.get(edge.from.node)!.kind);
    const toKind = registry.require(graph.nodes.get(edge.to.node)!.kind);
    const fromPort = fromKind.outputPorts.find((p) => p.id === edge.from.port)!;
    const toPort = toKind.inputPorts.find((p) => p.id === edge.to.port)!;
    if (!colorSpaceCompatible(fromPort.space, toPort.space)) {
      // Indicates a bug in insertConverts.
      throw new CompileError(
        `internal compiler bug: post-insertion edge '${edge.id}' still has space mismatch ` +
          `${fromPort.space} -> ${toPort.space}`,
        [edge.from.node, edge.to.node],
      );
    }
  }
}

function colorSpaceCompatible(from: ColorSpace, to: ColorSpace): boolean {
  return from === to || from === 'either' || to === 'either';
}

// ─── Geometry propagation ─────────────────────────────────────────

function propagateGeometry(
  graph: RenderGraph,
  order: string[],
  resolved: ResolvedEdges,
  registry: NodeRegistry,
): Map<string, Geometry> {
  const out = new Map<string, Geometry>();

  for (const nodeId of order) {
    const node = graph.nodes.get(nodeId)!;
    const kind = registry.require(node.kind);

    const inputGeoms: Geometry[] = [];
    for (const port of kind.inputPorts) {
      const edges = (resolved.incoming.get(nodeId) ?? []).filter((e) => e.to.port === port.id);
      for (const edge of edges) {
        const geom = out.get(edge.from.node);
        if (geom) inputGeoms.push(geom);
      }
    }

    let resolvedGeom: Geometry | undefined;
    if (kind.outputGeometry) {
      resolvedGeom = kind.outputGeometry(inputGeoms, node.params);
    } else if (inputGeoms.length > 0) {
      resolvedGeom = inputGeoms[0]; // passthrough
    } else if (kind.category === 'source' || kind.category === 'decoder') {
      resolvedGeom = readSourceGeometryFromParams(node) ?? { width: 1, height: 1, pixelRatio: 1 };
    }

    if (!resolvedGeom) {
      throw new CompileError(
        `node '${nodeId}' (kind '${kind.kind}') has no resolvable geometry`,
        [nodeId],
      );
    }
    out.set(nodeId, resolvedGeom);
  }
  return out;
}

function readSourceGeometryFromParams(node: RenderNode): Geometry | undefined {
  const p = node.params as { geometry?: Partial<Geometry> } | undefined;
  if (!p?.geometry) return undefined;
  const { width, height, pixelRatio } = p.geometry;
  if (typeof width !== 'number' || typeof height !== 'number') return undefined;
  return { width, height, pixelRatio: pixelRatio ?? 1 };
}

// ─── Identity-skip pre-pass ───────────────────────────────────────

function computeIdentitySkips(graph: RenderGraph, registry: NodeRegistry): Set<string> {
  const out = new Set<string>();
  for (const [id, node] of graph.nodes) {
    const kind = registry.require(node.kind);
    // Taps are pure passthrough sinks: they never render, so output/tap
    // resolution must walk through them to the real producer.
    if (kind.category === 'tap') {
      out.add(id);
      continue;
    }
    try {
      if (kind.isIdentity(node.params)) out.add(id);
    } catch {
      // a throwing isIdentity() is a kind-implementation bug; treat as
      // non-identity so the node still runs and the bug surfaces visibly
    }
  }
  return out;
}

// ─── Segmentation ─────────────────────────────────────────────────

/**
 * Groups nodes into contiguous segments that share format, geometry, and
 * color-space. Each segment gets its own FBO format (RGBA8 vs RGBA16F).
 * A segment ends as soon as the next node would violate any of:
 *   - same color space (after 'either' resolution)
 *   - same geometry
 *   - same FBO format (requiresFloat is monotonic within a segment)
 *
 * Convert nodes naturally create boundaries because their input and output
 * spaces differ — they end one segment and start another.
 */
function buildSegments(
  graph: RenderGraph,
  order: string[],
  geometries: Map<string, Geometry>,
  registry: NodeRegistry,
): SegmentSpec[] {
  const segments: SegmentSpec[] = [];
  let current: { nodes: string[]; format: FboFormat; geometry: Geometry } | null = null;

  for (const nodeId of order) {
    const node = graph.nodes.get(nodeId)!;
    const kind = registry.require(node.kind);
    const geom = geometries.get(nodeId)!;
    // 'either' kinds inherit the current segment's format so they don't
    // accidentally downcast RGBA16F → RGBA8 mid-chain (would lose HDR
    // headroom for RAW pipelines that wrap them in 'either' adjustment
    // passes between WhiteBalanceRaw and OutputColorSpace).
    const format: FboFormat = pickSegmentFormat(kind, current?.format);

    // Tap nodes always live in their own one-node segment so their captured
    // FBO survives the rest of the chain's ping-pong recycling.
    const isolatedNode = kind.category === 'tap';

    // Don't extend a segment whose terminating node was an isolated kind
    // (e.g. a previous tap) — that segment ended there by construction.
    const prevWasIsolated = current !== null &&
      registry.require(graph.nodes.get(current.nodes[current.nodes.length - 1]!)!.kind)
        .category === 'tap';

    const canJoin =
      current !== null &&
      !isolatedNode &&
      !prevWasIsolated &&
      current.format === format &&
      geometryEqual(current.geometry, geom);

    if (canJoin) {
      current!.nodes.push(nodeId);
    } else {
      if (current) segments.push({ nodes: current.nodes, fboFormat: current.format, geometry: current.geometry });
      current = { nodes: [nodeId], format, geometry: geom };
    }
  }
  if (current) segments.push({ nodes: current.nodes, fboFormat: current.format, geometry: current.geometry });
  return segments;
}

function pickSegmentFormat(kind: NodeKindSpec, currentFormat?: FboFormat): FboFormat {
  if (kind.requiresFloat) return 'rgba16f';
  if (kind.outputSpace === 'linear') return 'rgba16f';
  // Space-agnostic kinds ride the current segment's format so a chain like
  // raw16Source(RGBA16F) → 'either'-tagged Tone/WB/etc keeps the HDR FBO.
  // Falls back to RGBA8 only at the chain head where no current exists.
  if (kind.outputSpace === 'either' && currentFormat) return currentFormat;
  return 'rgba8';
}

/**
 * Applies an explicit terminal precision without allowing an earlier color
 * branch to downcast first. For RGBA16F every color-producing ancestor of
 * the terminal is promoted, including secondary layer/compositor inputs.
 * Mask/control inputs deliberately retain their native precision.
 */
function applyTerminalFormat(
  graph: RenderGraph,
  output: string,
  segments: SegmentSpec[],
  format: FboFormat,
  registry: NodeRegistry,
): void {
  const terminalSegment = segments.find((segment) => segment.nodes.includes(output));
  if (!terminalSegment) throw new CompileError('terminal node has no segment');
  if (format !== 'rgba16f') {
    terminalSegment.fboFormat = format;
    return;
  }

  const incoming = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    const edges = incoming.get(edge.to.node) ?? [];
    edges.push(edge);
    incoming.set(edge.to.node, edges);
  }
  const contributors = new Set<string>([output]);
  const pending = [output];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    const kind = registry.require(node.kind);
    for (const edge of incoming.get(nodeId) ?? []) {
      const port = kind.inputPorts.find((candidate) => candidate.id === edge.to.port);
      if (port?.type !== 'color' || contributors.has(edge.from.node)) continue;
      contributors.add(edge.from.node);
      pending.push(edge.from.node);
    }
  }

  for (const segment of segments) {
    if (segment.nodes.some((nodeId) => contributors.has(nodeId))) {
      segment.fboFormat = 'rgba16f';
    }
  }
}

function geometryEqual(a: Geometry, b: Geometry): boolean {
  return a.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio;
}

// ─── Async prepare() invocation ───────────────────────────────────

/**
 * Issues prepare() calls for every async node and stores the resulting
 * promises in CompiledPlan.asyncDependencies. The executor awaits them
 * before run-time so AI inference / cloud LUTs / etc. can warm up
 * concurrently with the rest of the compile pipeline.
 *
 * Errors in prepare() surface when the executor awaits, NOT here — the
 * compiler stays synchronous-ish so the call site doesn't pay the worst
 * async-node latency on every recompile.
 */
function invokeAsyncPrepare(
  graph: RenderGraph,
  order: string[],
  resolved: ResolvedEdges,
  geometries: Map<string, Geometry>,
  registry: NodeRegistry,
): Map<string, Promise<void>> {
  const out = new Map<string, Promise<void>>();
  for (const nodeId of order) {
    const node = graph.nodes.get(nodeId)!;
    const kind = registry.require(node.kind);
    if (!kind.isAsync || !kind.prepare) continue;

    const inputGeoms: Geometry[] = [];
    for (const port of kind.inputPorts) {
      const edges = (resolved.incoming.get(nodeId) ?? []).filter((e) => e.to.port === port.id);
      for (const edge of edges) {
        const g = geometries.get(edge.from.node);
        if (g) inputGeoms.push(g);
      }
    }

    let promise: Promise<void>;
    try {
      promise = kind.prepare(node.params, { inputGeometries: inputGeoms });
    } catch (e) {
      // Synchronous throw from prepare() — wrap so the executor awaits a
      // rejection rather than the compile call exploding mid-pass.
      promise = Promise.reject(e);
    }
    // Attach a no-op handler: plans that are compiled but never executed
    // (superseded edits, validate()-only compiles) must not fire a global
    // unhandledrejection. execute() still awaits the ORIGINAL promise and
    // surfaces the error there.
    void promise.catch(() => { /* handled at execute time */ });
    out.set(nodeId, promise);
  }
  return out;
}

// ─── FBO assignment (ping-pong within segment) ────────────────────

function assignFbos(segments: SegmentSpec[]): Map<string, FboBinding> {
  const out = new Map<string, FboBinding>();
  for (const segment of segments) {
    for (let i = 0; i < segment.nodes.length; i++) {
      out.set(segment.nodes[i], {
        poolIndex: i % 2,
        format: segment.fboFormat,
        geometry: segment.geometry,
      });
    }
  }
  return out;
}

// ─── Test surface ─────────────────────────────────────────────────

export const __internals = {
  topologicalOrder,
  earlyValidate,
  lateValidateSpaces,
  resolveSpaces,
  insertConverts,
  insertTaps,
  propagateGeometry,
  computeIdentitySkips,
  buildSegments,
  applyTerminalFormat,
  assignFbos,
  invokeAsyncPrepare,
  colorSpaceCompatible,
};
