import type {
  Edge,
  Geometry,
  RenderGraph,
  RenderNode,
} from './types';
import { KIND_IMAGE_BITMAP_SOURCE, KIND_RAW16_SOURCE, KIND_RASTERIZED_MASK_SOURCE } from './sources';
import {
  KIND_LENS_CORRECTION,
  KIND_TONE,
  KIND_WHITE_BALANCE,
  KIND_TONE_CURVE,
  KIND_HSL,
  KIND_HSL_DETAIL,
  KIND_CUSTOM_HSL,
  KIND_LEVELS,
  KIND_BW,
  KIND_COLOR_GRADING,
  KIND_CLARITY,
  KIND_TEXTURE,
  KIND_DENOISE,
  KIND_SHARPEN,
  KIND_EFFECTS,
  KIND_TRANSFORM,
  KIND_CROP,
  KIND_WHITE_BALANCE_RAW,
  KIND_COLOR_MATRIX,
  KIND_OUTPUT_COLOR_SPACE,
  KIND_RETOUCH,
  activeRetouchSpots,
  IDENTITY_LEVELS_CHANNEL,
  IDENTITY_BW_MIX,
  IDENTITY_CURVE,
  IDENTITY_GRADING_ZONE,
  IDENTITY_HSL_CHANNELS,
  IDENTITY_RAW_WB,
  IDENTITY_COLOR_MATRIX_3X3,
  type ToneParams,
  type LensCorrectionParams,
  type WhiteBalanceParams,
  type ToneCurveParams,
  type CurvePoint,
  type HslParams,
  type HslDetailParams,
  type HslChannels,
  type CustomHslParams,
  type CustomHslSector,
  type LevelsParams,
  type LevelsChannel,
  type BwParams,
  type BwMix,
  type ColorGradingParams,
  type ColorGradingZone,
  type ClarityParams,
  type TextureParams,
  type DenoiseParams,
  type SharpenParams,
  type EffectsParams,
  type TransformParams,
  type CropParams,
  type WhiteBalanceRawParams,
  type ColorMatrixParams,
  type OutputColorSpaceParams,
  type RetouchParams,
} from './passKinds';
import { OUTPUT_COLOR_SPACES, type OutputColorSpaceId } from '../outputColorSpaces';
import type { SpotRemoval } from '../Mask';
import {
  isFullCropRect,
  normalizeCropRect,
  persistedCropRect,
  type CropRect,
} from '../Crop';
import { LENS_PROFILES } from '../LensCorrection';
import type { LensCoefficients } from '../lensProfile';
import { rawWhiteBalanceGains, relativeRawWhiteBalanceGains } from '../raw/whiteBalance';
import { skinToneParamsFor, type SkinToneUniformity } from '../skinTone';
import { defaultAdjustments, type ColorEditorSector } from '../../types';

/**
 * Subset of the editor's Adjustments object that the wrapped kinds consume.
 * Values stay in editor-native units (e.g. -100..100 for tone sliders,
 * 0..255 for levels endpoints) — the builder normalises as it pours them
 * into per-node params.
 *
 * Phase 1 expands this as more kinds get wrapped (ToneCurve LUT pts,
 * HSLDetail per-channel, ColorGrading 3 zones, etc.).
 */
export interface BuilderAdjustments {
  /** Document-wide terminal crop; not part of the legacy flat Adjustments. */
  crop?: CropRect;
  exposure?: number;
  contrast?: number;
  highlights?: number;
  shadows?: number;
  whites?: number;
  blacks?: number;
  temperature?: number;
  tint?: number;
  vibrance?: number;
  saturation?: number;
  // Levels: each channel in 0..255 input, 0..1 internal gamma
  levels?: {
    rgb?: Partial<LevelsChannel255>;
    red?: Partial<LevelsChannel255>;
    green?: Partial<LevelsChannel255>;
    blue?: Partial<LevelsChannel255>;
  };
  bwEnabled?: boolean;
  bwMix?: Partial<BwMix>;
  // ToneCurve: each channel an array of {x,y} in 0..1; default identity
  // (= straight line [0,0]→[1,1]) is the most common case.
  toneCurve?: Partial<{
    rgb: CurvePoint[]; luma: CurvePoint[];
    red: CurvePoint[]; green: CurvePoint[]; blue: CurvePoint[];
  }>;
  hsl?: Partial<HslChannels>;
  hslViewSelected?: HslDetailParams['viewSelected'];
  hslSkinTone?: HslDetailParams['skinTone'];
  customHslSectors?: CustomHslSector[];
  colorGrading?: {
    shadows?: Partial<ColorGradingZone>;
    midtones?: Partial<ColorGradingZone>;
    highlights?: Partial<ColorGradingZone>;
    balance?: number;
    blending?: number;
  };
  clarity?: number;   // 0..100 (editor units) -> /100 -> -1..1
  dehaze?: number;    // 0..100
  texture?: number;   // 0..100 -> -1..1
  denoiseLuma?: number;   // 0..100 -> 0..1
  denoiseChroma?: number; // 0..100
  denoiseDetail?: number; // 0..100
  sharpness?: number; // 0..1 or 0..100 — editor uses 0..100 historically
  vignette?: number;        // -100..100
  vignetteFeather?: number; // 0..100
  grain?: number;           // 0..100
  grainSize?: number;       // 1..N
  noiseReduction?: number;  // 0..100
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
  perspectiveH?: number;
  perspectiveV?: number;
  distortion?: number;

  // Phase 3 per-pass color-space overrides (UI-driven). Projected into
  // each node's `_colorSpaceOverride` by paramsByNodeFromAdjustments.
  // Lens correction (profile id resolved to coefficients at build time)
  lensCorrection?: boolean;
  lensCorrectionProfile?: string | null;
  lensCorrectionStrength?: number;
  toneCurveSpace?: 'linear' | 'gamma';
  colorGradingSpace?: 'linear' | 'gamma';
  hslSpace?: 'linear' | 'gamma';
}

/** Editor stores levels endpoints in 0..255; we divide-by-255 into 0..1. */
interface LevelsChannel255 {
  inBlack: number;   // 0..255
  inWhite: number;   // 0..255
  gamma: number;     // 0.01..10 (unchanged)
  outBlack: number;  // 0..255
  outWhite: number;  // 0..255
}

export interface BuilderRawCalibration {
  /** WB-applying multipliers (3 floats, ≥0), never DNG neutral values.
   *  Productive RAW decoders bake camera WB and therefore supply null; this
   *  remains for synthetic/future unbalanced camera-space sources. */
  asShotNeutral?: [number, number, number] | null;
  /** 3×3 row-major Camera-RGB → linear-sRGB matrix (9 floats). Productive
   *  RAW decoders already emit sRGB and therefore supply null. */
  colorMatrix?: number[] | null;
}

export interface BuilderImageBitmapSource {
  kind: 'imageBitmap';
  geometry: Geometry;
  /** Output color space id; defaults to 'srgb'. */
  outputColorSpaceId?: OutputColorSpaceId;
}

export interface BuilderRaw16Source {
  kind: 'raw16';
  geometry: Geometry;
  /** 3 = RGB (alpha padded to 1), 4 = RGBA. */
  channels: 3 | 4;
  /** Optional unbaked source calibration. Identity if omitted; productive
   *  RAW decoders omit it because WB and camera→sRGB are already applied. */
  calibration?: BuilderRawCalibration;
  /** Output color space id; defaults to 'srgb'. */
  outputColorSpaceId?: OutputColorSpaceId;
  /**
   * The camera's base development, or null when this photo has no profile.
   *
   * This is the RAW converter's own rendering, not an edit: it runs in its
   * own `base:` nodes underneath the user's chain, which is why the sliders
   * still read zero on a photo that has one. `null` reproduces the graph as
   * it was before base profiles existed, node for node.
   *
   * Required rather than optional on purpose. A base profile that silently
   * fails to reach one render path - the export, say, or the gallery
   * thumbnail - would show up as an unexplained difference between two views
   * of the same photo. Making every raw16 caller state its answer turns that
   * into a compile error instead.
   */
  baseAdjustments: BuilderAdjustments | null;
  /**
   * The correction for the lens this frame was shot with, or null.
   *
   * Required for the same reason as `baseAdjustments`: a correction that
   * reaches the canvas but not the export is a difference between two views
   * of one photo that nothing on screen explains.
   *
   * Only RAW carries it. A camera JPEG has usually been corrected in-camera
   * already, and correcting it a second time bends a straight line the other
   * way - so the SDR chain deliberately has no equivalent.
   */
  lensProfile: LensCoefficients | null;
}

