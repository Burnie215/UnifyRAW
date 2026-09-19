/**
 * Step 2's acceptance suite: the round trip the plan asks for, and one case
 * per blocking rule of its table — measured at the public function
 * `projectToDocument`, not at the three rule modules underneath.
 *
 * The rule modules test their own rules in isolation
 * ([shapeScan.test.ts](./shapeScan.test.ts), [chainRules.test.ts](./chainRules.test.ts),
 * [paramsToAdjustments.test.ts](./paramsToAdjustments.test.ts)); what is
 * checked here is that each rule still reaches the caller, with the wording
 * the plan agreed on. A rule nobody can see is worth nothing: the gate UI in
 * step 3 shows exactly these strings.
 *
 * Two things guard against the round trip being green for the wrong reason,
 * a lesson from step 1 (equality alone is a weak assurance — both views once
 * agreed on a broken picture):
 *
 *   1. the fixture is off its default in every node, asserted, so equality
 *      is not defaults compared with defaults;
 *   2. the sweep at the bottom changes ONE parameter in every node in turn
 *      and requires the outcome to change with it. A projection that quietly
 *      returned the previous document would pass every equality test in this
 *      file and fail seventeen cases of that sweep.
 */
import { describe, expect, it } from 'vitest';

import { projectToDocument, DOCUMENT_REASONS } from './projectToDocument';
import { SHAPE_REASONS } from './shapeScan';
import { CHAIN_REASONS, KINDS_WITHOUT_CLASSIC_EQUIVALENT } from './chainRules';
import { PARAM_REASONS } from './paramsToAdjustments';
import { TRANSFORM_FIELDS } from '../../DocumentModel';
import { defaultAdjustments, withoutLensCorrection, type Adjustments } from '../../../types';
import {
  BASE_ADJUSTMENTS, LAYER_DELTA, MASK, RAW, RAW_PROFILED, SDR,
  addEdge, documentWith, findLayer, graphFor, insertAfter, layer, nodeParams,
  patchParams, retypeNode, rewire, withoutEdgeInto, withoutNode,
} from './projectionFixtures';
import {
  chainKindsForSource,
  chainStepsForSource,
  paramsByNodeFromAdjustments,
  type BuilderSourceSpec,
} from '../DefaultGraphBuilder';
import { BLEND_MODE_NAMES } from '../compositorKinds';
import { hydrateGraph, serializeGraph } from '../serialize';
import type { PhotoDocument } from '../../DocumentModel';
import type { SpotRemoval } from '../../Mask';
import {
  KIND_CLARITY, KIND_COLOR_MATRIX, KIND_CUSTOM_HSL, KIND_DENOISE, KIND_OUTPUT_COLOR_SPACE,
  KIND_TEXTURE, KIND_TONE, KIND_TRANSFORM, KIND_WHITE_BALANCE_RAW,
} from '../passKinds';
import { KIND_IMAGE_BITMAP_SOURCE } from '../sources';
import type { RenderGraph } from '../types';

function project(graph: RenderGraph, previous?: PhotoDocument, source: BuilderSourceSpec = SDR): PhotoDocument {
  const result = projectToDocument(graph, source, previous);
  if (!result.ok) throw new Error('projection blocked: ' + JSON.stringify(result.blocked));
  return result.document;
}

function reasonsFor(graph: RenderGraph, previous?: PhotoDocument, source: BuilderSourceSpec = SDR) {
  const result = projectToDocument(graph, source, previous);
  if (result.ok) throw new Error('expected the projection to block, it did not');
  return result.blocked;
}

const SOURCES = [['SDR', SDR], ['RAW', RAW], ['RAW+Profil', RAW_PROFILED]] as const;

/**
 * The base the documents are built on. On a RAW whose lens has a resolved
 * profile the fixture's manual lens choice would be shadowed by it and come
 * back as "none" (INVERSION LOSS 6 in paramsToAdjustments.ts), so that
 * source gets the document the app actually has: no manual choice, since no
 * control sets one.
 */
function baseFor(source: BuilderSourceSpec): Partial<Adjustments> {
  return source === RAW_PROFILED
    ? { ...BASE_ADJUSTMENTS, lensCorrection: false, lensCorrectionProfile: null }
    : BASE_ADJUSTMENTS;
}

