/**
 * Shared material for the projection tests: documents that are off the
 * default in every field the graph can carry, the forward path the app
 * actually walks, and the graph surgery the blocking rules are provoked
 * with. Same idea as [compat/syntheticFixtures.ts](../compat/syntheticFixtures.ts):
 * the fixtures live in a module so the unit tests and the step-2 acceptance
 * suite measure the same thing instead of each keeping their own copy.
 *
 * Nothing in here renders — the projection is pure, and so is this.
 */
import {
  adjustmentsToBuilderAdjustments,
  type BuilderRaw16Source,
  type BuilderSourceSpec,
} from '../DefaultGraphBuilder';
import { buildDocumentGraph } from '../documentGraph';
import {
  DOCUMENT_VERSION,
  type DocLayer,
  type PhotoDocument,
} from '../../DocumentModel';
import { defaultAdjustments, type Adjustments } from '../../../types';
import type { MaskDefinition } from '../../Mask';
import type { Edge, RenderGraph } from '../types';

export const SDR: BuilderSourceSpec = {
  kind: 'imageBitmap',
  geometry: { width: 16, height: 8, pixelRatio: 1 },
};

const RAW_CALIBRATION: BuilderRaw16Source['calibration'] = {
  asShotNeutral: [2.104, 1, 1.553],
  colorMatrix: [1.9, -0.8, -0.1, -0.2, 1.5, -0.3, 0.05, -0.4, 1.35],
};

export const RAW: BuilderSourceSpec = {
  kind: 'raw16',
  geometry: { width: 16, height: 8, pixelRatio: 1 },
  channels: 3,
  baseAdjustments: null,
  lensProfile: null,
  calibration: RAW_CALIBRATION,
};

/**
 * The same RAW as the app hands it over once the camera has a develop
 * profile and the lens a measured correction: a base stage in the chain and
 * a lens pass that corrects without anyone switching it on. The coefficients
 * match no `LENS_PROFILES` entry, because a measured profile never does. The base goes through the same defaults merge as
 * `toBuilderBase`, spelled out here so the fixture pulls in no store.
 */
export const RAW_PROFILED: BuilderSourceSpec = {
  ...(RAW as BuilderRaw16Source),
  baseAdjustments: adjustmentsToBuilderAdjustments({
    ...defaultAdjustments,
    exposure: 30, contrast: -12, clarity: 15, sharpness: 40,
    toneCurve: {
      ...defaultAdjustments.toneCurve,
      rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.56 }, { x: 1, y: 1 }],
    },
  }),
  lensProfile: { k1: 0.021, k2: -0.004, k3: 0, v1: -0.12, v2: 0.03, v3: 0, caR: 0.0007, caB: -0.0005 },
};

/** A raw16 source without base profile and lens correction. Production
 *  callers must state both (see BuilderRaw16Source); a test that is about
 *  neither states "none" here once instead of in every literal. */
export function raw16Source(over: Partial<Omit<BuilderRaw16Source, 'kind'>> = {}): BuilderRaw16Source {
  return {
    kind: 'raw16',
    geometry: { width: 16, height: 8, pixelRatio: 1 },
    channels: 3,
    baseAdjustments: null,
    lensProfile: null,
    ...over,
  };
}

export const MASK: MaskDefinition = {
  id: 'm1', name: 'Radial', type: 'radial-gradient', visible: true,
  center: { x: 0.4, y: 0.6 }, radiusX: 0.3, radiusY: 0.25, feather: 0.5,
};

/**
 * A layer's own edits, off the default in every field the graph can carry.
 * Deliberately not just one slider: a delta that only moves `exposure` would
 * pass even if the write-back dropped every other field.
 */
export const LAYER_DELTA: Partial<Adjustments> = {
  exposure: 12, contrast: -8, clarity: 17,
  hsl: { ...defaultAdjustments.hsl, red: { hue: 9, saturation: -4, luminance: 6 } },
};