export type BuilderSourceSpec = BuilderImageBitmapSource | BuilderRaw16Source;

export interface DefaultGraphBuildResult {
  graph: RenderGraph;
  sourceNodeId: string;
}

/** A single layer description for the layered-graph builder. */
export interface BuilderLayer {
  /** Stable layer id — used as part of node ids for paramsByNode keying. */
  id: string;
  /** Per-layer delta adjustments (applied on top of stack-so-far). */
  adjustments: BuilderAdjustments;
  /** 0..1 */
  opacity: number;
  blendMode: import('./compositorKinds').BlendMode;
  /** If true, a mask texture is bound to the layer's compositor mask input.
   *  Mask-source binding is the caller's responsibility (Phase 1.C/Mask). */
  useMask?: boolean;
  /** `DocLayer.presetSyncId`, when this layer came from a preset. Carried into
   *  the compositor params so the projection can tell a preset layer apart —
   *  it may keep its own grain and vignette, other branches may not. */
  presetSyncId?: string;
}

/**
 * Builds the canonical default RenderGraph: source → adjustment nodes in
 * Lightroom order → terminal. Two flavours:
 *
 *   imageBitmap (SDR):   source → 15 adjustments
 *   raw16 (HDR):         source → WhiteBalanceRaw → ColorMatrix
 *                               → 15 adjustments → OutputColorSpace
 *
 * Identity adjustments stay in the graph (compiler skips them at execute
 * time) so the compile-cache hits on every slider drag.
 *
 * Node IDs are deterministic — `default:<kind>` — so per-node overrides
 * (Phase 3) survive recompiles without remapping.
 */
export function buildDefaultGraph(
  adjustments: BuilderAdjustments,
  source: BuilderSourceSpec,
): DefaultGraphBuildResult {
  const nodes = new Map<string, RenderNode>();
  const edges: Edge[] = [];

  const sourceKind = sourceKindForBuilder(source);
  const sourceParams = sourceParamsForBuilder(source);
  const sourceId = nodeId(sourceKind);
  nodes.set(sourceId, { id: sourceId, kind: sourceKind, params: sourceParams });

  let prevId = sourceId;
  for (const step of chainForSource(source)) {
    const { kind, paramsFn } = step;
    const a = stepAdjustments(step, adjustments, source);
    const id = nodeId(kind, step.stage);
    // Bake the Phase-3 space override into the compiled node params — the
    // compiler resolves convert placement from these, so the override must
    // exist at compile time (paramsByNode at render time is too late).
    nodes.set(id, { id, kind, params: applyPhase3Override(kind, a, paramsFn(a, source)) });
    edges.push(linkEdge(`e:${prevId}→${id}`, prevId, id));
    prevId = id;
  }

  const now = Date.now();
  return {
    graph: {
      id: graphId(adjustments, source),
      nodes,
      edges,
      output: prevId,
      metadata: { createdAt: now, updatedAt: now, revision: 1 },
    },
    sourceNodeId: sourceId,
  };
}

// ─── Chain spec ───────────────────────────────────────────────────

export interface ChainStep {
  kind: string;
  paramsFn(a: BuilderAdjustments, source: BuilderSourceSpec): unknown;
  /** 'base' steps read the camera profile; the rest read the user's edits. */
  stage?: 'base';
}

// Phase 2 layout: linear-math kinds run in working-linear-sRGB; gamma kinds
// (perceptual filters) follow after OutputColorSpace flips to gamma-encoded
// display space.

const SDR_LINEAR_BLOCK: ChainStep[] = [
  { kind: KIND_LENS_CORRECTION, paramsFn: pluckLensCorrection },
  { kind: KIND_TONE,           paramsFn: pluckTone },
  { kind: KIND_WHITE_BALANCE,  paramsFn: pluckWhiteBalance },
  { kind: KIND_TONE_CURVE,     paramsFn: pluckToneCurve },
  { kind: KIND_LEVELS,         paramsFn: pluckLevels },
  { kind: KIND_HSL,            paramsFn: pluckHsl },
  { kind: KIND_HSL_DETAIL,     paramsFn: pluckHslDetail },
  { kind: KIND_CUSTOM_HSL,     paramsFn: pluckCustomHsl },
  { kind: KIND_BW,             paramsFn: pluckBw },
  { kind: KIND_COLOR_GRADING,  paramsFn: pluckColorGrading },
  { kind: KIND_CLARITY,        paramsFn: pluckClarity },
];

const SDR_GAMMA_BLOCK: ChainStep[] = [
  { kind: KIND_TEXTURE,        paramsFn: pluckTexture },
  { kind: KIND_DENOISE,        paramsFn: pluckDenoise },
  { kind: KIND_SHARPEN,        paramsFn: pluckSharpen },
  { kind: KIND_EFFECTS,        paramsFn: pluckEffects },
  { kind: KIND_TRANSFORM,      paramsFn: pluckTransform },
];

/**
 * The passes a camera base profile is allowed to occupy.
 *
 * Deliberately not the whole chain:
 *  - white balance is missing because a RAW's is multiplicative, and the
 *    profile's gains are folded into the existing WhiteBalanceRaw node
 *    instead of running as a second pass;
 *  - transform is missing because applying it twice flips the image once per
 *    stage - the regression of 2026-05-17, see DocumentModel.ts:172;
 *  - lens correction is missing because that is the lens profile's job, keyed
 *    by lens rather than by camera;
 *  - effects are missing because a vignette or grain is a look, and a look
 *    belongs in a preset the user can take off;
 *  - of the three colour nodes only KIND_HSL is here, because that is the one
 *    carrying vibrance and saturation. The sector editors behind hslDetail and
 *    customHsl are a look as well, and black and white certainly is.
 */
const BASE_LINEAR_KINDS = new Set<string>([
  KIND_TONE, KIND_TONE_CURVE, KIND_LEVELS, KIND_HSL, KIND_COLOR_GRADING, KIND_CLARITY,
]);
const BASE_GAMMA_KINDS = new Set<string>([
  KIND_TEXTURE, KIND_DENOISE, KIND_SHARPEN,
]);

const OUTPUT_COLOR_SPACE_STEP: ChainStep = {
  kind: KIND_OUTPUT_COLOR_SPACE, paramsFn: pluckOutputColorSpace,
};

const HDR_PREFIX: ChainStep[] = [
  { kind: KIND_WHITE_BALANCE_RAW, paramsFn: pluckWhiteBalanceRaw },
  { kind: KIND_COLOR_MATRIX,      paramsFn: pluckColorMatrix },
];

// RAW temperature/tint is handled by WhiteBalanceRaw as multiplicative
// linear channel gains. Running the SDR WhiteBalance node as well would apply
// the additive JPG-style blue/yellow filter a second time.
const RAW_LINEAR_BLOCK = SDR_LINEAR_BLOCK.filter(({ kind }) => kind !== KIND_WHITE_BALANCE);

/**
 * The kinds a chain runs through for this source, in order. The single place
 * that knows the classic pipeline's fixed order, exposed so the projection's
 * order and duplicate rules can be derived from it rather than kept as a
 * second list that drifts the moment a pass is added or moved.
 */
export function chainKindsForSource(source: BuilderSourceSpec): string[] {
  return chainForSource(source).map((step) => step.kind);
}

/**
 * The same chain with the stage of every step: `base` for the camera
 * profile's nodes, `user` for the edits. With a profile a kind occurs twice
 * (base:tone ahead of default:tone), and only the pair says which one a node
 * stands for.
 */
export function chainStepsForSource(
  source: BuilderSourceSpec,
): ReadonlyArray<{ kind: string; stage: 'base' | 'user' }> {
  return chainForSource(source).map((step) => ({ kind: step.kind, stage: step.stage ?? 'user' }));
}

// The stage is the segment right in front of the kind, and kinds carry no
// colon - so a layer id with colons in it (`comp:L1` after a projection)
// cannot fake one.
const BASE_NODE_ID = /^(?:layer:.*:)?base:[^:]+$/;

/**
 * Which stage a builder node id belongs to: `base:<kind>` and
 * `layer:<id>:base:<kind>` are the camera profile's, everything else is the
 * user's. The counterpart of `nodeId(kind, 'base')`.
 */
export function stageOfNodeId(id: string): 'base' | 'user' {
  return BASE_NODE_ID.test(id) ? 'base' : 'user';
}