/** The stack the acceptance is measured on: two ordinary layers, one of them
 *  masked and one on a non-normal blend mode, plus a preset layer. */
function stackDocument(base: Partial<Adjustments> = BASE_ADJUSTMENTS): PhotoDocument {
  return documentWith([
    layer({ id: 'L1', name: 'Himmel', adjustments: LAYER_DELTA, opacity: 0.8, mask: MASK }),
    layer({ id: 'L2', adjustments: { exposure: -9, saturation: 11 }, opacity: 0.5, blendMode: 'multiply' }),
    layer({
      id: 'P1', name: 'Preset · Kodak', opacity: 0.65, presetSyncId: 'sync-kodak',
      adjustments: { saturation: 14, grain: 33, vignette: -12 },
    }),
  ], base);
}

// ─── the fixture may not be trivial ───────────────────────────────

describe('acceptance fixture', () => {
  it.each(SOURCES)(
    'moves every %s chain node off its identity params', (_name, source) => {
      const identity = paramsByNodeFromAdjustments({}, source);
      const doc = documentWith([], baseFor(source));
      const graph = graphFor(doc, source);
      const unchanged = chainKindsForSource(source).filter((kind) =>
        JSON.stringify(nodeParams(graph, `default:${kind}`))
        === JSON.stringify(identity.get(`default:${kind}`)));
      // The nodes that cannot move are the ones fed by the source spec
      // rather than by a slider: outputColorSpace carries no adjustment at
      // all, and a raw chain's colorMatrix is camera metadata.
      expect(unchanged).toEqual(source.kind === 'raw16'
        ? [KIND_COLOR_MATRIX, KIND_OUTPUT_COLOR_SPACE]
        : [KIND_OUTPUT_COLOR_SPACE]);
    });
});

// ─── round trip ───────────────────────────────────────────────────

describe('round trip document -> graph -> document', () => {
  it.each(SOURCES)(
    'returns a base-only %s document unchanged', (_name, source) => {
      const doc = documentWith([], baseFor(source));
      expect(project(graphFor(doc, source), doc, source)).toEqual(doc);
    });

  it.each(SOURCES)(
    'returns a %s stack with mask, blend mode and preset unchanged', (_name, source) => {
      const doc = stackDocument(baseFor(source));
      expect(project(graphFor(doc, source), doc, source)).toEqual(doc);
    });

  it.each([['SDR', SDR], ['RAW', RAW]] as const)(
    'renders a %s preset layer saved from full adjustments the same after the trip', (_name, source) => {
      // What applyPresetAsLayer stores: the whole Adjustments object of the
      // photo the preset was saved from, minus the transform and the lens
      // correction, which belongs to the glass and not to a look (f0e36b2).
      // The three sector fields are left out because a default skin-tone
      // sector equal to the base's blocks as customHslSplit, which is not
      // what this measures.
      const look = withoutLensCorrection({
        ...defaultAdjustments, saturation: 14, grain: 33, vignette: -12, grainSize: 40,
      }) as Record<string, unknown>;
      for (const field of TRANSFORM_FIELDS) delete look[field];
      for (const field of ['skinToneSector', 'advancedSectors', 'skinToneSectors']) delete look[field];
      const doc = documentWith([
        layer({ id: 'P1', presetSyncId: 'sync-full', opacity: 0.65, adjustments: look as Partial<Adjustments> }),
      ], { ...BASE_ADJUSTMENTS, lensCorrection: false, lensCorrectionProfile: null, lensCorrectionStrength: 100 });
      const back = project(graphFor(doc, source), doc, source);

      // Not byte for byte: the layer comes back as a sparse delta, so the
      // preset's explicit zeros and its values equal to the base drop out.
      // The picture may not change, and the preset's own values without a
      // zero point have to survive as values, not as differences.
      const params = (g: RenderGraph) => Object.fromEntries([...g.nodes].map(([id, n]) => [id, n.params]));
      expect(params(graphFor(back, source))).toEqual(params(graphFor(doc, source)));
      expect(findLayer(back, 'P1').adjustments).toMatchObject({
        grainSize: 40, vignetteFeather: 50, denoiseDetail: 50, grain: 33, vignette: -12, saturation: 14,
      });
    });

  it.each(BLEND_MODE_NAMES)('returns a layer in blend mode %s unchanged', (mode) => {
    const doc = documentWith([
      layer({ id: 'L1', adjustments: LAYER_DELTA, opacity: 0.7, blendMode: mode }),
    ]);
    expect(project(graphFor(doc), doc)).toEqual(doc);
  });

  it('survives the trip through the document\'s serialized graph', () => {
    // How the graph actually reaches a later session: `pipelineGraph` is
    // stored as JSON, so the Maps are gone and the params are plain objects.
    const doc = stackDocument();
    const stored = hydrateGraph(serializeGraph(graphFor(doc)));
    expect(project(stored, doc)).toEqual(doc);
  });

  it('carries the layer stack when there is no document to copy from', () => {
    // Nothing to hand back here: every value has to come out of the nodes.
    // The masked layer is left out on purpose — a mask shape cannot be
    // reconstructed from a texture slot, which is its own case below.
    const doc = documentWith([
      layer({ id: 'L1', adjustments: LAYER_DELTA, opacity: 0.8 }),
      layer({ id: 'L2', adjustments: { exposure: -9 }, opacity: 0.5, blendMode: 'multiply' }),
    ]);
    const fresh = project(graphFor(doc, RAW), undefined, RAW);

    // Same picture, proven on the graph side: rebuilding from the projected
    // document gives the same nodes with the same params. Ids differ (the
    // layers were named after the compositors), kinds and params may not.
    const shape = (g: RenderGraph) => [...g.nodes.values()]
      .map((n) => `${n.kind} ${JSON.stringify(n.params)}`).sort();
    expect(shape(graphFor(fresh, RAW))).toEqual(shape(graphFor(doc, RAW)));
  });
});

