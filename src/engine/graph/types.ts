/**
 * Core types for the node-graph render pipeline (Phase 0).
 *
 * See plans/PIPELINE_NODE_GRAPH_PLAN.md for the architecture rationale.
 *
 * The graph layer is currently dormant — no existing code consumes these
 * types. Phase 1 will migrate render consumers onto the compiler/executor
 * that uses them.
 */

// ─── Color space + geometry ────────────────────────────────────────

export type ColorSpace = 'linear' | 'gamma' | 'either';

export interface Geometry {
  width: number;
  height: number;
  pixelRatio: number;
}

// ─── Ports + edges ─────────────────────────────────────────────────

export type PortDataType = 'color' | 'mask' | 'geometry' | 'meta';

export interface PortDef {
  /** Stable per-kind id (e.g. 'in', 'mask', 'out'). */
  id: string;
  type: PortDataType;
  space: ColorSpace;
  /** Optional fixed multiplicity. Undefined = exactly one. */
  multiplicity?: 'one' | 'many';
}

export interface Port extends PortDef {
  /** Resolved at compile time from upstream producer. */
  geometry?: Geometry;
}

export interface Edge {
  id: string;
  from: { node: string; port: string };
  to:   { node: string; port: string };
}

// ─── Node kind spec (plugin contract) ──────────────────────────────

export type NodeCategory =
  | 'source'
  | 'decoder'
  | 'adjustment'
  | 'convert'
  | 'tap'
  | 'mask'
  | 'compositor'
  | 'encoder'
  | 'generator';

/**
 * Minimal JSON-Schema-Subset for parameter description.
 * The inspector renders from this - and only from this: a number without
 * `minimum` and `maximum` gets a plain field there, never a slider, because a
 * slider on a guessed scale is what shipped the 100x regression (F018). So the
 * bounds are the scale, `multipleOf` is the step, and a kind that wants a
 * slider says what its numbers mean.
 *
 * Intentionally restricted: no $ref / allOf / oneOf composition.
 */
export type JsonSchema =
  | { type: 'number'; minimum?: number; maximum?: number; multipleOf?: number; default?: number; title?: string; description?: string }
  | { type: 'integer'; minimum?: number; maximum?: number; multipleOf?: number; default?: number; title?: string; description?: string }
  | { type: 'boolean'; default?: boolean; title?: string; description?: string }
  | { type: 'string'; enum?: string[]; default?: string; title?: string; description?: string }
  | { type: 'object'; properties: Record<string, JsonSchema>; required?: string[]; title?: string; description?: string }
  | { type: 'array'; items: JsonSchema; minItems?: number; maxItems?: number; default?: unknown[]; title?: string; description?: string };

export interface PrepareContext {
  /** Resolved input geometries for this node, in input-port order. */
  inputGeometries: Geometry[];
  /** Opaque handle the kind can use to schedule async work (worker
   *  postMessage, AI inference, network LUT fetch). Phase-0 placeholder. */
  scheduler?: unknown;
}

export interface DerivedTextureData {
  width: number;
  height: number;
  /** RGBA bytes (RGBA8) or floats (RGBA32F-stored-as-RGBA16F). Format
   *  inferred from buffer type. */
  pixels: Uint8Array | Float32Array;
}

export interface DerivedTextureSpec {
  /** Sampler uniform name in the fragment shader. */
  name: string;
  data: DerivedTextureData;
}

/**
 * Plugin contract for a node-kind. Registered into NodeRegistry; the
 * compiler and executor resolve kind names through the registry.
 */
export interface NodeKindSpec<Params = unknown> {
  /** Stable kind identifier (e.g. 'tone', 'toneCurve', 'rawDecoder'). */
  kind: string;
  category: NodeCategory;

  /**
   * Appears in the node library: the user can drop one onto the canvas and it
   * runs in a chain without further wiring.
   *
   * Left unset for kinds the surface cannot feed: the compiler's own converts
   * and the internal `__tap`, the multi-output encoder (no shader until Phase
   * 5d, and the executor throws on it), and the source kinds, which have no UI
   * path to bind their pixels. The library used to filter on
   * `category !== 'convert'`, which offered all four and hid the one kind the
   * user can delete but not put back (F019).
   */
  userPlaceable?: boolean;

  inputPorts: readonly PortDef[];
  outputPorts: readonly PortDef[];

  /** JSON-Schema for params; renders Inspector + validates Sync payloads. */
  paramSchema: JsonSchema;

  /** GLSL fragment shader. Optional — Source / Encoder / pure-passthrough Tap can omit. */
  fragmentShader?: string;
  /** Optional vertex shader override; defaults to the full-screen quad VS. */
  vertexShader?: string;
  /**
   * Bind this node's params onto its compiled program's uniforms. Called
   * once per execute() before drawArrays. Skip for nodes with no params
   * (passthrough, convert).
   */
  bindUniforms?(gl: WebGL2RenderingContext, program: WebGLProgram, params: unknown): void;
  /**
   * Source / decoder nodes upload externally-bound pixel data into the
   * provided texture. Called once per execute() per bound source node.
   * Skip for non-source kinds.
   */
  uploadSource?(gl: WebGL2RenderingContext, texture: WebGLTexture, params: unknown, externalData: unknown): void;
  inputSpace: ColorSpace;
  outputSpace: ColorSpace;
  /** If 'either', preferredSpace lets the compiler optimizer choose. */
  preferredSpace?: ColorSpace;
  /** Forces RGBA16F output FBO regardless of segment policy. */
  requiresFloat: boolean;
  /** Multi-pixel read inside the shader — forces a pass boundary. */
  samplesNeighbors: boolean;