/**
 * Put the base stage into a graph that was stored without one.
 *
 * A graph-led photo renders its stored graph, and that graph was frozen
 * before this camera had a profile - so without this the graph view and the
 * classic view of the same RAW show two different pictures, which is the one
 * thing the single-source-of-truth work set out to end.
 *
 * The insertion points are named rather than guessed. The linear block goes
 * after ColorMatrix and the gamma block after OutputColorSpace, because those
 * are the two nodes that define which space the samples are in; splicing
 * anywhere else would run a tone curve over camera-RGB and produce a wrong
 * picture with no error to show for it. A graph that has no such node - one a
 * user rewired by hand - is left exactly as it is, and reports that it was.
 */
export function spliceBaseStage(
  graph: RenderGraph,
  source: BuilderSourceSpec,
): { graph: RenderGraph; applied: boolean } {
  const base = baseAdjustmentsOf(source);
  if (!base) return { graph, applied: false };
  // Already spliced (a graph stored after this existed) - nothing to do.
  for (const id of graph.nodes.keys()) if (id.startsWith('base:')) return { graph, applied: true };

  const nodes = new Map(graph.nodes);
  const edges = [...graph.edges];
  let output = graph.output;
  let applied = false;

  for (const [anchorKind, block, allowed] of [
    [KIND_COLOR_MATRIX, source.kind === 'raw16' ? RAW_LINEAR_BLOCK : SDR_LINEAR_BLOCK, BASE_LINEAR_KINDS],
    [KIND_OUTPUT_COLOR_SPACE, SDR_GAMMA_BLOCK, BASE_GAMMA_KINDS],
  ] as const) {
    const anchorId = findNodeIdOfKind(nodes, anchorKind);
    if (!anchorId) continue;
    const steps = baseSteps(block, allowed);
    if (steps.length === 0) continue;

    let prevId = anchorId;
    for (const step of steps) {
      const id = nodeId(step.kind, 'base');
      nodes.set(id, {
        id, kind: step.kind,
        params: applyPhase3Override(step.kind, base, step.paramsFn(base, source)),
      });
      if (prevId !== anchorId) edges.push(linkEdge(`e:${prevId}→${id}`, prevId, id));
      prevId = id;
    }
    const headId = nodeId(steps[0].kind, 'base');
    // Everything the anchor fed now hangs off the end of the base chain.
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (edge.from.node !== anchorId || edge.to.node === headId) continue;
      edges[i] = { ...edge, from: { node: prevId, port: edge.from.port } };
    }
    edges.push(linkEdge(`e:${anchorId}→${headId}`, anchorId, headId));
    // An anchor that was the terminal node no longer is: the base chain is.
    if (output === anchorId) output = prevId;
    applied = true;
  }

  if (!applied) return { graph, applied: false };
  return {
    graph: { ...graph, nodes, edges, output },
    applied: true,
  };
}

/**
 * Put the retouch node into every chain of a graph, or leave the graph
 * exactly as it is when there is nothing to retouch.
 *
 * Where: directly behind the base stage and ahead of the user's first pass.
 * Behind the base stage because a spot is painted on the developed picture,
 * not on undeveloped sensor data; ahead of the user's chain because a repair
 * belongs under the edits rather than on top of them. Ahead of the layers for
 * the same reason - and since each chain of a layered graph carries its own
 * copy of the base stage, each one gets its own retouch node. One shared node
 * feeding several chains would be a fan-out that only the source is allowed
 * (shapeScan's `notAStack`), so it would lock the document in graph mode.
 *
 * Nothing is inserted when the list is empty: an unretouched document has to
 * build the graph it always built, node for node and id for id, or every
 * compile-cache slot and every export filename moves for nothing.
 *
 * The id carries a hash of the spots. `PipelineService.compile` caches plans
 * by `graph.id` alone, and these params are baked into the node rather than
 * handed in per render - without the mark, moving a spot renders the plan
 * compiled for where it was before.
 */
export function spliceRetouch(
  graph: RenderGraph,
  spots: readonly SpotRemoval[] | undefined,
): { graph: RenderGraph; applied: boolean } {
  const spotParams = retouchParamsOf(spots);
  if (spotParams.spots.length === 0) return { graph, applied: false };

  const sourceId = findImageSourceId(graph.nodes);
  if (!sourceId) return { graph, applied: false };

  const nodes = new Map(graph.nodes);
  const edges = [...graph.edges];
  let output = graph.output;
  let applied = false;
  const insertedParams: RetouchParams[] = [];

  for (const headId of consumersOf(edges, sourceId)) {
    const anchorId = retouchAnchor(nodes, edges, headId, sourceId);
    const id = retouchNodeId(anchorId === sourceId ? headId : anchorId);
    if (nodes.has(id)) continue;
    const params = retouchParamsOf(spots, transformsInChain(nodes, edges, headId));
    nodes.set(id, { id, kind: KIND_RETOUCH, params });
    insertedParams.push(params);
    // Everything the anchor fed now hangs off the retouch node.
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i];
      if (edge.from.node !== anchorId || edge.to.node === id) continue;
      // Only this chain moves: a layered graph's source feeds every chain.
      if (anchorId === sourceId && edge.to.node !== headId) continue;
      edges[i] = { ...edge, from: { node: id, port: edge.from.port } };
    }
    edges.push(linkEdge(`e:${anchorId}→${id}`, anchorId, id));
    if (output === anchorId) output = id;
    applied = true;
  }

  if (!applied) return { graph, applied: false };
  return {
    graph: { ...graph, id: retouchGraphId(graph.id, insertedParams), nodes, edges, output },
    applied: true,
  };
}

/**
 * The graph a classic document depicts with its retouch in place: a node
 * that is already there follows the document, a missing one is spliced in.
 *
 * The graph VIEW of a classic document keeps a graph across a mode switch
 * and re-syncs the builder-owned params onto it (`syncDefaultNodeParams`).
 * The retouch node is not builder-owned - its params come from the document,
 * not from the adjustments - so without this it would sit at the spots it was
 * built with while the canvas next to it shows the current ones.
 *
 * A node whose spots have all been deleted stays as an identity node rather
 * than being cut out: the compiler skips it, and the next rebuild (every
 * document change rebuilds) drops it anyway.
 */
export function withDocumentRetouch(
  graph: RenderGraph,
  spots: readonly SpotRemoval[] | undefined,
): RenderGraph {
  const nodes = new Map(graph.nodes);
  let found = false;
  const updatedParams: RetouchParams[] = [];
  for (const [id, node] of nodes) {
    if (node.kind !== KIND_RETOUCH) continue;
    found = true;
    const params = retouchParamsOf(spots, transformsInChain(nodes, graph.edges, id));
    nodes.set(id, { ...node, params });
    updatedParams.push(params);
  }
  if (!found) return spliceRetouch(graph, spots).graph;
  return { ...graph, id: retouchGraphId(graph.id, updatedParams), nodes };
}

/** The id with the retouch mark on it, replacing an older mark rather than
 *  stacking a second one. */
function retouchGraphId(id: string, params: readonly RetouchParams[]): string {
  return `${id.replace(/#retouch:[0-9a-f]{8}(?=#|$)/, '')}#retouch:${retouchParamsMark(params)}`;
}

/** The node id a retouch node gets in the chain that starts at `headId`:
 *  the chain's own prefix, so a layered graph keeps one per branch. */
export function retouchNodeId(nodeIdInChain: string): string {
  const prefix = /^(layer:.+?:)/.exec(nodeIdInChain)?.[1] ?? '';
  return `${prefix}${RETOUCH_NODE_ID}`;
}

/** Base-chain retouch node id. */
export const RETOUCH_NODE_ID = 'default:retouch';

// ─── Document crop ───────────────────────────────────────────────

/** One document-wide crop after transforms, effects and layer compositing. */
export const DOCUMENT_CROP_NODE_ID = 'document:crop';

export function cropParamsOf(crop?: Partial<CropRect> | null): CropParams {
  return normalizeCropRect(crop);
}

/**
 * Add the document crop as the terminal graph node. Keeping it after the
 * compositor crops base pixels, layer pixels and masks together; putting a
 * copy in every layer chain would sample an uncropped mask against cropped
 * color and shift local adjustments.
 */
export function spliceCrop(
  graph: RenderGraph,
  crop?: Partial<CropRect> | null,
): { graph: RenderGraph; applied: boolean } {
  const params = cropParamsOf(crop);
  if (isFullCropRect(params)) return { graph, applied: false };
  if (graph.nodes.get(graph.output)?.kind === KIND_CROP) return { graph, applied: false };

  let id = DOCUMENT_CROP_NODE_ID;
  let suffix = 2;
  while (graph.nodes.has(id)) id = `${DOCUMENT_CROP_NODE_ID}:${suffix++}`;
  const nodes = new Map(graph.nodes);
  nodes.set(id, { id, kind: KIND_CROP, params });
  return {
    graph: {
      ...graph,
      id: cropGraphId(graph.id, params),
      nodes,
      edges: [...graph.edges, linkEdge(`e:${graph.output}→${id}`, graph.output, id)],
      output: id,
    },
    applied: true,
  };
}