// ─── one case per blocking rule of the plan's table ───────────────

describe('blocking rule: a kind the classic view has no node for', () => {
  it.each(KINDS_WITHOUT_CLASSIC_EQUIVALENT)('%s blocks the way back', (kind) => {
    const doc = documentWith([]);
    const graph = retypeNode(graphFor(doc), `default:${KIND_CLARITY}`, kind);
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: `default:${KIND_CLARITY}`,
      reason: CHAIN_REASONS.noClassicEquivalent(kind),
    });
  });
});

describe('blocking rule: chain order', () => {
  it('reports the pair that sits the wrong way round', () => {
    const doc = documentWith([]);
    // Texture and Denoise are neighbours in the classic chain, so swapping
    // their kinds is exactly one inversion and nothing else.
    let graph = retypeNode(graphFor(doc), `default:${KIND_TEXTURE}`, KIND_DENOISE);
    graph = retypeNode(graph, `default:${KIND_DENOISE}`, KIND_TEXTURE);
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: `default:${KIND_DENOISE}`,
      reason: CHAIN_REASONS.wrongOrder(KIND_DENOISE, KIND_TEXTURE),
    });
  });
});

describe('blocking rule: the same kind twice in one chain', () => {
  it('reports the second one', () => {
    const doc = documentWith([]);
    const clarityId = `default:${KIND_CLARITY}`;
    const graph = insertAfter(
      graphFor(doc), clarityId, 'user:clarity', KIND_CLARITY, nodeParams(graphFor(doc), clarityId),
    );
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: 'user:clarity',
      reason: CHAIN_REASONS.duplicateKind(KIND_CLARITY),
    });
  });
});

describe('blocking rule: a branch that does not start at the source', () => {
  it('reports a branch hanging off a compositor', () => {
    const doc = documentWith([
      layer({ id: 'L1', adjustments: LAYER_DELTA }),
      layer({ id: 'L2', adjustments: { exposure: -9 } }),
    ]);
    const firstKind = chainKindsForSource(SDR)[0];
    const graph = rewire(graphFor(doc), { node: `layer:L2:default:${firstKind}`, port: 'in' }, 'comp:L1');
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: `layer:L2:default:${chainKindsForSource(SDR).at(-1)}`,
      reason: SHAPE_REASONS.branchOffIntermediate,
    });
  });

  it('reports a branch hanging off the base chain as a stack it cannot write', () => {
    // Not the same finding: a branch rooted inside the base chain gives that
    // base node a second consumer, and fan-out is what the shape scan sees
    // first. Written down so the mapping from the plan's row to the string
    // the user reads is not a surprise later.
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    const chain = chainKindsForSource(SDR);
    const graph = rewire(
      graphFor(doc), { node: `layer:L1:default:${chain[0]}`, port: 'in' }, `default:${chain[0]}`,
    );
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: `default:${chain[0]}`,
      reason: SHAPE_REASONS.notAStack,
    });
  });
});

