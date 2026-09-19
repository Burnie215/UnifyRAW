import { describe, expect, it } from 'vitest';

import {
  adjustmentsFromChainParams,
  layerDeltaFromMerged,
  paramsToAdjustments,
  PARAM_REASONS,
  type ProjectedParams,
} from './paramsToAdjustments';
import { scanGraphShape } from './shapeScan';
import { defaultAdjustments } from '../../../types';
import { TRANSFORM_FIELDS } from '../../DocumentModel';
import { RAW_PROFILED } from './projectionFixtures';
import {
  adjustmentsToBuilderAdjustments,
  buildDefaultGraph,
  buildLayeredGraph,
  paramsByNodeFromAdjustments,
  chainKindsForSource,
  type BuilderAdjustments,
  type BuilderLayer,
  type BuilderSourceSpec,
} from '../DefaultGraphBuilder';
import {
  KIND_CLARITY,
  KIND_COLOR_GRADING,
  KIND_COLOR_MATRIX,
  KIND_CUSTOM_HSL,
  KIND_EFFECTS,
  KIND_HSL,
  KIND_HSL_DETAIL,
  KIND_LENS_CORRECTION,
  KIND_LEVELS,
  KIND_OUTPUT_COLOR_SPACE,
  KIND_SHARPEN,
  KIND_TEXTURE,
  KIND_TONE,
  KIND_TONE_CURVE,
  KIND_TRANSFORM,
  KIND_WHITE_BALANCE,
  KIND_WHITE_BALANCE_RAW,
} from '../passKinds';
import type { RenderGraph } from '../types';

const SDR: BuilderSourceSpec = {
  kind: 'imageBitmap',
  geometry: { width: 16, height: 8, pixelRatio: 1 },
};

const RAW: BuilderSourceSpec = {
  kind: 'raw16',
  geometry: { width: 16, height: 8, pixelRatio: 1 },
  channels: 3,
  baseAdjustments: null,
  lensProfile: null,
  calibration: {
    asShotNeutral: [2.104, 1, 1.553],
    colorMatrix: [1.9, -0.8, -0.1, -0.2, 1.5, -0.3, 0.05, -0.4, 1.35],
  },
};

const hslChannels = () => ({
  red:     { hue: 10, saturation: -20, luminance: 30 },
  orange:  { hue: -5, saturation: 15, luminance: -8 },
  yellow:  { hue: 22, saturation: 40, luminance: 3 },
  green:   { hue: -33, saturation: -12, luminance: 19 },
  aqua:    { hue: 7, saturation: 28, luminance: -25 },
  blue:    { hue: -41, saturation: 9, luminance: 14 },
  purple:  { hue: 16, saturation: -37, luminance: 6 },
  magenta: { hue: -2, saturation: 21, luminance: -17 },
});

/**
 * Every value here is off its default on purpose. A round-trip fixture built
 * from defaults is equal to itself no matter what the inverse does, so it
 * would prove nothing — the guard test below asserts that this fixture moves
 * every node in the chain away from identity.
 */
const RICH: BuilderAdjustments = {
  exposure: 37, contrast: -18, highlights: 42.5, shadows: -7, whites: 12, blacks: -33,
  temperature: 23, tint: -14,
  vibrance: 31, saturation: -22,
  levels: {
    rgb:   { inBlack: 12, inWhite: 243, gamma: 1.35, outBlack: 5, outWhite: 250 },
    red:   { inBlack: 3, inWhite: 200, gamma: 0.8, outBlack: 0, outWhite: 255 },
    green: { inBlack: 0, inWhite: 255, gamma: 1.2, outBlack: 10, outWhite: 240 },
    blue:  { inBlack: 20, inWhite: 230, gamma: 1, outBlack: 0, outWhite: 255 },
  },
  bwEnabled: true,
  bwMix: { red: 15, orange: -20, yellow: 5, green: 40, aqua: -10, blue: 25, purple: -35, magenta: 8 },
  toneCurve: {
    rgb:   [{ x: 0, y: 0.05 }, { x: 0.4, y: 0.35 }, { x: 1, y: 0.95 }],
    luma:  [{ x: 0, y: 0 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }],
    red:   [{ x: 0, y: 0.02 }, { x: 1, y: 1 }],
    green: [{ x: 0, y: 0 }, { x: 1, y: 0.98 }],
    blue:  [{ x: 0, y: 0 }, { x: 0.7, y: 0.65 }, { x: 1, y: 1 }],
  },
  hsl: hslChannels(),
  hslViewSelected: { hue: 210, halfWidth: 25, satMin: 0.1, satMax: 0.9 },
  hslSkinTone: { refHue: 28, refSat: 45, refLum: 60, uniHue: 0.3, uniSat: 0.4, uniLum: 0.5, halfWidth: 18 },
  customHslSectors: [
    { hueCenter: 120, hueHalfWidth: 30, feather: 0.25, dH: 5, dS: -10, dL: 15, enabled: true },
    { hueCenter: 300, hueHalfWidth: 15, feather: 0.5, dH: -3, dS: 8, dL: -6, enabled: true },
  ],
  colorGrading: {
    shadows:    { hue: 210, saturation: 30, satAdj: -25, lumAdj: 18 },
    midtones:   { hue: 45, saturation: 12, satAdj: 33, lumAdj: -9 },
    highlights: { hue: 330, saturation: 55, satAdj: 7, lumAdj: 41 },
    balance: -35, blending: 72,
  },
  clarity: 28, dehaze: -16, texture: 44,
  denoiseLuma: 19, denoiseChroma: 63, denoiseDetail: 37,
  sharpness: 82,
  vignette: -47, vignetteFeather: 31, grain: 26, grainSize: 18, noiseReduction: 9,
  rotation: 37.5, flipH: true, flipV: true, perspectiveH: -21, perspectiveV: 13, distortion: 6,
  lensCorrection: true, lensCorrectionProfile: 'sony-fe-24-70-2.8', lensCorrectionStrength: 65,
  toneCurveSpace: 'gamma', colorGradingSpace: 'linear', hslSpace: 'gamma',
};