/**
 * Update the terminal crop a graph view owns, or add/remove the canonical
 * node. Removal bypasses only the terminal crop, never an arbitrary node in
 * the middle of a user-authored graph.
 */
export function withDocumentCrop(
  graph: RenderGraph,
  crop?: Partial<CropRect> | null,
): RenderGraph {
  const params = cropParamsOf(crop);
  const output = graph.nodes.get(graph.output);
  if (output?.kind !== KIND_CROP) {
    if (isFullCropRect(params)) return graph;
    return bumpGraphRevision(spliceCrop(graph, params).graph);
  }

  if (isFullCropRect(params)) {
    const incoming = graph.edges.find((edge) => edge.to.node === output.id && edge.to.port === 'in');
    if (!incoming) return graph;
    const nodes = new Map(graph.nodes);
    nodes.delete(output.id);
    return bumpGraphRevision({
      ...graph,
      id: cropGraphId(graph.id),
      nodes,
      edges: graph.edges.filter((edge) => edge.from.node !== output.id && edge.to.node !== output.id),
      output: incoming.from.node,
    });
  }

  const current = cropParamsOf(output.params as Partial<CropParams>);
  if (sameCrop(current, params)) return graph;
  const nodes = new Map(graph.nodes);
  nodes.set(output.id, { ...output, params });
  return bumpGraphRevision({ ...graph, id: cropGraphId(graph.id, params), nodes });
}

/** The crop represented by a graph's terminal document-crop node. */
export function cropFromGraph(graph: RenderGraph | null | undefined): CropRect | undefined {
  if (!graph) return undefined;
  const output = graph.nodes.get(graph.output);
  return output?.kind === KIND_CROP
    ? persistedCropRect(output.params as Partial<CropParams>)
    : undefined;
}

function cropGraphId(id: string, crop?: CropParams): string {
  const base = id.replace(/#crop:[^#]+(?=#|$)/g, '');
  return crop
    ? `${base}#crop:${crop.x},${crop.y},${crop.width},${crop.height}`
    : base;
}

function sameCrop(a: CropParams, b: CropParams): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function bumpGraphRevision(graph: RenderGraph): RenderGraph {
  return {
    ...graph,
    metadata: {
      ...graph.metadata,
      updatedAt: Date.now(),
      revision: graph.metadata.revision + 1,
    },
  };
}

/**
 * The last node ahead of the user's chain, walking down from the source:
 * the RAW prefix (the sensor's own white balance and colour matrix) and the
 * camera profile's `base:` nodes. Stops at the first node that is neither,
 * and at a fork - a node with several consumers is where the chains split,
 * and the retouch has to sit in front of that.
 */
function retouchAnchor(
  nodes: Map<string, RenderNode>,
  edges: Edge[],
  headId: string,
  sourceId: string,
): string {
  let anchor = sourceId;
  let cursor: string | undefined = headId;
  const seen = new Set<string>([sourceId]);
  while (cursor && !seen.has(cursor) && isPreUserNode(nodes, cursor)) {
    seen.add(cursor);
    anchor = cursor;
    const next = consumersOf(edges, cursor);
    cursor = next.length === 1 ? next[0] : undefined;
  }
  return anchor;
}

/** Sensor development rather than an edit: the RAW prefix and the camera
 *  profile's own nodes. */
function isPreUserNode(nodes: Map<string, RenderNode>, id: string): boolean {
  const node = nodes.get(id);
  if (!node) return false;
  if (stageOfNodeId(id) === 'base') return true;
  return node.kind === KIND_WHITE_BALANCE_RAW || node.kind === KIND_COLOR_MATRIX;
}

function consumersOf(edges: Edge[], nodeId: string): string[] {
  const out: string[] = [];
  for (const edge of edges) {
    if (edge.from.node === nodeId && !out.includes(edge.to.node)) out.push(edge.to.node);
  }
  return out;
}

/** The transforms this branch eventually applies to the retouched pixels. */
function transformsInChain(
  nodes: Map<string, RenderNode>,
  edges: Edge[],
  startId: string,
): TransformParams[] {
  const transforms: TransformParams[] = [];
  let cursor: string | undefined = startId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = nodes.get(cursor);
    if (node?.kind === KIND_TRANSFORM) transforms.push(node.params as TransformParams);
    const next = consumersOf(edges, cursor);
    cursor = next.length === 1 ? next[0] : undefined;
  }
  return transforms;
}

function findImageSourceId(nodes: Map<string, RenderNode>): string | null {
  for (const [id, node] of nodes) {
    if (node.kind === KIND_IMAGE_BITMAP_SOURCE || node.kind === KIND_RAW16_SOURCE) return id;
  }
  return null;
}

/** The document's spots as the node reads them, dropping the ones that
 *  change no pixel and the ones past what the shader declares. */
export function retouchParamsOf(
  spots: readonly SpotRemoval[] | undefined,
  displayTransforms?: TransformParams | readonly TransformParams[],
): RetouchParams {
  const transforms = displayTransforms === undefined
    ? []
    : Array.isArray(displayTransforms) ? displayTransforms : [displayTransforms as TransformParams];
  return {
    spots: activeRetouchSpots((spots ?? []).map((s) => ({
      tx: s.target.x, ty: s.target.y,
      sx: s.source.x, sy: s.source.y,
      r: s.target.radius,
      feather: s.feather,
      opacity: s.opacity,
      mode: s.mode,
    }))),
    // Keep the ordinary one-transform graph byte-for-byte on its established
    // parameter path; only a free graph needs the plural representation.
    ...(transforms.length === 1 ? { displayTransform: transforms[0] } : {}),
    ...(transforms.length > 1 ? { displayTransforms: [...transforms] } : {}),
  };
}

/** The document's spots as `SpotRemoval`s again - the inverse of
 *  `retouchParamsOf`, used by the projection back to the document. */
export function spotsFromRetouchParams(params: unknown, previous?: readonly SpotRemoval[]): SpotRemoval[] {
  const spots = (params && typeof params === 'object')
    ? (params as RetouchParams).spots
    : undefined;
  if (!Array.isArray(spots)) return [];
  return spots.map((s, i) => ({
    // Ids are not in the node - they name nothing the graph can express - so
    // the previous document's ids are reused position by position and only a
    // spot without one gets a fresh id.
    id: previous?.[i]?.id ?? crypto.randomUUID(),
    mode: s.mode === 'clone' ? 'clone' : 'heal',
    target: { x: s.tx, y: s.ty, radius: s.r },
    source: { x: s.sx, y: s.sy },
    feather: s.feather,
    opacity: s.opacity,
  }));
}

/** FNV-1a over the node params, eight hex digits - same shape as
 *  `graphContentHash`, which a built graph does not get. */