describe('blocking rule: a branching that is not a layer stack', () => {
  it('reports a compositor feeding another compositor\'s layer port', () => {
    const doc = documentWith([
      layer({ id: 'L1', adjustments: LAYER_DELTA }),
      layer({ id: 'L2', adjustments: { exposure: -9 } }),
    ]);
    const graph = rewire(graphFor(doc), { node: 'comp:L2', port: 'layer' }, 'comp:L1');
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: 'comp:L1', reason: SHAPE_REASONS.notAStack,
    });
  });

  it('reports a chain node with two consumers', () => {
    const doc = documentWith([]);
    const graph = addEdge(graphFor(doc), `default:${KIND_TONE}`, {
      node: `default:${KIND_CLARITY}`, port: 'in',
    });
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: `default:${KIND_TONE}`, reason: SHAPE_REASONS.notAStack,
    });
  });
});

describe('blocking rule: transform and effects differ between branches', () => {
  it('reports a branch with its own transform', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    const graph = patchParams(graphFor(doc), `layer:L1:default:${KIND_TRANSFORM}`, { rotation: 0 });
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: `layer:L1:default:${KIND_TRANSFORM}`,
      reason: PARAM_REASONS.branchDiffers('rotation'),
    });
  });

  it('reports an ordinary branch with its own vignette', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    const graph = patchParams(graphFor(doc), 'layer:L1:default:effects', { vignette: 0.1 });
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: 'layer:L1:default:effects',
      reason: PARAM_REASONS.branchDiffers('vignette'),
    });
  });

  it('lets a preset branch keep its own vignette', () => {
    // The exemption decided on 2026-09-03: a preset layer's look effects are
    // exactly what its Amount slider fades, so requiring equality there
    // would lock the way back on an ordinary document with a look preset.
    const doc = documentWith([
      layer({ id: 'P1', presetSyncId: 'sync-kodak', opacity: 0.6, adjustments: { vignette: -12 } }),
    ]);
    expect(project(graphFor(doc), doc)).toEqual(doc);
  });
});

describe('blocking rule: camera metadata edited', () => {
  it('reports an edited color matrix', () => {
    const doc = documentWith([]);
    const graph = patchParams(graphFor(doc, RAW), `default:${KIND_COLOR_MATRIX}`, {
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    });
    expect(reasonsFor(graph, doc, RAW)).toContainEqual({
      nodeId: `default:${KIND_COLOR_MATRIX}`,
      reason: PARAM_REASONS.cameraMetadata(KIND_COLOR_MATRIX),
    });
  });

  it('reports raw white balance that no slider position produces', () => {
    const doc = documentWith([]);
    const graph = patchParams(graphFor(doc, RAW), `default:${KIND_WHITE_BALANCE_RAW}`, {
      wb: [1, 2, 3],
    });
    expect(reasonsFor(graph, doc, RAW)).toContainEqual({
      nodeId: `default:${KIND_WHITE_BALANCE_RAW}`,
      reason: PARAM_REASONS.cameraMetadata(KIND_WHITE_BALANCE_RAW),
    });
  });
});