const L1: BuilderLayer = { id: 'L1', adjustments: { contrast: 20 }, opacity: 0.8, blendMode: 'normal' };
const L2: BuilderLayer = { id: 'L2', adjustments: { exposure: 15 }, opacity: 0.5, blendMode: 'multiply' };

// ─── helpers ──────────────────────────────────────────────────────

function project(graph: RenderGraph, source: BuilderSourceSpec): ProjectedParams {
  const scan = scanGraphShape(graph);
  if (!scan.ok) throw new Error('shape scan blocked: ' + JSON.stringify(scan.blocked));
  const result = paramsToAdjustments(graph, scan.shape, source);
  if (!result.ok) throw new Error('projection blocked: ' + JSON.stringify(result.blocked));
  return result.projected;
}

function blockedBy(graph: RenderGraph, source: BuilderSourceSpec) {
  const scan = scanGraphShape(graph);
  if (!scan.ok) throw new Error('shape scan blocked: ' + JSON.stringify(scan.blocked));
  const result = paramsToAdjustments(graph, scan.shape, source);
  if (result.ok) throw new Error('expected the projection to block, it did not');
  return result.blocked;
}

function nodeParams(graph: RenderGraph, id: string): Record<string, unknown> {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`no node ${id}`);
  return node.params as Record<string, unknown>;
}

function patchParams(graph: RenderGraph, id: string, patch: Record<string, unknown>): RenderGraph {
  const node = graph.nodes.get(id);
  if (!node) throw new Error(`no node ${id}`);
  const nodes = new Map(graph.nodes);
  nodes.set(id, { ...node, params: { ...(node.params as object), ...patch } });
  return { ...graph, nodes };
}

/** Drop a node and bridge its inbound `in` edge to its consumers, so the
 *  chain stays walkable — a deleted node is not supposed to block. */