function retouchParamsMark(params: readonly RetouchParams[]): string {
  const key = JSON.stringify(params);
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Where a retouch node sits in the classic chain: behind the base stage and
 * the RAW prefix, ahead of the user's first pass. The chain rules ask for it
 * so a retouched document is not mistaken for a hand-wired graph.
 */
export function retouchStepIndex(source: BuilderSourceSpec): number {
  const steps = chainStepsForSource(source);
  let i = 0;
  while (i < steps.length && (steps[i].stage === 'base'
    || steps[i].kind === KIND_WHITE_BALANCE_RAW
    || steps[i].kind === KIND_COLOR_MATRIX)) i++;
  return i;
}

function findNodeIdOfKind(nodes: Map<string, RenderNode>, kind: string): string | null {
  for (const [id, node] of nodes) if (node.kind === kind) return id;
  return null;
}

/** The camera profile on this source, or null when it has none. */
export function baseAdjustmentsOf(source: BuilderSourceSpec): BuilderAdjustments | null {
  return source.kind === 'raw16' ? source.baseAdjustments : null;
}

/** Copy of a block, re-tagged to read the base profile instead of the edits. */
function baseSteps(block: ChainStep[], allowed: Set<string>): ChainStep[] {
  return block
    .filter((step) => allowed.has(step.kind))
    .map((step) => ({ ...step, stage: 'base' as const }));
}

function chainForSource(source: BuilderSourceSpec): ChainStep[] {
  // Both source kinds share the same post-source layout:
  //   [HDR prefix?] → linear block → OutputColorSpace → gamma block
  // For imageBitmap sources the compiler auto-inserts a gamma→linear
  // convert at the head; for raw16 the source is already linear.
  const raw = source.kind === 'raw16';
  const prefix = raw ? HDR_PREFIX : [];
  const linearBlock = raw ? RAW_LINEAR_BLOCK : SDR_LINEAR_BLOCK;

  // A camera profile runs underneath the edits, in its own nodes. It is a
  // separate stage rather than values merged into the same nodes because a
  // base curve and a user curve are two applications of a curve, and there
  // is no honest way to add two curves - or two sets of levels, or two HSL
  // sector lists - into one. Passes the profile leaves alone are identity
  // and the compiler skips them at execute time, so a profile that only sets
  // exposure and a curve costs two extra passes, not eight.
  const base = baseAdjustmentsOf(source);
  if (!base) {
    return [...prefix, ...linearBlock, OUTPUT_COLOR_SPACE_STEP, ...SDR_GAMMA_BLOCK];
  }
  return [
    ...prefix,
    ...baseSteps(linearBlock, BASE_LINEAR_KINDS),
    ...linearBlock,
    OUTPUT_COLOR_SPACE_STEP,
    ...baseSteps(SDR_GAMMA_BLOCK, BASE_GAMMA_KINDS),
    ...SDR_GAMMA_BLOCK,
  ];
}

function sourceKindForBuilder(source: BuilderSourceSpec): string {
  return source.kind === 'raw16' ? KIND_RAW16_SOURCE : KIND_IMAGE_BITMAP_SOURCE;
}

function sourceParamsForBuilder(source: BuilderSourceSpec): unknown {
  if (source.kind === 'raw16') {
    return {
      width: source.geometry.width,
      height: source.geometry.height,
      pixelRatio: source.geometry.pixelRatio,
      channels: source.channels,
    };
  }
  return {
    width: source.geometry.width,
    height: source.geometry.height,
    pixelRatio: source.geometry.pixelRatio,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

function nodeId(kind: string, stage?: 'base'): string {
  return `${stage === 'base' ? 'base' : 'default'}:${kind}`;
}

/** Stable id of a user-adjustment node in the base or a layer chain. */
export function adjustmentNodeId(kind: string, layerId?: string): string {
  const id = nodeId(kind);
  return layerId ? `layer:${layerId}:${id}` : id;
}

/** The values a step reads: the camera profile for a base step, else the edits. */
function stepAdjustments(
  step: ChainStep,
  adjustments: BuilderAdjustments,
  source: BuilderSourceSpec,
): BuilderAdjustments {
  return step.stage === 'base' ? (baseAdjustmentsOf(source) ?? {}) : adjustments;
}

function linkEdge(id: string, fromNode: string, toNode: string): Edge {
  return {
    id,
    from: { node: fromNode, port: 'out' },
    to: { node: toNode, port: 'in' },
  };
}

/**
 * Compile-time facts baked into node params that therefore belong in the
 * plan-cache identity: output color space + Phase-3 per-pass space
 * overrides. Everything else flows through paramsByNode per render.
 */
export function graphSpaceSignature(adjustments: BuilderAdjustments): string {
  return `${adjustments.toneCurveSpace ?? ''}|${adjustments.colorGradingSpace ?? ''}|${adjustments.hslSpace ?? ''}`;
}

function graphId(adjustments: BuilderAdjustments, source: BuilderSourceSpec): string {
  const ocs = source.outputColorSpaceId ?? 'srgb';
  const spaces = graphSpaceSignature(adjustments);
  return `default-graph:${source.kind}:${source.geometry.width}x${source.geometry.height}:${ocs}:${spaces}${baseStageMark(source)}`;
}

/** What the source's base stage contributes to a graph id. */
function baseStageMark(source: BuilderSourceSpec): string {
  // A base profile adds nodes, so a graph that has one must not land in the
  // compile cache slot of one that does not. Beyond its presence only its
  // space overrides matter here: its values are execute-time params (the
  // `base:*` keys of the param map), and params never invalidate a plan.
  const base = baseAdjustmentsOf(source);
  const baseMark = base ? `:base=${graphSpaceSignature(base)}` : '';
  // `enabled` on the lens pass is compiled into the node params, so a
  // corrected and an uncorrected graph must not share a compile-cache slot.
  const lens = source.kind === 'raw16' && source.lensProfile ? ':lens' : '';
  return `${baseMark}${lens}`;
}

function div100(v: number | undefined): number {
  return (v ?? 0) / 100;
}

/**
 * What the lens pass runs with.
 *
 * The resolved profile on the source wins. It is a fact about the glass, the
 * same way white balance gains are a fact about the sensor, so it does not
 * wait for the user to switch anything on - which is just as well, because
 * `lensCorrection` has defaulted to false since the field existed and no UI
 * has ever set it. `lensCorrectionProfile` still works as the manual
 * override it was meant to be.
 */
function pluckLensCorrection(a: BuilderAdjustments, source: BuilderSourceSpec): LensCorrectionParams {
  const resolved = source.kind === 'raw16' ? source.lensProfile : null;
  const manual = (a.lensCorrection && a.lensCorrectionProfile)
    ? LENS_PROFILES.find((p) => p.id === a.lensCorrectionProfile)
    : undefined;
  const profile = resolved ?? manual;
  return {
    enabled: !!profile,
    k1: profile?.k1 ?? 0, k2: profile?.k2 ?? 0, k3: profile?.k3 ?? 0,
    v1: profile?.v1 ?? 0, v2: profile?.v2 ?? 0, v3: profile?.v3 ?? 0,
    caR: profile?.caR ?? 0, caB: profile?.caB ?? 0,
    strength: (a.lensCorrectionStrength ?? 100) / 100,
  };
}

function pluckTone(a: BuilderAdjustments): ToneParams {
  return {
    exposure: div100(a.exposure),
    contrast: div100(a.contrast),
    highlights: div100(a.highlights),
    shadows: div100(a.shadows),
    whites: div100(a.whites),
    blacks: div100(a.blacks),
  };
}

function pluckWhiteBalance(a: BuilderAdjustments): WhiteBalanceParams {
  return { temperature: div100(a.temperature), tint: div100(a.tint) };
}

function pluckHsl(a: BuilderAdjustments): HslParams {
  return { vibrance: div100(a.vibrance), saturation: div100(a.saturation) };
}

function pluckLevels(a: BuilderAdjustments): LevelsParams {
  return {
    rgb: pluckLevelsChannel(a.levels?.rgb),
    red: pluckLevelsChannel(a.levels?.red),
    green: pluckLevelsChannel(a.levels?.green),
    blue: pluckLevelsChannel(a.levels?.blue),
  };
}

function pluckLevelsChannel(c: Partial<LevelsChannel255> | undefined): LevelsChannel {
  if (!c) return { ...IDENTITY_LEVELS_CHANNEL };
  return {
    inBlack: (c.inBlack ?? 0) / 255,
    inWhite: (c.inWhite ?? 255) / 255,
    gamma: c.gamma ?? 1,
    outBlack: (c.outBlack ?? 0) / 255,
    outWhite: (c.outWhite ?? 255) / 255,
  };
}

function pluckBw(a: BuilderAdjustments): BwParams {
  return {
    enabled: a.bwEnabled ?? false,
    mix: { ...IDENTITY_BW_MIX, ...(a.bwMix ?? {}) },
  };
}

function pluckToneCurve(a: BuilderAdjustments): ToneCurveParams {
  const c = a.toneCurve ?? {};
  return {
    rgb:   c.rgb   ?? [...IDENTITY_CURVE],
    luma:  c.luma  ?? [...IDENTITY_CURVE],
    red:   c.red   ?? [...IDENTITY_CURVE],
    green: c.green ?? [...IDENTITY_CURVE],
    blue:  c.blue  ?? [...IDENTITY_CURVE],
  };
}

function pluckClarity(a: BuilderAdjustments): ClarityParams {
  return { clarity: div100(a.clarity), dehaze: div100(a.dehaze) };
}

function pluckHslDetail(a: BuilderAdjustments): HslDetailParams {
  return {
    channels: {
      ...IDENTITY_HSL_CHANNELS,
      ...(a.hsl ?? {}),
    } as HslChannels,
    viewSelected: a.hslViewSelected,
    skinTone: a.hslSkinTone,
  };
}

function pluckCustomHsl(a: BuilderAdjustments): CustomHslParams {
  return { sectors: a.customHslSectors ?? [] };
}

function pluckColorGrading(a: BuilderAdjustments): ColorGradingParams {
  const cg = a.colorGrading ?? {};
  return {
    shadows:    pluckColorGradingZone(cg.shadows),
    midtones:   pluckColorGradingZone(cg.midtones),
    highlights: pluckColorGradingZone(cg.highlights),
    balance: cg.balance ?? 0,
    blending: cg.blending ?? 50,
  };
}

/** Editor arc sliders use -100..100; graph uniforms and schemas use -1..1. */
function pluckColorGradingZone(zone: Partial<ColorGradingZone> | undefined): ColorGradingZone {
  const editorZone = { ...IDENTITY_GRADING_ZONE, ...(zone ?? {}) };
  return {
    ...editorZone,
    satAdj: div100(editorZone.satAdj),
    lumAdj: div100(editorZone.lumAdj),
  };
}

function pluckTexture(a: BuilderAdjustments): TextureParams {
  return { amount: div100(a.texture) };
}

function pluckDenoise(a: BuilderAdjustments): DenoiseParams {
  return {
    luma: (a.denoiseLuma ?? 0) / 100,
    chroma: (a.denoiseChroma ?? 0) / 100,
    detail: (a.denoiseDetail ?? 50) / 100,
  };
}

function pluckEffects(a: BuilderAdjustments): EffectsParams {
  return {
    vignette: div100(a.vignette),
    vignetteFeather: (a.vignetteFeather ?? 50) / 100,
    grain: (a.grain ?? 0) / 100,
    grainSize: a.grainSize ?? 25,
    noiseReduction: (a.noiseReduction ?? 0) / 100,
  };
}

// ─── Adjustments → BuilderAdjustments mapping ──────────────────────

/**
 * Convert the editor's flat `Adjustments` object into the builder's shape.
 *
 * Most fields map 1:1 by name. Color-editor sectors are shaped for the
 * CustomHSL kind, while persisted skin-tone uniformity is derived into the
 * HSLDetail kind. UI-only state and AI-denoise still have no wrapped kind.
 *
 * The function takes `unknown` for the input and treats missing fields as
 * undefined so it stays resilient against legacy/partial Adjustments JSON
 * sitting in the sync hub.
 */
export function adjustmentsToBuilderAdjustments(adj: unknown): BuilderAdjustments {
  if (!adj || typeof adj !== 'object') return {};
  const a = adj as Record<string, unknown>;

  const out: BuilderAdjustments = {};
  copyNumber(a, out, 'exposure');
  copyNumber(a, out, 'contrast');
  copyNumber(a, out, 'highlights');
  copyNumber(a, out, 'shadows');
  copyNumber(a, out, 'whites');
  copyNumber(a, out, 'blacks');
  copyNumber(a, out, 'temperature');
  copyNumber(a, out, 'tint');
  copyNumber(a, out, 'vibrance');
  copyNumber(a, out, 'saturation');
  copyNumber(a, out, 'clarity');
  copyNumber(a, out, 'dehaze');
  copyNumber(a, out, 'texture');
  copyNumber(a, out, 'sharpness');
  copyNumber(a, out, 'denoiseLuma');
  copyNumber(a, out, 'denoiseChroma');
  copyNumber(a, out, 'denoiseDetail');
  copyNumber(a, out, 'vignette');
  copyNumber(a, out, 'vignetteFeather');
  copyNumber(a, out, 'grain');
  copyNumber(a, out, 'grainSize');
  copyNumber(a, out, 'noiseReduction');
  copyNumber(a, out, 'rotation');
  copyNumber(a, out, 'perspectiveH');
  copyNumber(a, out, 'perspectiveV');
  copyNumber(a, out, 'distortion');
  copyBoolean(a, out, 'flipH');
  copyBoolean(a, out, 'flipV');
  copyBoolean(a, out, 'bwEnabled');
  copyBoolean(a, out, 'lensCorrection');
  copyNumber(a, out, 'lensCorrectionStrength');
  if (typeof a.lensCorrectionProfile === 'string' || a.lensCorrectionProfile === null) {
    out.lensCorrectionProfile = a.lensCorrectionProfile;
  }
  copySpace(a, out, 'toneCurveSpace');
  copySpace(a, out, 'colorGradingSpace');
  copySpace(a, out, 'hslSpace');
  if (a.bwMix && typeof a.bwMix === 'object') {
    out.bwMix = a.bwMix as Partial<BwMix>;
  }
  if (a.levels && typeof a.levels === 'object') {
    out.levels = a.levels as BuilderAdjustments['levels'];
  }
  if (a.toneCurve && typeof a.toneCurve === 'object') {
    out.toneCurve = a.toneCurve as BuilderAdjustments['toneCurve'];
  }
  if (a.hsl && typeof a.hsl === 'object') {
    out.hsl = a.hsl as Partial<HslChannels>;
  }
  if (a.colorGrading && typeof a.colorGrading === 'object') {
    out.colorGrading = a.colorGrading as BuilderAdjustments['colorGrading'];
  }
  // advancedSectors / skinToneSector / skinToneSectors get merged into
  // customHslSectors. CustomHSL kind only knows the {hueCenter, hueHW, ...}
  // sector shape; non-enabled or zero-delta sectors are filtered at execute
  // time by activeCustomHslSectors().
  const mergedSectors: CustomHslSector[] = [];
  if (Array.isArray(a.advancedSectors)) mergedSectors.push(...(a.advancedSectors as CustomHslSector[]));
  if (Array.isArray(a.skinToneSectors)) mergedSectors.push(...(a.skinToneSectors as CustomHslSector[]));
  if (a.skinToneSector && typeof a.skinToneSector === 'object') {
    mergedSectors.push(a.skinToneSector as CustomHslSector);
  }
  if (mergedSectors.length > 0) out.customHslSectors = mergedSectors;
  if (a.skinToneUniformity && typeof a.skinToneUniformity === 'object') {
    const sector = a.skinToneSector && typeof a.skinToneSector === 'object'
      ? a.skinToneSector as ColorEditorSector
      : defaultAdjustments.skinToneSector;
    out.hslSkinTone = skinToneParamsFor(sector, a.skinToneUniformity as SkinToneUniformity);
  }
  return out;
}

function copyNumber(src: Record<string, unknown>, dst: BuilderAdjustments, key: keyof BuilderAdjustments): void {
  const v = src[key];
  if (typeof v === 'number') (dst as Record<string, unknown>)[key] = v;
}

function copyBoolean(src: Record<string, unknown>, dst: BuilderAdjustments, key: keyof BuilderAdjustments): void {
  const v = src[key];
  if (typeof v === 'boolean') (dst as Record<string, unknown>)[key] = v;
}

function copySpace(src: Record<string, unknown>, dst: BuilderAdjustments, key: keyof BuilderAdjustments): void {
  const v = src[key];
  if (v === 'linear' || v === 'gamma') (dst as Record<string, unknown>)[key] = v;
}

/**
 * Project an Adjustments-derived BuilderAdjustments into per-node params
 * for the default graph. Caller uses this with the same plan via
 * `PipelineService.renderToPixels(plan, source, paramsByNode)` to apply a
 * single preset without rebuilding the graph.
 *
 * The source spec selects the chain shape (SDR vs raw16) — pass the same
 * spec used in `buildDefaultGraph` so the node IDs match.
 *
 * The camera profile's nodes are in here too (`base:<kind>`, read from the
 * source). The plan cache keys on the graph id, which says only THAT a photo
 * has a profile, so two RAWs of the same size share one compiled plan - and
 * the executor falls back to the params baked into that plan for every node
 * this map leaves out. Without these keys the second photo rendered with the
 * first one's profile.
 */
export function paramsByNodeFromAdjustments(
  builderAdj: BuilderAdjustments,
  source: BuilderSourceSpec = DEFAULT_SDR_SOURCE,
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const step of chainForSource(source)) {
    const a = stepAdjustments(step, builderAdj, source);
    out.set(nodeId(step.kind, step.stage), applyPhase3Override(step.kind, a, step.paramsFn(a, source)));
  }
  return out;
}

/**
 * Refresh the default chain's node params from the current adjustments,
 * leaving topology and any user-added nodes untouched.
 *
 * The graph editor builds its graph once and then owns it, so classic-mode
 * slider edits made afterwards never reached it — the graph view kept
 * rendering the state the graph was born with while the canvas showed the
 * edit. Re-entering graph mode runs this so both views agree on what the
 * sliders currently say.
 *
 * Only nodes the builder itself owns (`default:<kind>`) are rewritten;
 * nodes the user added keep their params, as does the topology.
 */
export function syncDefaultNodeParams(
  graph: RenderGraph,
  builderAdj: BuilderAdjustments,
  source: BuilderSourceSpec = DEFAULT_SDR_SOURCE,
): RenderGraph {
  return withSyncedParams(graph, paramsByNodeFromAdjustments(builderAdj, source));
}

/**
 * Same for a layered graph: base chain, every layer's branch chain
 * (`layer:<id>:default:<kind>`) and the compositor params (`comp:<id>`).
 *
 * `syncDefaultNodeParams` only knows the base chain's ids, so on a layered
 * graph it would leave the branches sitting at the values they were built
 * with — the branch that carries the layer's own edits is exactly the part
 * a classic-mode slider changes.
 *
 * Only the layers that are already in the graph get touched. A layer added
 * or removed since the graph was built changes the topology, which is the
 * caller's cue to rebuild rather than sync.
 */
export function syncLayeredNodeParams(
  graph: RenderGraph,
  baseAdj: BuilderAdjustments,
  layers: BuilderLayer[],
  source: BuilderSourceSpec = DEFAULT_SDR_SOURCE,
): RenderGraph {
  return withSyncedParams(graph, layeredParamsByNode(baseAdj, layers, source));
}

/** Write `params` onto the nodes that carry those ids; unknown ids and every
 *  other node (topology, user-added nodes) stay as they are. */
function withSyncedParams(graph: RenderGraph, params: Map<string, unknown>): RenderGraph {
  const nodes = new Map(graph.nodes);
  let changed = false;
  for (const [id, next] of params) {
    const node = nodes.get(id);
    if (!node) continue;
    nodes.set(id, { ...node, params: next });
    changed = true;
  }
  if (!changed) return graph;
  return {
    ...graph,
    nodes,
    // Plan caches key on (id, revision) — without the bump the worker would
    // serve the plan compiled from the stale params.
    metadata: { ...graph.metadata, revision: graph.metadata.revision + 1 },
  };
}

/**
 * Phase 3: merge the per-pass color-space override (set via UI toggle on
 * ToneCurve / ColorGrading / HSL tabs) into the node's params. The compiler
 * reads `_colorSpaceOverride` and overrides the kind's declared spaces for
 * just this node.
 */
function applyPhase3Override(kind: string, adj: BuilderAdjustments, params: unknown): unknown {
  let space: 'linear' | 'gamma' | undefined;
  if (kind === KIND_TONE_CURVE)    space = adj.toneCurveSpace;
  else if (kind === KIND_COLOR_GRADING) space = adj.colorGradingSpace;
  else if (kind === KIND_HSL || kind === KIND_HSL_DETAIL || kind === KIND_CUSTOM_HSL) space = adj.hslSpace;
  if (!space) return params;
  const merged = { ...(params as Record<string, unknown>) };
  merged['_colorSpaceOverride'] = { inputSpace: space, outputSpace: space };
  return merged;
}

const DEFAULT_SDR_SOURCE: BuilderSourceSpec = {
  kind: 'imageBitmap',
  geometry: { width: 1, height: 1, pixelRatio: 1 },
};

function pluckSharpen(a: BuilderAdjustments): SharpenParams {
  // Editor stores 0..100; the shader expects 0..1.
  return { sharpness: (a.sharpness ?? 0) / 100 };
}

function pluckTransform(a: BuilderAdjustments): TransformParams {
  return {
    // Adjustments.rotation is degrees (slider, straighten tool, CSS fallback);
    // TransformParams.rotation is radians, as the node inspector and the
    // classic pipeline (deleted, tag attic/pre-deadcode-2026-09) both assume.
    // Passing the number through unconverted made
    // every rotation 180/pi times too strong - 5 degrees came out as 5 radians.
    rotation: (a.rotation ?? 0) * Math.PI / 180,
    flipH: a.flipH ?? false,
    flipV: a.flipV ?? false,
    perspectiveH: div100(a.perspectiveH),
    perspectiveV: div100(a.perspectiveV),
    distortion: div100(a.distortion),
  };
}

// ─── RAW (HDR) pluckers — read from source spec, not adjustments ──

function pluckWhiteBalanceRaw(a: BuilderAdjustments, source: BuilderSourceSpec): WhiteBalanceRawParams {
  if (source.kind !== 'raw16') return { wb: [...IDENTITY_RAW_WB] };
  const user = rawWhiteBalanceGains(source.calibration?.asShotNeutral, a.temperature, a.tint);
  const base = source.baseAdjustments;
  if (!base || (!base.temperature && !base.tint)) return { wb: user };

  // The one part of a base profile that needs no pass of its own. RAW white
  // balance is a multiplicative channel gain, and gains compose by
  // multiplying - so the profile's shift rides inside the node the camera
  // gains already live in, exactly, with no second pass and no approximation.
  // Only the profile's RELATIVE gains are multiplied in; the camera's own
  // as-shot gains are already in `user` and must not be applied twice.
  const profile = relativeRawWhiteBalanceGains(base.temperature, base.tint);
  return { wb: [user[0] * profile[0], user[1] * profile[1], user[2] * profile[2]] };
}

function pluckColorMatrix(_a: BuilderAdjustments, source: BuilderSourceSpec): ColorMatrixParams {
  if (source.kind !== 'raw16') return { matrix: [...IDENTITY_COLOR_MATRIX_3X3] };
  const m = source.calibration?.colorMatrix;
  if (!m || m.length < 9) return { matrix: [...IDENTITY_COLOR_MATRIX_3X3] };
  return { matrix: m.slice(0, 9) };
}

function pluckOutputColorSpace(_a: BuilderAdjustments, source: BuilderSourceSpec): OutputColorSpaceParams {
  const id: OutputColorSpaceId = source.outputColorSpaceId ?? 'srgb';
  const def = OUTPUT_COLOR_SPACES[id] ?? OUTPUT_COLOR_SPACES['srgb'];
  return {
    matrix: [...def.matrix],
    gammaType: def.gammaType as 0 | 1 | 2 | 3,
  };
}

// ─── Layered graph (Phase 1.C foundation) ──────────────────────────

import { KIND_COMPOSITE } from './compositorKinds';

/**
 * Builds a layered RenderGraph: one source shared by N+1 adjustment
 * subgraphs (base + N layers), sequential Compositor chain blending them.
 *
 * Topology (per layer i):
 *   source ─→ baseChain ─→ comp_0 ─→ comp_1 ─→ … ─→ output
 *      │                     ↑          ↑
 *      └─→ layerChain_0 ─────┘          │
 *      └─→ layerChain_1 ────────────────┘
 *
 * Each `comp_i` is a Compositor-Node with the running stack on port `in`,
 * the layer's render on port `layer`, and (when `layer.useMask`) a mask
 * SOURCE node (`maskNodeIdForLayer(id)`) wired to port `mask`. The caller
 * rasterizes the mask to an ImageBitmap and binds it under that node id
 * (render-time extraSources) — see useRenderPipeline.renderDoc.
 *
 * Node-id convention:
 *   `default:<kind>`             — base chain
 *   `layer:<layerId>:default:<kind>` — layer chain
 *   `comp:<layerId>`             — compositor binding that layer
 *
 * `paramsByNode` mapping for the caller is provided by
 * `layeredParamsByNode(baseAdj, layers)`.
 */
export function buildLayeredGraph(
  baseAdj: BuilderAdjustments,
  layers: BuilderLayer[],
  source: BuilderSourceSpec,
): DefaultGraphBuildResult {
  const nodes = new Map<string, RenderNode>();
  const edges: Edge[] = [];

  const sourceKind = sourceKindForBuilder(source);
  const sourceParams = sourceParamsForBuilder(source);
  const sourceId = nodeId(sourceKind);
  nodes.set(sourceId, { id: sourceId, kind: sourceKind, params: sourceParams });

  // Base chain: source → adjustments → baseOut
  const baseOutId = emitAdjustmentChain(nodes, edges, sourceId, baseAdj, source, '');

  // Stack output cursor — starts as the base chain's terminal node.
  let stackOutId = baseOutId;

  for (const layer of layers) {
    // Per-layer chain: source → adjustments (layer's deltas merged into base) → layerOut
    const layerOutId = emitAdjustmentChain(
      nodes, edges, sourceId,
      mergeAdjustments(baseAdj, layer.adjustments), source,
      `layer:${layer.id}:`,
    );
    // Compositor: in=stack, layer=layerOut, [mask=external], output=new stack
    const compId = `comp:${layer.id}`;
    nodes.set(compId, {
      id: compId,
      kind: KIND_COMPOSITE,
      params: compositorParams(layer),
    });
    edges.push(linkEdge(`e:${stackOutId}→${compId}.in`, stackOutId, compId));
    edges.push({
      id: `e:${layerOutId}→${compId}.layer`,
      from: { node: layerOutId, port: 'out' },
      to: { node: compId, port: 'layer' },
    });
    // Mask: dedicated source node the caller binds a rasterized mask bitmap
    // to (id via maskNodeIdForLayer). Without the node+edge, u_mask would
    // sample whatever texture happens to sit on its default unit.
    if (layer.useMask) {
      const maskId = maskNodeIdForLayer(layer.id);
      nodes.set(maskId, {
        id: maskId,
        kind: KIND_RASTERIZED_MASK_SOURCE,
        params: {
          width: source.geometry.width,
          height: source.geometry.height,
          pixelRatio: source.geometry.pixelRatio,
        },
      });
      edges.push({
        id: `e:${maskId}→${compId}.mask`,
        from: { node: maskId, port: 'out' },
        to: { node: compId, port: 'mask' },
      });
    }
    stackOutId = compId;
  }

  const now = Date.now();
  return {
    graph: {
      id: layeredGraphId(baseAdj, layers, source),
      nodes,
      edges,
      output: stackOutId,
      metadata: { createdAt: now, updatedAt: now, revision: 1 },
    },
    sourceNodeId: sourceId,
  };
}

/** Emit a fresh adjustment chain rooted at `sourceId`. `prefix` is prepended
 *  to every node id so layered builds can have multiple chains sharing one
 *  source without id collisions. Returns the id of the terminal chain node. */
function emitAdjustmentChain(
  nodes: Map<string, RenderNode>,
  edges: Edge[],
  sourceId: string,
  adj: BuilderAdjustments,
  source: BuilderSourceSpec,
  prefix: string,
): string {
  let prevId = sourceId;
  for (const step of chainForSource(source)) {
    const { kind, paramsFn } = step;
    // Base steps read the camera profile even inside a layer chain: the
    // profile is what the sensor data becomes before anyone edits it, so
    // every branch of a layered graph starts from the same developed image.
    const a = stepAdjustments(step, adj, source);
    const id = `${prefix}${nodeId(kind, step.stage)}`;
    nodes.set(id, { id, kind, params: applyPhase3Override(kind, a, paramsFn(a, source)) });
    edges.push(linkEdge(`e:${prevId}→${id}`, prevId, id));
    prevId = id;
  }
  return prevId;
}

/**
 * Sliders without a zero point: adding them doubles the default.
 *
 * A layer stores the value its panel shows, and a preset layer stores the
 * whole Adjustments object of the photo it was saved from - so a preset
 * carries `denoiseDetail: 50`, `vignetteFeather: 50`, `grainSize: 25` and
 * `lensCorrectionStrength: 100` even when nobody touched them. Added onto a
 * base that holds the same defaults, that rendered the preset branch with
 * twice the feather, twice the grain size, a denoise detail past the schema
 * maximum and the lens corrected twice over.
 */
export const ABSOLUTE_FIELDS: ReadonlySet<keyof BuilderAdjustments> = new Set<keyof BuilderAdjustments>([
  'denoiseDetail', 'vignetteFeather', 'grainSize', 'lensCorrectionStrength',
]);

/**
 * Merge a layer's adjustments onto the base, which is what every branch of a
 * layered graph renders with. Numbers with a zero point are **additive** (a
 * layer's `exposure: 30` adds +30 on top of the base's exposure); the
 * `ABSOLUTE_FIELDS`, booleans and objects override.
 *
 * `layerDeltaFromMerged` in the projection is the inverse of exactly this
 * function; the two change together.
 */
function mergeAdjustments(base: BuilderAdjustments, delta: BuilderAdjustments): BuilderAdjustments {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(delta)) {
    if (typeof v === 'number' && typeof out[k] === 'number' && !ABSOLUTE_FIELDS.has(k as keyof BuilderAdjustments)) {
      out[k] = (out[k] as number) + v;
    } else {
      out[k] = v;
    }
  }
  return out as BuilderAdjustments;
}

/** Compositor params for one layer. One place, so the graph and the
 *  paramsByNode map can never describe the same layer differently. */
function compositorParams(layer: BuilderLayer): Record<string, unknown> {
  const params: Record<string, unknown> = {
    opacity: layer.opacity,
    blendMode: layer.blendMode,
    useMask: layer.useMask ?? false,
  };
  // Omitted rather than set to undefined: the params are compared field by
  // field elsewhere, and an explicit undefined is not the same as absent.
  if (layer.presetSyncId) params.presetSyncId = layer.presetSyncId;
  return params;
}

/** Node id of the mask source emitted for a masked layer — callers bind
 *  their rasterized mask bitmap under this id (extraSources). */
export function maskNodeIdForLayer(layerId: string): string {
  return `mask:${layerId}`;
}

/**
 * Does `graph` still depict exactly this layer stack? Decides sync vs.
 * rebuild for a caller holding a graph the user may have edited: params can
 * be written into an existing graph, a changed stack cannot.
 *
 * Matching means the same compositors (`comp:<id>`), the same mask nodes,
 * and the same stacking order. Order is checked by reachability, not by a
 * direct edge, so a node the user inserted between two compositors keeps its
 * graph syncable instead of triggering a rebuild that would discard it.
 */
export function graphMatchesLayers(graph: RenderGraph, layers: BuilderLayer[]): boolean {
  const compIds = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.kind === KIND_COMPOSITE) compIds.add(node.id);
  }
  if (compIds.size !== layers.length) return false;

  for (const layer of layers) {
    if (!compIds.has(`comp:${layer.id}`)) return false;
    if (!!layer.useMask !== graph.nodes.has(maskNodeIdForLayer(layer.id))) return false;
  }
  for (let i = 0; i + 1 < layers.length; i++) {
    if (!reaches(graph, `comp:${layers[i].id}`, `comp:${layers[i + 1].id}`)) return false;
  }
  return true;
}