/** Base edits, off the default in every field the base chain can carry. */
export const BASE_ADJUSTMENTS: Partial<Adjustments> = {
  exposure: 37, contrast: -18, highlights: 42.5, shadows: -7, whites: 12, blacks: -33,
  temperature: 23, tint: -14, vibrance: 31, saturation: -22,
  clarity: 28, dehaze: -16, texture: 44,
  sharpness: 82, noiseReduction: 9, denoiseLuma: 19, denoiseChroma: 63, denoiseDetail: 37,
  bwEnabled: true,
  bwMix: { red: 15, orange: -20, yellow: 5, green: 40, aqua: -10, blue: 25, purple: -35, magenta: 8 },
  levels: {
    rgb:   { inBlack: 12, inWhite: 243, gamma: 1.35, outBlack: 5, outWhite: 250 },
    red:   { inBlack: 3, inWhite: 200, gamma: 0.8, outBlack: 0, outWhite: 255 },
    green: { inBlack: 0, inWhite: 255, gamma: 1.2, outBlack: 10, outWhite: 240 },
    blue:  { inBlack: 20, inWhite: 230, gamma: 1, outBlack: 0, outWhite: 255 },
  },
  toneCurve: {
    rgb:   [{ x: 0, y: 0.05 }, { x: 0.4, y: 0.35 }, { x: 1, y: 0.95 }],
    luma:  [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }],
    red:   [{ x: 0, y: 0.02 }, { x: 1, y: 1 }],
    green: [{ x: 0, y: 0 }, { x: 1, y: 0.98 }],
    blue:  [{ x: 0, y: 0 }, { x: 0.7, y: 0.65 }, { x: 1, y: 1 }],
  },
  hsl: {
    red:     { hue: 10, saturation: -20, luminance: 30 },
    orange:  { hue: -5, saturation: 15, luminance: -8 },
    yellow:  { hue: 22, saturation: 40, luminance: 3 },
    green:   { hue: -33, saturation: -12, luminance: 19 },
    aqua:    { hue: 7, saturation: 28, luminance: -25 },
    blue:    { hue: -41, saturation: 9, luminance: 14 },
    purple:  { hue: 16, saturation: -37, luminance: 6 },
    magenta: { hue: -2, saturation: 21, luminance: -17 },
  },
  colorGrading: {
    shadows:    { hue: 210, saturation: 30, satAdj: -25, lumAdj: 18 },
    midtones:   { hue: 45, saturation: 12, satAdj: 33, lumAdj: -9 },
    highlights: { hue: 330, saturation: 55, satAdj: 7, lumAdj: 41 },
    balance: -35, blending: 72,
  },
  skinToneUniformity: { hue: 33, saturation: 21, luminance: 47 },
  lensCorrection: true, lensCorrectionProfile: 'sony-fe-24-70-2.8', lensCorrectionStrength: 65,
  toneCurveSpace: 'gamma', colorGradingSpace: 'linear', hslSpace: 'gamma',
  // Not builder-owned: has to survive the projection untouched.
  sharpenRadius: 2.4, colorEditorMode: 'advanced', aiDenoiseStrength: 42,
};

/** Document-level values, which the base chain carries but the document
 *  stores outside the layers. */
export const DOC_TRANSFORM = {
  rotation: 37.5, flipH: true, flipV: true, cropAspect: '16:9' as Adjustments['cropAspect'],
  perspectiveV: 13, perspectiveH: -21, distortion: 6,
};
export const DOC_EFFECTS = { vignette: -47, vignetteFeather: 31, grain: 26, grainSize: 18 };

export function layer(over: Partial<DocLayer> & { id: string }): DocLayer {
  return {
    name: 'Anpassung', type: 'adjustment', visible: true, opacity: 1,
    blendMode: 'normal', locked: false, adjustments: {}, mask: null,
    ...over,
  };
}

export function documentWith(
  layers: DocLayer[],
  base: Partial<Adjustments> = BASE_ADJUSTMENTS,
): PhotoDocument {
  return {
    version: DOCUMENT_VERSION,
    layers: [layer({ id: 'base', name: 'Entwicklung', type: 'base', adjustments: base }), ...layers],
    transform: { ...DOC_TRANSFORM },
    finalEffects: { ...DOC_EFFECTS },
  };
}

/**
 * The forward path — literally the function the app walks
 * ([documentGraph.ts](../documentGraph.ts)), not a mirror of it. The base gets
 * the flattened document (so the document-level transform and effects ride
 * along), every visible adjustment layer at non-zero opacity becomes a branch.
 */
export function graphFor(doc: PhotoDocument, source: BuilderSourceSpec = SDR): RenderGraph {
  return buildDocumentGraph(doc, source).graph;
}