function withoutNode(graph: RenderGraph, id: string): RenderGraph {
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

const asObject = (map: Map<string, unknown>) => Object.fromEntries(map);

// ─── the fixture has to be non-trivial ────────────────────────────

describe('round-trip fixture', () => {
  it('moves every node in the chain off its identity params', () => {
    const identity = paramsByNodeFromAdjustments({}, SDR);
    const rich = paramsByNodeFromAdjustments(RICH, SDR);
    // outputColorSpace carries no adjustment at all, so it is the one node
    // that cannot differ; everything else has to, or the round-trip tests
    // below would be comparing defaults with defaults.
    const unchanged = chainKindsForSource(SDR).filter(
      (kind) => JSON.stringify(identity.get(`default:${kind}`)) === JSON.stringify(rich.get(`default:${kind}`)),
    );
    expect(unchanged).toEqual(['outputColorSpace']);
  });
});

// ─── round trips ──────────────────────────────────────────────────

describe('paramsToAdjustments round trip', () => {
  it('reads a base-only SDR graph back field for field', () => {
    const graph = buildDefaultGraph(RICH, SDR).graph;
    const projected = project(graph, SDR);
    expect(projected.base).toEqual(RICH);
    expect(projected.layers).toEqual([]);
  });

  it('is a fixed point on the params side for SDR', () => {
    const graph = buildDefaultGraph(RICH, SDR).graph;
    const back = project(graph, SDR).base;
    expect(asObject(paramsByNodeFromAdjustments(back, SDR)))
      .toEqual(asObject(paramsByNodeFromAdjustments(RICH, SDR)));
  });

  it('reads a raw graph back, temperature and tint out of the raw gains', () => {
    const graph = buildDefaultGraph(RICH, RAW).graph;
    const back = project(graph, RAW).base;
    // The raw chain has no whiteBalance node at all; the sliders live in the
    // multiplicative gains of whiteBalanceRaw.
    expect(chainKindsForSource(RAW)).not.toContain(KIND_WHITE_BALANCE);
    expect(back.temperature).toBe(23);
    expect(back.tint).toBe(-14);
    expect(back).toEqual(RICH);
  });

  it('is a fixed point on the params side for raw', () => {
    const graph = buildDefaultGraph(RICH, RAW).graph;
    const back = project(graph, RAW).base;
    expect(asObject(paramsByNodeFromAdjustments(back, RAW)))
      .toEqual(asObject(paramsByNodeFromAdjustments(RICH, RAW)));
  });

  it('reads a layered graph back to base plus per-layer deltas', () => {
    const graph = buildLayeredGraph(RICH, [L1, L2], SDR).graph;
    const projected = project(graph, SDR);
    expect(projected.base).toEqual(RICH);
    expect(projected.layers.map((l) => l.compositorId)).toEqual(['comp:L1', 'comp:L2']);
    // mergeAdjustments is additive on numbers, so the delta subtracts.
    expect(projected.layers[0].merged.contrast).toBe(-18 + 20);
    expect(projected.layers[0].delta).toEqual({ contrast: 20 });
    expect(projected.layers[1].delta).toEqual({ exposure: 15 });
  });

  it('materializes the Custom HSL schema default for an omitted enabled flag', () => {
    const graph = buildDefaultGraph(RICH, SDR).graph;
    const id = `default:${KIND_CUSTOM_HSL}`;
    const sectors = nodeParams(graph, id).sectors as Record<string, unknown>[];
    const withoutEnabled = { ...sectors[0] };
    delete withoutEnabled.enabled;

    const omitted = project(patchParams(graph, id, {
      sectors: [withoutEnabled, ...sectors.slice(1)],
    }), SDR);
    expect(omitted.base.customHslSectors?.[0].enabled).toBe(true);

    const disabled = project(patchParams(graph, id, {
      sectors: [{ ...sectors[0], enabled: false }, ...sectors.slice(1)],
    }), SDR);
    expect(disabled.base.customHslSectors?.[0].enabled).toBe(false);
  });

  it('reads a masked and a blended layer back the same way', () => {
    const graph = buildLayeredGraph(RICH, [{ ...L1, useMask: true }, L2], SDR).graph;
    const projected = project(graph, SDR);
    expect(projected.layers[0].delta).toEqual({ contrast: 20 });
    expect(projected.layers[1].delta).toEqual({ exposure: 15 });
  });
});

// ─── the individual conversion factors ────────────────────────────

describe('conversion factors', () => {
  const cases: Array<{
    field: keyof BuilderAdjustments; kind: string; param: string; value: number; shader: number;
  }> = [
    { field: 'exposure', kind: KIND_TONE, param: 'exposure', value: 37, shader: 0.37 },
    { field: 'blacks', kind: KIND_TONE, param: 'blacks', value: -33, shader: -0.33 },
    { field: 'temperature', kind: KIND_WHITE_BALANCE, param: 'temperature', value: 23, shader: 0.23 },
    { field: 'vibrance', kind: KIND_HSL, param: 'vibrance', value: 31, shader: 0.31 },
    { field: 'clarity', kind: KIND_CLARITY, param: 'clarity', value: 28, shader: 0.28 },
    { field: 'texture', kind: KIND_TEXTURE, param: 'amount', value: 44, shader: 0.44 },
    { field: 'sharpness', kind: KIND_SHARPEN, param: 'sharpness', value: 82, shader: 0.82 },
    { field: 'vignette', kind: KIND_EFFECTS, param: 'vignette', value: -47, shader: -0.47 },
    // Not scaled: grain size is a pixel count on both sides.
    { field: 'grainSize', kind: KIND_EFFECTS, param: 'grainSize', value: 18, shader: 18 },
    { field: 'perspectiveH', kind: KIND_TRANSFORM, param: 'perspectiveH', value: -21, shader: -0.21 },
    // Degrees in the editor, radians in the node.
    { field: 'rotation', kind: KIND_TRANSFORM, param: 'rotation', value: 90, shader: Math.PI / 2 },
    { field: 'rotation', kind: KIND_TRANSFORM, param: 'rotation', value: -37.5, shader: -37.5 * Math.PI / 180 },
  ];

  for (const c of cases) {
    it(`${String(c.field)} = ${c.value} is ${c.shader} in the node and comes back`, () => {
      const graph = buildDefaultGraph({ [c.field]: c.value } as BuilderAdjustments, SDR).graph;
      expect(nodeParams(graph, `default:${c.kind}`)[c.param]).toBeCloseTo(c.shader, 12);
      expect(project(graph, SDR).base[c.field]).toBe(c.value);
    });
  }

  it('levels endpoints are 0..255 in the editor and 0..1 in the node, gamma untouched', () => {
    const levels = { rgb: { inBlack: 12, inWhite: 243, gamma: 1.35, outBlack: 5, outWhite: 250 } };
    const graph = buildDefaultGraph({ levels }, SDR).graph;
    const params = nodeParams(graph, `default:${KIND_LEVELS}`).rgb as Record<string, number>;
    expect(params.inBlack).toBeCloseTo(12 / 255, 12);
    expect(params.inWhite).toBeCloseTo(243 / 255, 12);
    expect(params.gamma).toBe(1.35);
    expect(project(graph, SDR).base.levels?.rgb).toEqual(levels.rgb);
  });

  it('color-grading arcs are -100..100 in the editor and -1..1 in the node', () => {
    const graph = buildDefaultGraph(RICH, SDR).graph;
    const zone = nodeParams(graph, `default:${KIND_COLOR_GRADING}`).shadows as Record<string, number>;
    expect(zone.satAdj).toBeCloseTo(-0.25, 12);
    expect(zone.lumAdj).toBeCloseTo(0.18, 12);
    // hue and saturation of a zone are not scaled.
    expect(zone.hue).toBe(210);
    expect(zone.saturation).toBe(30);
    expect(project(graph, SDR).base.colorGrading).toEqual(RICH.colorGrading);
  });

  it('HSL channels, BW mix and curve points pass through unscaled', () => {
    const graph = buildDefaultGraph(RICH, SDR).graph;
    expect(nodeParams(graph, `default:${KIND_HSL_DETAIL}`).channels).toEqual(hslChannels());
    const back = project(graph, SDR).base;
    expect(back.hsl).toEqual(RICH.hsl);
    expect(back.bwMix).toEqual(RICH.bwMix);
    expect(back.toneCurve).toEqual(RICH.toneCurve);
  });
});

// ─── camera metadata rule ─────────────────────────────────────────

describe('source-derived node params', () => {
  it('stays silent on the graph the builder produced', () => {
    const graph = buildDefaultGraph(RICH, RAW).graph;
    const scan = scanGraphShape(graph);
    if (!scan.ok) throw new Error('shape scan blocked');
    expect(paramsToAdjustments(graph, scan.shape, RAW).ok).toBe(true);
  });

  it('blocks an edited color matrix', () => {
    const graph = buildDefaultGraph(RICH, RAW).graph;
    const tampered = patchParams(graph, `default:${KIND_COLOR_MATRIX}`, {
      matrix: [1.9, -0.8, -0.1, -0.2, 1.5, -0.3, 0.05, -0.4, 1.9],
    });
    expect(blockedBy(tampered, RAW)).toEqual([
      { nodeId: `default:${KIND_COLOR_MATRIX}`, reason: PARAM_REASONS.cameraMetadata(KIND_COLOR_MATRIX) },
    ]);
  });

  it('blocks a color matrix that belongs to another camera', () => {
    const graph = buildDefaultGraph(RICH, RAW).graph;
    // Right shape, wrong source: the matrix of the graph does not match the
    // spec the projection is asked to write the document for.
    const otherCamera: BuilderSourceSpec = {
      ...RAW, calibration: { ...RAW.calibration, colorMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    } as BuilderSourceSpec;
    const scan = scanGraphShape(graph);
    if (!scan.ok) throw new Error('shape scan blocked');
    const result = paramsToAdjustments(graph, scan.shape, otherCamera);
    expect(result.ok).toBe(false);
  });

  it('blocks raw gains that the camera values and the two sliders cannot make', () => {
    const graph = buildDefaultGraph(RICH, RAW).graph;
    // Scaling all three channels by the same factor is an exposure move, and
    // the relative gains keep their geometric mean at one — so no
    // temperature/tint pair reproduces this.
    const wb = nodeParams(graph, `default:${KIND_WHITE_BALANCE_RAW}`).wb as number[];
    const tampered = patchParams(graph, `default:${KIND_WHITE_BALANCE_RAW}`, {
      wb: [wb[0] * 1.4, wb[1] * 1.4, wb[2] * 1.4],
    });
    expect(blockedBy(tampered, RAW)).toEqual([
      {
        nodeId: `default:${KIND_WHITE_BALANCE_RAW}`,
        reason: PARAM_REASONS.cameraMetadata(KIND_WHITE_BALANCE_RAW),
      },
    ]);
  });

  it('blocks raw gains whose camera part was replaced', () => {
    const graph = buildDefaultGraph(RICH, RAW).graph;
    const wb = nodeParams(graph, `default:${KIND_WHITE_BALANCE_RAW}`).wb as number[];
    const tampered = patchParams(graph, `default:${KIND_WHITE_BALANCE_RAW}`, {
      wb: [wb[0] * 1.25, wb[1], wb[2]],
    });
    expect(blockedBy(tampered, RAW).map((b) => b.reason)).toEqual([
      PARAM_REASONS.cameraMetadata(KIND_WHITE_BALANCE_RAW),
    ]);
  });

  it('recovers the sliders for gains built from a different camera', () => {
    const other: BuilderSourceSpec = {
      ...RAW, calibration: { ...RAW.calibration, asShotNeutral: [1.4, 1.02, 2.31] },
    } as BuilderSourceSpec;
    const graph = buildDefaultGraph({ temperature: -61, tint: 44 }, other).graph;
    const back = project(graph, other).base;
    expect(back.temperature).toBe(-61);
    expect(back.tint).toBe(44);
  });

  it('accepts the output colour space selected by the source spec', () => {
    const p3: BuilderSourceSpec = { ...SDR, outputColorSpaceId: 'display-p3' };
    const graph = buildDefaultGraph(RICH, p3).graph;

    expect(project(graph, p3).base).toEqual(RICH);
  });

  it('blocks a hand-written output colour-space matrix', () => {
    const graph = buildDefaultGraph(RICH, SDR).graph;
    const id = `default:${KIND_OUTPUT_COLOR_SPACE}`;
    const tampered = patchParams(graph, id, {
      matrix: [0.9, 0.1, 0, 0, 1, 0, 0, 0, 1],
    });

    expect(blockedBy(tampered, SDR)).toEqual([
      { nodeId: id, reason: PARAM_REASONS.cameraMetadata(KIND_OUTPUT_COLOR_SPACE) },
    ]);
  });

  it('blocks an output colour space built for a different source target', () => {
    const p3: BuilderSourceSpec = { ...SDR, outputColorSpaceId: 'display-p3' };
    const graph = buildDefaultGraph(RICH, p3).graph;

    expect(blockedBy(graph, SDR)).toEqual([
      {
        nodeId: `default:${KIND_OUTPUT_COLOR_SPACE}`,
        reason: PARAM_REASONS.cameraMetadata(KIND_OUTPUT_COLOR_SPACE),
      },
    ]);
  });
});

// ─── cross-branch rule: transform and effects ─────────────────────

describe('transform and effects have to be identical across branches', () => {
  it('stays silent when the builder built the branches', () => {
    const graph = buildLayeredGraph(RICH, [L1, L2], SDR).graph;
    const scan = scanGraphShape(graph);
    if (!scan.ok) throw new Error('shape scan blocked');
    expect(paramsToAdjustments(graph, scan.shape, SDR).ok).toBe(true);
  });

  it('stays silent for a document without layers, whatever the transform says', () => {
    const graph = buildDefaultGraph({ rotation: 12, flipH: true, vignette: -40 }, SDR).graph;
    expect(project(graph, SDR).base.rotation).toBe(12);
  });

  it('blocks a branch whose rotation was edited', () => {
    const graph = buildLayeredGraph(RICH, [L1, L2], SDR).graph;
    const id = `layer:L1:default:${KIND_TRANSFORM}`;
    const tampered = patchParams(graph, id, { rotation: 0.5 });
    expect(blockedBy(tampered, SDR)).toEqual([
      { nodeId: id, reason: PARAM_REASONS.branchDiffers('rotation') },
    ]);
  });

  it('blocks a layer that carries a transform delta of its own', () => {
    // This is the 2026-05-17 regression: transform in a layer's adjustments
    // used to mirror the image once per layer.
    const graph = buildLayeredGraph(RICH, [{ ...L1, adjustments: { rotation: 5, flipH: false } }, L2], SDR).graph;
    const reasons = blockedBy(graph, SDR).map((b) => b.reason);
    expect(reasons).toContainEqual(PARAM_REASONS.branchDiffers('rotation'));
    expect(reasons).toContainEqual(PARAM_REASONS.branchDiffers('flipH'));
  });

  it('blocks a branch that lost the transform node while the base rotates', () => {
    const graph = buildLayeredGraph(RICH, [L1], SDR).graph;
    const stripped = withoutNode(graph, `layer:L1:default:${KIND_TRANSFORM}`);
    expect(blockedBy(stripped, SDR)).toEqual([
      { nodeId: 'comp:L1', reason: PARAM_REASONS.branchDiffers('rotation') },
      { nodeId: 'comp:L1', reason: PARAM_REASONS.branchDiffers('flipH') },
      { nodeId: 'comp:L1', reason: PARAM_REASONS.branchDiffers('flipV') },
      { nodeId: 'comp:L1', reason: PARAM_REASONS.branchDiffers('perspectiveH') },
      { nodeId: 'comp:L1', reason: PARAM_REASONS.branchDiffers('perspectiveV') },
      { nodeId: 'comp:L1', reason: PARAM_REASONS.branchDiffers('distortion') },
    ]);
  });

  it('stays silent when a branch loses a transform node that was identity anyway', () => {
    const base: BuilderAdjustments = { exposure: 20, contrast: -5 };
    const graph = buildLayeredGraph(base, [L1], SDR).graph;
    const stripped = withoutNode(graph, `layer:L1:default:${KIND_TRANSFORM}`);
    const projected = project(stripped, SDR);
    // Absent means identity, and identity is what the base holds too.
    expect(projected.layers[0].merged.rotation).toBeUndefined();
    expect(projected.base.rotation).toBe(0);
  });

  it('blocks a branch whose vignette was edited', () => {
    const graph = buildLayeredGraph(RICH, [L1], SDR).graph;
    const id = `layer:L1:default:${KIND_EFFECTS}`;
    const tampered = patchParams(graph, id, { vignette: 0.2, grainSize: 40 });
    expect(blockedBy(tampered, SDR)).toEqual([
      { nodeId: id, reason: PARAM_REASONS.branchDiffers('vignette') },
      { nodeId: id, reason: PARAM_REASONS.branchDiffers('grainSize') },
    ]);
  });

  it('lets a PRESET layer keep its own grain and vignette', () => {
    // User decision of 2026-09-03: layerAdjustmentsForRendering strips only
    // the transform fields from a preset layer, so its look effects ride
    // along for the Amount slider to fade. Requiring effect equality here
    // would lock the way back on an ordinary document with a look preset.
    const preset: BuilderLayer = { ...L1, presetSyncId: 'preset-abc' };
    const graph = buildLayeredGraph(RICH, [preset], SDR).graph;
    const id = `layer:L1:default:${KIND_EFFECTS}`;
    const tampered = patchParams(graph, id, { vignette: 0.2, grain: 0.4 });
    const scan = scanGraphShape(tampered);
    if (!scan.ok) throw new Error('shape scan blocked');
    expect(paramsToAdjustments(tampered, scan.shape, SDR).ok).toBe(true);
  });

  it('still holds a preset layer to the shared transform', () => {
    // The exemption is for effects only. A preset layer never carries
    // transform fields, so a difference there is a hand-edited graph.
    const preset: BuilderLayer = { ...L1, presetSyncId: 'preset-abc' };
    const graph = buildLayeredGraph(RICH, [preset], SDR).graph;
    const id = `layer:L1:default:${KIND_TRANSFORM}`;
    const tampered = patchParams(graph, id, { rotation: 0.5 });
    expect(blockedBy(tampered, SDR)).toEqual([
      { nodeId: id, reason: PARAM_REASONS.branchDiffers('rotation') },
    ]);
  });

  it('exempts only the layer that carries the marker', () => {
    const preset: BuilderLayer = { ...L1, presetSyncId: 'preset-abc' };
    const graph = buildLayeredGraph(RICH, [preset, L2], SDR).graph;
    const presetEffects = `layer:L1:default:${KIND_EFFECTS}`;
    const plainEffects = `layer:L2:default:${KIND_EFFECTS}`;
    const tampered = patchParams(
      patchParams(graph, presetEffects, { vignette: 0.2 }),
      plainEffects, { vignette: 0.2 },
    );
    expect(blockedBy(tampered, SDR)).toEqual([
      { nodeId: plainEffects, reason: PARAM_REASONS.branchDiffers('vignette') },
    ]);
  });

  it('an empty preset marker does not exempt anything', () => {
    // Guards against `presetSyncId: ''` slipping through as truthy-ish.
    const graph = buildLayeredGraph(RICH, [{ ...L1, presetSyncId: '' }], SDR).graph;
    const id = `layer:L1:default:${KIND_EFFECTS}`;
    const tampered = patchParams(graph, id, { vignette: 0.2 });
    expect(blockedBy(tampered, SDR)).toEqual([
      { nodeId: id, reason: PARAM_REASONS.branchDiffers('vignette') },
    ]);
  });

  it('lets noiseReduction differ between branches', () => {
    // DocumentModel's EFFECTS_FIELDS does not list noiseReduction, so an
    // adjustment layer may own its own value.
    const graph = buildLayeredGraph(RICH, [{ ...L1, adjustments: { noiseReduction: 30 } }], SDR).graph;
    const projected = project(graph, SDR);
    expect(projected.layers[0].delta).toEqual({ noiseReduction: 30 });
  });
});

// ─── lens correction ──────────────────────────────────────────────

describe('lens correction', () => {
  it('recovers the profile id from the coefficients', () => {
    const graph = buildDefaultGraph(
      { lensCorrection: true, lensCorrectionProfile: 'nikon-24-70-2.8', lensCorrectionStrength: 40 },
      SDR,
    ).graph;
    const back = project(graph, SDR).base;
    expect(back.lensCorrection).toBe(true);
    expect(back.lensCorrectionProfile).toBe('nikon-24-70-2.8');
    expect(back.lensCorrectionStrength).toBe(40);
  });

  it('blocks hand-edited coefficients that match no profile', () => {
    const graph = buildDefaultGraph(
      { lensCorrection: true, lensCorrectionProfile: 'nikon-24-70-2.8' },
      SDR,
    ).graph;
    const id = `default:${KIND_LENS_CORRECTION}`;
    expect(blockedBy(patchParams(graph, id, { k1: -0.5 }), SDR)).toEqual([
      { nodeId: id, reason: PARAM_REASONS.lensProfileUnknown },
    ]);
  });

  it('cannot tell a switched-off correction from an unset profile (documented loss)', () => {
    const withProfile = buildDefaultGraph(
      { lensCorrection: false, lensCorrectionProfile: 'nikon-24-70-2.8' },
      SDR,
    ).graph;
    const withoutProfile = buildDefaultGraph(
      { lensCorrection: true, lensCorrectionProfile: null },
      SDR,
    ).graph;
    const a = project(withProfile, SDR).base;
    const b = project(withoutProfile, SDR).base;
    expect(a.lensCorrectionProfile).toBeNull();
    expect(a.lensCorrection).toBe(false);
    expect(b).toEqual(a);
  });
});

describe('a RAW with a camera profile and a measured lens profile', () => {
  it('is no lock: the resolved lens correction reads back as lensCorrection false', () => {
    const back = project(buildDefaultGraph({ exposure: 12 }, RAW_PROFILED).graph, RAW_PROFILED).base;
    expect(back.lensCorrection).toBe(false);
    expect(back.lensCorrectionProfile).toBeNull();
    expect(back.lensCorrectionStrength).toBe(100);
    // The profile's exposure of 30 is not the slider's.
    expect(back.exposure).toBe(12);
  });

  it('still recognises a manual LENS_PROFILES choice on a RAW without a lens profile', () => {
    const source: BuilderSourceSpec = { ...(RAW_PROFILED as Extract<BuilderSourceSpec, { kind: 'raw16' }>), lensProfile: null };
    const graph = buildDefaultGraph({ lensCorrection: true, lensCorrectionProfile: 'nikon-24-70-2.8' }, source).graph;
    expect(project(graph, source).base).toMatchObject({
      lensCorrection: true, lensCorrectionProfile: 'nikon-24-70-2.8',
    });
  });

  it('blocks an edited base:tone and never leaks it into exposure', () => {
    const graph = buildDefaultGraph({ exposure: 12 }, RAW_PROFILED).graph;
    expect(blockedBy(patchParams(graph, `base:${KIND_TONE}`, { exposure: 0.9 }), RAW_PROFILED)).toEqual([
      { nodeId: `base:${KIND_TONE}`, reason: PARAM_REASONS.baseStageEdited },
    ]);
    // Without the user's own tone node the profile's value still stays out.
    const withoutUserTone = withoutNode(graph, `default:${KIND_TONE}`);
    const scan = scanGraphShape(withoutUserTone);
    if (!scan.ok) throw new Error('shape scan blocked');
    const read = adjustmentsFromChainParams(withoutUserTone, scan.shape.base, RAW_PROFILED);
    expect(read.blocked).toEqual([]);
    expect(read.adjustments.exposure).toBeUndefined();
  });

  it('holds the base nodes of a layer branch to the profile as well', () => {
    const graph = buildLayeredGraph({ exposure: 12 }, [L1], RAW_PROFILED).graph;
    const id = `layer:L1:base:${KIND_TONE}`;
    expect(blockedBy(patchParams(graph, id, { exposure: 0.9 }), RAW_PROFILED)).toEqual([
      { nodeId: id, reason: PARAM_REASONS.baseStageEdited },
    ]);
  });
});

// ─── per-pass color space ─────────────────────────────────────────

describe('per-pass color-space override', () => {
  it('reads the three switches back off their nodes', () => {
    const graph = buildDefaultGraph(
      { toneCurveSpace: 'gamma', colorGradingSpace: 'gamma', hslSpace: 'linear' },
      SDR,
    ).graph;
    const back = project(graph, SDR).base;
    expect(back.toneCurveSpace).toBe('gamma');
    expect(back.colorGradingSpace).toBe('gamma');
    expect(back.hslSpace).toBe('linear');
  });

  it('leaves the fields absent when no node carries an override', () => {
    const graph = buildDefaultGraph({ exposure: 10 }, SDR).graph;
    const back = project(graph, SDR).base;
    expect(back.toneCurveSpace).toBeUndefined();
    expect(back.colorGradingSpace).toBeUndefined();
    expect(back.hslSpace).toBeUndefined();
  });

  it('blocks a node that converts into a different space than it reads', () => {
    const graph = buildDefaultGraph({ toneCurveSpace: 'gamma' }, SDR).graph;
    const id = `default:${KIND_TONE_CURVE}`;
    expect(blockedBy(patchParams(graph, id, {
      _colorSpaceOverride: { inputSpace: 'gamma', outputSpace: 'linear' },
    }), SDR)).toEqual([{ nodeId: id, reason: PARAM_REASONS.spaceOverrideAsymmetric }]);
  });

  it('blocks HSL nodes whose switches disagree', () => {
    const graph = buildDefaultGraph({ hslSpace: 'gamma' }, SDR).graph;
    const id = `default:${KIND_HSL_DETAIL}`;
    expect(blockedBy(patchParams(graph, id, {
      _colorSpaceOverride: { inputSpace: 'linear', outputSpace: 'linear' },
    }), SDR)).toEqual([{ nodeId: id, reason: PARAM_REASONS.spaceOverrideConflict }]);
  });
});

// ─── deleted nodes are not findings ───────────────────────────────

describe('deleted nodes', () => {
  it('leaves the fields of a removed node absent and does not block', () => {
    const graph = withoutNode(buildDefaultGraph(RICH, SDR).graph, `default:${KIND_CLARITY}`);
    const back = project(graph, SDR).base;
    expect(back.clarity).toBeUndefined();
    expect(back.dehaze).toBeUndefined();
    // Absent is identity: feeding the result forward yields the identity
    // clarity params the compiler skips anyway.
    const params = paramsByNodeFromAdjustments(back, SDR).get(`default:${KIND_CLARITY}`);
    expect(params).toEqual({ clarity: 0, dehaze: 0 });
  });
});

// ─── the chain-level entry point on its own ───────────────────────

describe('adjustmentsFromChainParams', () => {
  it('works on a single chain without a shape scan of the whole graph', () => {
    const graph = buildDefaultGraph(RICH, SDR).graph;
    const scan = scanGraphShape(graph);
    if (!scan.ok) throw new Error('shape scan blocked');
    const read = adjustmentsFromChainParams(graph, scan.shape.base, SDR);
    expect(read.blocked).toEqual([]);
    expect(read.adjustments).toEqual(RICH);
  });
});

describe('layerDeltaFromMerged', () => {
  it('subtracts numbers and overrides everything else', () => {
    const base: BuilderAdjustments = { exposure: 10, contrast: 5, bwEnabled: false, bwMix: { red: 1 } as never };
    const merged: BuilderAdjustments = { exposure: 25, contrast: 5, bwEnabled: true, bwMix: { red: 1 } as never };
    expect(layerDeltaFromMerged(base, merged)).toEqual({ exposure: 15, bwEnabled: true });
  });

  it('expresses a field the branch no longer has as the negated base value', () => {
    expect(layerDeltaFromMerged({ exposure: 10 }, {})).toEqual({ exposure: -10 });
  });

  it('carries a field without a zero point over as the branch value, not the difference', () => {
    // mergeAdjustments overrides these, so the inverse may not subtract.
    expect(layerDeltaFromMerged(
      { vignetteFeather: 31, grainSize: 18, exposure: 10 },
      { vignetteFeather: 50, grainSize: 18, exposure: 25 },
    )).toEqual({ vignetteFeather: 50, exposure: 15 });
  });

  it('cannot un-set a field without a zero point, so it does not negate one', () => {
    expect(layerDeltaFromMerged({ denoiseDetail: 37 }, {})).toEqual({});
  });

  it('represents skin-tone off explicitly so a layer can override a nonzero base', () => {
    const delta = layerDeltaFromMerged({ hslSkinTone: RICH.hslSkinTone }, {});
    expect(Object.prototype.hasOwnProperty.call(delta, 'hslSkinTone')).toBe(true);
    expect(delta.hslSkinTone).toBeUndefined();
  });
});

describe('a preset layer saved from full adjustments', () => {
  // A preset is the whole Adjustments object of the photo it was saved from.
  // Without a manual lens profile on the base, so the lens rule has nothing
  // to say and only the merge is measured.
  const base: BuilderAdjustments = {
    ...RICH, lensCorrection: false, lensCorrectionProfile: null, lensCorrectionStrength: 100,
  };
  const look: Record<string, unknown> = {
    ...defaultAdjustments, saturation: 14, grain: 33, vignette: -12, grainSize: 40,
  };
  // What layerAdjustmentsForRendering hands the builder for a preset layer.
  for (const field of TRANSFORM_FIELDS) delete look[field];
  // The sector lists are INVERSION LOSS 2 and measured elsewhere.
  for (const field of ['skinToneSector', 'advancedSectors', 'skinToneSectors']) delete look[field];
  const preset: BuilderLayer = {
    ...L1, presetSyncId: 'preset-full', adjustments: adjustmentsToBuilderAdjustments(look),
  };

  it('reads its own grain size, feather and denoise detail back, not a difference', () => {
    const delta = project(buildLayeredGraph(base, [preset], SDR).graph, SDR).layers[0].delta;
    expect(delta.grainSize).toBe(40);
    expect(delta.vignetteFeather).toBe(50);
    expect(delta.denoiseDetail).toBe(50);
    expect(delta.saturation).toBe(14);
    // Equal to the base, so not part of the delta.
    expect(delta.lensCorrectionStrength).toBeUndefined();
  });

  it('is a fixed point on the params side', () => {
    const graph = buildLayeredGraph(base, [preset], SDR).graph;
    const projected = project(graph, SDR);
    const again = buildLayeredGraph(projected.base, [{ ...preset, adjustments: projected.layers[0].delta }], SDR).graph;
    const params = (g: RenderGraph) => Object.fromEntries([...g.nodes].map(([id, n]) => [id, n.params]));
    expect(params(again)).toEqual(params(graph));
  });
});

describe('the lens correction has to be identical across branches', () => {
  it('blocks a branch that corrects the lens twice, preset or not', () => {
    // No preset exemption: the correction is a fact about the glass.
    const graph = buildLayeredGraph(RICH, [{ ...L1, presetSyncId: 'preset-abc' }], SDR).graph;
    const id = `layer:L1:default:${KIND_LENS_CORRECTION}`;
    expect(blockedBy(patchParams(graph, id, { strength: 1.3 }), SDR)).toEqual([
      { nodeId: id, reason: PARAM_REASONS.branchDiffers('strength') },
    ]);
  });
});