/** Is `toId` downstream of `fromId`? */
function reaches(graph: RenderGraph, fromId: string, toId: string): boolean {
  const seen = new Set<string>([fromId]);
  const queue = [fromId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const e of graph.edges) {
      if (e.from.node !== id || seen.has(e.to.node)) continue;
      if (e.to.node === toId) return true;
      seen.add(e.to.node);
      queue.push(e.to.node);
    }
  }
  return false;
}

function layeredGraphId(
  baseAdj: BuilderAdjustments,
  layers: BuilderLayer[],
  source: BuilderSourceSpec,
): string {
  // useMask is topology (mask node + edge exist or not) — cache identity.
  // So is a layer's space override: it is compiled into that layer's nodes and
  // moves the converts, and a layer chain compiles with its adjustments merged
  // onto the base, which is what the signature has to describe.
  const layerKey = layers
    .map((l) => `${l.id}${l.useMask ? '+m' : ''}:${graphSpaceSignature(mergeAdjustments(baseAdj, l.adjustments))}`)
    .join(',');
  const ocs = source.outputColorSpaceId ?? 'srgb';
  const spaces = graphSpaceSignature(baseAdj);
  return `layered-graph:${source.kind}:${source.geometry.width}x${source.geometry.height}:${ocs}:${spaces}${baseStageMark(source)}:[${layerKey}]`;
}

/**
 * paramsByNode mapping for a layered graph. Keys match `buildLayeredGraph`
 * node ids so callers can drop the result into PipelineService's render
 * methods without rebuilding the graph each time params change.
 */
export function layeredParamsByNode(
  baseAdj: BuilderAdjustments,
  layers: BuilderLayer[],
  source: BuilderSourceSpec = { kind: 'imageBitmap', geometry: { width: 1, height: 1, pixelRatio: 1 } },
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const step of chainForSource(source)) {
    const a = stepAdjustments(step, baseAdj, source);
    out.set(nodeId(step.kind, step.stage), applyPhase3Override(step.kind, a, step.paramsFn(a, source)));
  }
  for (const layer of layers) {
    const merged = mergeAdjustments(baseAdj, layer.adjustments);
    for (const step of chainForSource(source)) {
      const a = stepAdjustments(step, merged, source);
      out.set(`layer:${layer.id}:${nodeId(step.kind, step.stage)}`, applyPhase3Override(step.kind, a, step.paramsFn(a, source)));
    }
    out.set(`comp:${layer.id}`, compositorParams(layer));
  }
  return out;
}