export function findLayer(doc: PhotoDocument, id: string): DocLayer {
  const found = doc.layers.find((l) => l.id === id);
  if (!found) throw new Error(`no layer ${id} in ${doc.layers.map((l) => l.id).join(', ')}`);
  return found;
}

// ─── Graph surgery ────────────────────────────────────────────────
//
// A stored graph is user-editable, so every blocking rule has to be
// provoked from a real graph rather than from a hand-written one — that way
// the fixtures cannot drift away from what the builder emits.

export function nodeParams(graph: RenderGraph, id: string): Record<string, unknown> {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`no node ${id}`);
  return (node.params && typeof node.params === 'object')
    ? node.params as Record<string, unknown>
    : {};
}

export function patchParams(
  graph: RenderGraph,
  id: string,
  patch: Record<string, unknown>,
): RenderGraph {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`no node ${id}`);
  const nodes = new Map(graph.nodes);
  nodes.set(id, { ...node, params: { ...nodeParams(graph, id), ...patch } });
  return { ...graph, nodes };
}

/** Replace a chain node's kind in place — the shape stays intact, the
 *  contents stop being classic. */
export function retypeNode(graph: RenderGraph, id: string, kind: string): RenderGraph {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`no node ${id}`);
  const nodes = new Map(graph.nodes);
  nodes.set(id, { ...node, kind, params: {} });
  return { ...graph, nodes };
}

/** Drop a node and bridge its inbound `in` edge to its consumers, so the
 *  chain stays walkable — a deleted node is not supposed to block. */
export function withoutNode(graph: RenderGraph, id: string): RenderGraph {
  const nodes = new Map(graph.nodes);
  nodes.delete(id);
  const inbound = graph.edges.find((e) => e.to.node === id && e.to.port === 'in');
  const outbound = graph.edges.filter((e) => e.from.node === id);
  const edges = graph.edges.filter((e) => e.to.node !== id && e.from.node !== id);
  if (inbound) {
    for (const out of outbound) {
      edges.push({ id: `e:bridge:${out.to.node}:${out.to.port}`, from: inbound.from, to: out.to });
    }
  }
  return {
    ...graph,
    nodes,
    edges,
    output: graph.output === id ? inbound?.from.node ?? graph.output : graph.output,
  };
}

/** Splice a new node into the chain directly behind `afterId` — how a user
 *  adds a node in the editor. */
export function insertAfter(
  graph: RenderGraph,
  afterId: string,
  id: string,
  kind: string,
  params: unknown = {},
): RenderGraph {
  const nodes = new Map(graph.nodes);
  nodes.set(id, { id, kind, params });
  const edges: Edge[] = [];
  for (const edge of graph.edges) {
    edges.push(edge.from.node === afterId ? { ...edge, from: { node: id, port: 'out' } } : edge);
  }
  edges.push({
    id: `e:${afterId}→${id}`,
    from: { node: afterId, port: 'out' },
    to: { node: id, port: 'in' },
  });
  return {
    ...graph,
    nodes,
    edges,
    output: graph.output === afterId ? id : graph.output,
  };
}

/** Re-point one input port at another producer. */
export function rewire(
  graph: RenderGraph,
  to: { node: string; port: string },
  fromNode: string,
): RenderGraph {
  let found = false;
  const edges = graph.edges.map((edge) => {
    if (edge.to.node !== to.node || edge.to.port !== to.port) return edge;
    found = true;
    return { ...edge, from: { node: fromNode, port: 'out' } };
  });
  if (!found) throw new Error(`no edge into ${to.node}.${to.port}`);
  return { ...graph, edges };
}

/** Add a second consumer for a node's output. */
export function addEdge(
  graph: RenderGraph,
  fromNode: string,
  to: { node: string; port: string },
): RenderGraph {
  return {
    ...graph,
    edges: [...graph.edges, {
      id: `e:extra:${fromNode}→${to.node}.${to.port}`,
      from: { node: fromNode, port: 'out' },
      to: { ...to },
    }],
  };
}

export function withoutEdgeInto(
  graph: RenderGraph,
  to: { node: string; port: string },
): RenderGraph {
  return {
    ...graph,
    edges: graph.edges.filter((e) => !(e.to.node === to.node && e.to.port === to.port)),
  };
}