describe('blocking rule: the structural findings', () => {
  it('reports a graph without an image source', () => {
    const doc = documentWith([]);
    const graph = withoutNode(graphFor(doc), `default:${KIND_IMAGE_BITMAP_SOURCE}`);
    expect(reasonsFor(graph, doc).map((b) => b.reason)).toEqual([SHAPE_REASONS.noImageSource]);
  });

  it('reports a second image source', () => {
    const doc = documentWith([]);
    const graph = graphFor(doc);
    const nodes = new Map(graph.nodes);
    nodes.set('second', { id: 'second', kind: KIND_IMAGE_BITMAP_SOURCE, params: {} });
    expect(reasonsFor({ ...graph, nodes }, doc).map((b) => b.reason))
      .toEqual([SHAPE_REASONS.severalImageSources, SHAPE_REASONS.severalImageSources]);
  });

  it('reports a mask input that is not a mask', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA, mask: MASK })]);
    const graph = rewire(graphFor(doc), { node: 'comp:L1', port: 'mask' }, `default:${KIND_TONE}`);
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: `default:${KIND_TONE}`, reason: SHAPE_REASONS.maskNotASource,
    });
  });

  it('reports a broken chain', () => {
    const doc = documentWith([]);
    const graph = withoutEdgeInto(graphFor(doc), { node: `default:${KIND_TONE}`, port: 'in' });
    expect(reasonsFor(graph, doc)).toContainEqual({
      nodeId: `default:${KIND_TONE}`, reason: SHAPE_REASONS.missingInput,
    });
  });

  it('reports a cycle', () => {
    const doc = documentWith([]);
    const chain = chainKindsForSource(SDR);
    const graph = rewire(
      graphFor(doc), { node: `default:${chain[0]}`, port: 'in' }, `default:${chain[3]}`,
    );
    expect(reasonsFor(graph, doc).map((b) => b.reason)).toContain(SHAPE_REASONS.cycle);
  });
});

describe('blocking rule: what the document cannot hold', () => {
  it('reports a mask input with no mask shape behind it', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA, mask: MASK })]);
    expect(reasonsFor(graphFor(doc))).toContainEqual({
      nodeId: 'mask:L1', reason: DOCUMENT_REASONS.maskWithoutShape,
    });
  });

  it('reports color sectors that cannot be split up again', () => {
    const doc = documentWith([]);
    const graph = graphFor(doc);
    const sectors = nodeParams(graph, `default:${KIND_CUSTOM_HSL}`).sectors as unknown[];
    const withOneMore = patchParams(graph, `default:${KIND_CUSTOM_HSL}`, {
      sectors: [...sectors, { hueCenter: 300, hueHalfWidth: 10, feather: 0.2, dH: 1, dS: 2, dL: 3 }],
    });
    expect(reasonsFor(withOneMore, doc)).toContainEqual({
      nodeId: withOneMore.output, reason: DOCUMENT_REASONS.customHslSplit,
    });
  });
});

// ─── what the plan says must NOT block ────────────────────────────

describe('not blocking', () => {
  it('a deleted chain node', () => {
    const doc = documentWith([]);
    const back = project(withoutNode(graphFor(doc), `default:${KIND_CLARITY}`), doc);
    // Identity, not a finding: the field falls back to the default and the
    // rest of the document is untouched.
    expect(findLayer(back, 'base').adjustments).not.toHaveProperty('clarity');
    expect(findLayer(back, 'base').adjustments.dehaze).toBeUndefined();
    expect(back.transform).toEqual(doc.transform);
  });

  it('changed node positions', () => {
    const doc = stackDocument();
    const graph = graphFor(doc);
    const moved: RenderGraph = {
      ...graph,
      metadata: { ...graph.metadata, nodePositions: { 'comp:L1': { x: 900, y: -40 } } },
    };
    expect(project(moved, doc)).toEqual(doc);
  });

  it('a layer whose compositor has the mask switched off', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA, mask: MASK })]);
    const graph = patchParams(graphFor(doc), 'comp:L1', { useMask: false });
    // The shader ignores the mask input in that state, so the document says
    // the same: no mask. Not a finding.
    expect(findLayer(project(graph, doc), 'L1').mask).toBeNull();
  });
});

// ─── the projection has to read every node ────────────────────────