  // ─── Compile-time hooks ───
  /** True iff these params make the node a no-op. */
  isIdentity(params: Params): boolean;
  /** Compute output geometry from inputs + params (Transform, Crop, Scale). */
  outputGeometry?(inputGeoms: Geometry[], params: Params): Geometry;
  /** Per-render textures derived from params (curve LUTs etc.). */
  derivedTextures?(params: Params): readonly DerivedTextureSpec[];

  // ─── Async awareness (AI, cloud LUTs, ...) ───
  isAsync: boolean;
  prepare?(params: Params, ctx: PrepareContext): Promise<void>;
}

// ─── Graph + nodes ─────────────────────────────────────────────────

/**
 * Per-node color-space override (Phase 3). When set, the compiler ignores
 * the kind's declared `inputSpace`/`outputSpace` for this specific node.
 * Useful for kinds that declare `preferredSpace: 'either'` and want to
 * lock to one space (e.g. ToneCurve user-toggled to gamma instead of the
 * Phase-2 linear default).
 *
 * Lives inside `params` under the reserved `_colorSpaceOverride` key so
 * it survives sync round-trips along with the rest of the node's params.
 */
export interface ColorSpaceOverride {
  inputSpace?: 'linear' | 'gamma';
  outputSpace?: 'linear' | 'gamma';
}

export interface RenderNode {
  /** UUID. Deterministic for default-graph nodes (seeded), random for user-added. */
  id: string;
  kind: string;
  params: unknown;
}

/**
 * Extract the per-node color-space override from a params object, if any.
 * Returns null for params that don't carry one.
 */
export function readColorSpaceOverride(params: unknown): ColorSpaceOverride | null {
  if (!params || typeof params !== 'object') return null;
  const rec = params as Record<string, unknown>;
  const override = rec['_colorSpaceOverride'];
  if (!override || typeof override !== 'object') return null;
  const o = override as Record<string, unknown>;
  const result: ColorSpaceOverride = {};
  if (o.inputSpace === 'linear' || o.inputSpace === 'gamma') result.inputSpace = o.inputSpace;
  if (o.outputSpace === 'linear' || o.outputSpace === 'gamma') result.outputSpace = o.outputSpace;
  return (result.inputSpace || result.outputSpace) ? result : null;
}

export interface NodePosition {
  x: number;
  y: number;
}

export interface RenderGraph {
  /** Graph-level UUID (lets multiple graphs coexist without collision). */
  id: string;
  nodes: Map<string, RenderNode>;
  edges: Edge[];
  /** Terminal node id. The compiler treats this as the render sink. */
  output: string;
  metadata: {
    createdAt: number;
    updatedAt: number;
    /** Monotonic per-graph revision counter — bumped on every mutation. */
    revision: number;
    /** Phase 4: per-node visual position in the graph editor canvas. Only
     *  populated when the user has manually arranged the graph; default
     *  graphs leave this empty and rely on auto-layout. */
    nodePositions?: Record<string, NodePosition>;
  };
}

// ─── Compiler output ───────────────────────────────────────────────

export type FboFormat = 'rgba8' | 'rgba16f';

export interface FboBinding {
  /** Index into the segment's ping-pong FBO pool. Set by executor. */
  poolIndex: number;
  format: FboFormat;
  geometry: Geometry;
}

export interface SegmentSpec {
  /** Node ids in execution order belonging to this segment. */
  nodes: string[];
  fboFormat: FboFormat;
  geometry: Geometry;
}

export interface CompiledPlan {
  graphId: string;
  /** Snapshot of graph.metadata.revision at compile time. */
  graphRevision: number;
  /** Augmented node set: user nodes + synthetic converts + synthetic taps.
   *  Executor reads kind + initial params from here; for user-editable
   *  params it cross-references the live RenderGraph passed to execute. */
  augmentedNodes: Map<string, RenderNode>;
  /** Augmented edges, including compiler-inserted ones. */
  augmentedEdges: Edge[];
  /** Effective terminal node id — equals graph.output unless a tap took its place. */
  output: string;
  /** Explicit terminal precision requested at compile time. The executor uses
   *  this to preserve the terminal write even when its params are identity. */
  terminalFormat?: FboFormat;
  /** Topological execution order (node ids, possibly including synthetics). */
  topologicalOrder: string[];
  /** Per-node FBO binding (where its output lives). */
  perNodeFbo: Map<string, FboBinding>;
  /** Edges the compiler added automatically (color-space converts). */
  insertedConverts: Edge[];
  /** Edges the compiler added automatically (taps for histogram/preCurve). */
  insertedTaps: Edge[];
  /** label -> tap node id. Lets the executor expose captured FBOs by name. */
  taps: Map<string, string>;
  /** Nodes whose params make them runtime-identity — executor may skip. */
  identitySkips: Set<string>;
  /** Segment partition for FBO format + ping-pong management. */
  segments: SegmentSpec[];
  /** Async prepare() promises the executor must await before running. */
  asyncDependencies: Map<string, Promise<void>>;
}

// ─── Cache key (compiler memoization) ──────────────────────────────

/**
 * Plan cache is keyed on topology only — param-driven identity-skip is a
 * runtime decision, not a compile-time one. This keeps the cache stable
 * across slider drags.
 */
export type PlanCacheKey = string;