describe('every node reaches the document', () => {
  /**
   * Change one parameter in one node and the outcome has to change with it.
   * This is the counterweight to the equality tests above: a projection that
   * handed the previous document back, or that skipped a plucker's inverse,
   * would pass every round trip in this file and fail here for each node it
   * does not read.
   */
  it.each(SOURCES)('for every %s node', (_name, source) => {
    const doc = documentWith([], baseFor(source));
    const graph = graphFor(doc, source);
    const untouched = JSON.stringify(projectToDocument(graph, source, doc));
    const deaf: string[] = [];

    for (const kind of chainKindsForSource(source)) {
      const id = `default:${kind}`;
      const nudged = nudgeFirstValue(nodeParams(graph, id));
      if (!nudged) throw new Error(`${kind} has no parameter to change`);
      const outcome = JSON.stringify(projectToDocument(patchParams(graph, id, nudged), source, doc));
      if (outcome === untouched) deaf.push(kind);
    }
    // Source-derived nodes count too: changing one must block rather than
    // silently project a picture the classic document cannot reproduce.
    expect(deaf).toEqual([]);
  });

  it('reports every changed base node of a profiled RAW as the profile\'s, never as another document', () => {
    // The base nodes are the RAW converter's rendering, which no slider
    // holds: a change there cannot be written back, and must not be read as
    // if it were the user's tone or curve.
    const doc = documentWith([], baseFor(RAW_PROFILED));
    const graph = graphFor(doc, RAW_PROFILED);
    const baseSteps = chainStepsForSource(RAW_PROFILED).filter((step) => step.stage === 'base');
    expect(baseSteps.length).toBeGreaterThan(0);
    for (const step of baseSteps) {
      const id = `base:${step.kind}`;
      const nudged = nudgeFirstValue(nodeParams(graph, id));
      if (!nudged) throw new Error(`${step.kind} has no parameter to change`);
      const result = projectToDocument(patchParams(graph, id, nudged), RAW_PROFILED, doc);
      expect(result.ok ? 'not blocked' : result.blocked, id)
        .toEqual([{ nodeId: id, reason: PARAM_REASONS.baseStageEdited }]);
    }
  });
});

// ─── retouch ──────────────────────────────────────────────────────

const SPOTS: SpotRemoval[] = [
  {
    id: 's1', mode: 'heal',
    target: { x: 0.5, y: 0.5, radius: 0.1 },
    source: { x: 0.2, y: 0.55 }, feather: 0.5, opacity: 1,
  },
  {
    id: 's2', mode: 'clone',
    target: { x: 0.8, y: 0.2, radius: 0.04 },
    source: { x: 0.7, y: 0.3 }, feather: 0, opacity: 0.75,
  },
];

describe('retouch', () => {
  it.each(SOURCES)('comes back off a %s graph unchanged, spot for spot', (_name, source) => {
    const doc = { ...documentWith([], baseFor(source)), retouch: SPOTS };
    expect(project(graphFor(doc, source), doc, source)).toEqual(doc);
  });

  it('comes back with a stack, where every branch carries the node', () => {
    const doc = { ...stackDocument(), retouch: SPOTS };
    expect(project(graphFor(doc), doc)).toEqual(doc);
  });

  it('does not lock the document — a retouch node is a classic edit', () => {
    // A kind the chain rules do not know blocks the way back and freezes the
    // photo in graph mode (the F011 pattern). This is the guard against that.
    const doc = { ...documentWith([]), retouch: SPOTS };
    expect(projectToDocument(graphFor(doc), SDR, doc).ok).toBe(true);
  });

  it('is read from the graph, not carried over from the document', () => {
    const doc = { ...documentWith([]), retouch: SPOTS };
    const graph = graphFor(doc);
    const spots = nodeParams(graph, 'default:retouch').spots as Record<string, unknown>[];
    const moved = patchParams(graph, 'default:retouch', { spots: [{ ...spots[0], tx: 0.9 }] });
    const back = project(moved, doc);
    expect(back.retouch).toHaveLength(1);
    expect(back.retouch![0].target.x).toBe(0.9);
    // The id is not in the graph, so it is kept from the document rather
    // than invented anew — otherwise every projection would rewrite it.
    expect(back.retouch![0].id).toBe('s1');
  });

  it('goes away entirely when the node is deleted in the graph', () => {
    // Not `[]`: an empty list is a different document from no list, and the
    // export filename would move for a spot nobody has.
    const doc = { ...documentWith([]), retouch: SPOTS };
    const back = project(withoutNode(graphFor(doc), 'default:retouch'), doc);
    expect('retouch' in back).toBe(false);
  });
});

/** Copy `params` with its first number moved, or its first boolean flipped.
 *  Deep, because most params nest (levels channels, curve points, sectors). */
function nudgeFirstValue(params: Record<string, unknown>): Record<string, unknown> | null {
  let done = false;

  const walk = (value: unknown): unknown => {
    if (done) return value;
    if (typeof value === 'number') { done = true; return value + 0.125; }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[key] = walk(v);
      return out;
    }
    return value;
  };
  const numbersMoved = walk(params) as Record<string, unknown>;
  if (done) return numbersMoved;

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'boolean') return { ...params, [key]: !value };
  }
  return null;
}
