import { describe, expect, it } from 'vitest';

import {
  projectToDocument,
  groupBlockedByNode,
  BUILDER_OWNED_ADJUSTMENT_FIELDS,
  DOCUMENT_REASONS,
} from './projectToDocument';
import { SHAPE_REASONS } from './shapeScan';
import { CHAIN_REASONS } from './chainRules';
import { PARAM_REASONS } from './paramsToAdjustments';
import {
  BASE_ADJUSTMENTS, DOC_EFFECTS, DOC_TRANSFORM, LAYER_DELTA, MASK, RAW, SDR,
  documentWith, findLayer, graphFor, layer, nodeParams, patchParams, retypeNode, withoutNode,
} from './projectionFixtures';
import {
  adjustmentsToBuilderAdjustments,
  buildLayeredGraph,
  type BuilderSourceSpec,
} from '../DefaultGraphBuilder';
import {
  DOCUMENT_LEVEL_FIELDS,
  documentToAdjustments,
  type PhotoDocument,
} from '../../DocumentModel';
import { layerAdjustmentsForRendering } from '../../PresetLayer';
import { defaultAdjustments, type Adjustments, type ColorEditorSector } from '../../../types';
import { KIND_CROP, KIND_CUSTOM_HSL, KIND_EFFECTS, KIND_HSL_DETAIL, KIND_TONE, KIND_TRANSFORM } from '../passKinds';
import { KIND_CUSTOM_LUT } from '../lutKinds';
import { KIND_IMAGE_BITMAP_SOURCE } from '../sources';
import type { RenderGraph } from '../types';

function project(graph: RenderGraph, previous?: PhotoDocument, source: BuilderSourceSpec = SDR): PhotoDocument {
  const result = projectToDocument(graph, source, previous);
  if (!result.ok) throw new Error('projection blocked: ' + JSON.stringify(result.blocked));
  return result.document;
}

function blockedBy(graph: RenderGraph, previous?: PhotoDocument, source: BuilderSourceSpec = SDR) {
  const result = projectToDocument(graph, source, previous);
  if (result.ok) throw new Error('expected the projection to block, it did not');
  return result.blocked;
}

// ─── the field list has to be complete and minimal ────────────────

describe('BUILDER_OWNED_ADJUSTMENT_FIELDS', () => {
  /**
   * The list decides which fields a deleted node resets and which ones are
   * carried over from the previous document. A copy of a list that lives in
   * `adjustmentsToBuilderAdjustments` would rot silently, so instead of
   * trusting it, every field of `Adjustments` is probed: setting it back to
   * its default has to change the builder's view exactly for the fields the
   * list names.
   */
  it('names exactly the fields the builder reads', () => {
    const rich: Adjustments = {
      ...defaultAdjustments,
      ...BASE_ADJUSTMENTS,
      ...DOC_TRANSFORM,
      ...DOC_EFFECTS,
      advancedSectors: [{
        id: 'a1', hueCenter: 120, hueHalfWidth: 30, satMin: 10, satMax: 90, feather: 0.25,
        pickRelHue: 0.5, pickRelSat: 0.5, selLightness: 0, dH: 5, dS: -10, dL: 15, enabled: true,
      }],
      skinToneSectors: [{
        id: 's1', hueCenter: 28, hueHalfWidth: 18, satMin: 20, satMax: 60, feather: 0.3,
        pickRelHue: 0.5, pickRelSat: 0.5, selLightness: 0, dH: -3, dS: 8, dL: -6, enabled: true,
      }],
      skinToneSector: { ...defaultAdjustments.skinToneSector, dH: 4, dS: -5, dL: 6 },
      skinToneUniformity: { hue: 5, saturation: 6, luminance: 7 },
      sharpenRadius: 2.4, sharpenMasking: 30, colorEditorMode: 'advanced',
      aiDenoiseEnabled: true, aiDenoiseStrength: 42, aiDenoiseModelId: 'scunet-color',
    };
    const asBuilder = JSON.stringify(adjustmentsToBuilderAdjustments(rich));
    // The three space switches have no entry in defaultAdjustments (absent
    // means "the kind's own default"), so they are probed against undefined.
    const allFields = [...Object.keys(defaultAdjustments),
      'toneCurveSpace', 'colorGradingSpace', 'hslSpace'] as (keyof Adjustments)[];

    const reacts = allFields.filter((field) => {
      const back = { ...rich, [field]: defaultAdjustments[field] };
      return JSON.stringify(adjustmentsToBuilderAdjustments(back)) !== asBuilder;
    });
    expect([...reacts].sort()).toEqual([...BUILDER_OWNED_ADJUSTMENT_FIELDS].sort());
  });

  it('leaves out the fields no wrapped kind owns', () => {
    // Spelled out so the complement of the probe above is visible: these are
    // the fields a projection has to carry over instead of resetting.
    for (const field of ['cropAspect', 'colorEditorMode',
      'sharpenRadius', 'sharpenMasking', 'aiDenoiseEnabled', 'aiDenoiseStrength',
      'aiDenoiseModelId'] as (keyof Adjustments)[]) {
      expect(BUILDER_OWNED_ADJUSTMENT_FIELDS).not.toContain(field);
    }
  });
});

// ─── the fixture has to be non-trivial ────────────────────────────

describe('fixture', () => {
  it('differs from a default document in every document-level field', () => {
    const doc = documentWith([]);
    const flat = documentToAdjustments(doc);
    const moved = ([...Object.keys(defaultAdjustments),
      'toneCurveSpace', 'colorGradingSpace', 'hslSpace'] as (keyof Adjustments)[])
      .filter((f) => JSON.stringify(flat[f]) !== JSON.stringify(defaultAdjustments[f]));
    // Everything the graph can carry has to be off its default, or a
    // round-trip that dropped fields would still look green.
    for (const field of BUILDER_OWNED_ADJUSTMENT_FIELDS) {
      if (field === 'advancedSectors' || field === 'skinToneSectors' || field === 'skinToneSector') continue;
      expect(moved).toContain(field);
    }
  });
});

// ─── round trip with the document it came from ────────────────────

describe('document -> graph -> document', () => {
  it('returns a base-only document byte for byte', () => {
    const doc = documentWith([]);
    expect(project(graphFor(doc), doc)).toEqual(doc);
  });

  it('returns a stack with mask, blend mode and preset layer byte for byte', () => {
    const doc = documentWith([
      layer({ id: 'L1', name: 'Himmel', adjustments: LAYER_DELTA, opacity: 0.8, mask: MASK }),
      layer({ id: 'L2', adjustments: { exposure: -9 }, opacity: 0.5, blendMode: 'multiply' }),
      layer({
        id: 'P1', name: 'Preset · Kodak', opacity: 0.65, presetSyncId: 'sync-kodak',
        adjustments: { saturation: 14, grain: 33, vignette: -12 },
      }),
    ]);
    expect(project(graphFor(doc), doc)).toEqual(doc);
  });

  it('returns a layer with its own skin-tone uniformity byte for byte', () => {
    const doc = documentWith([
      layer({
        id: 'L1',
        adjustments: {
          ...LAYER_DELTA,
          skinToneUniformity: { hue: 12, saturation: 34, luminance: 56 },
        },
      }),
    ]);

    expect(project(graphFor(doc), doc)).toEqual(doc);
  });

  it('keeps an explicit zero layer uniformity over a nonzero base byte for byte', () => {
    const doc = documentWith([
      layer({
        id: 'L1',
        adjustments: {
          ...LAYER_DELTA,
          skinToneUniformity: { hue: 0, saturation: 0, luminance: 0 },
        },
      }),
    ]);

    expect(project(graphFor(doc), doc)).toEqual(doc);
  });

  it('returns a raw-source document byte for byte', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA, opacity: 0.7 })]);
    expect(project(graphFor(doc, RAW), doc, RAW)).toEqual(doc);
  });

  it('returns a persisted crop byte for byte', () => {
    const doc = documentWith([]);
    doc.transform.crop = { x: 0.1, y: 0.2, width: 0.7, height: 0.6 };
    expect(project(graphFor(doc), doc)).toEqual(doc);
  });

  it('keeps a sparse layer sparse instead of spelling out every default', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: { exposure: 5 } })], {});
    const back = project(graphFor(doc), doc);
    expect(findLayer(back, 'L1').adjustments).toEqual({ exposure: 5 });
    expect(findLayer(back, 'base').adjustments).toEqual({});
  });

  it('keeps the fields no node owns', () => {
    const doc = documentWith([]);
    const back = findLayer(project(graphFor(doc), doc), 'base').adjustments;
    expect(back.sharpenRadius).toBe(2.4);
    expect(back.colorEditorMode).toBe('advanced');
    expect(back.aiDenoiseStrength).toBe(42);
  });
});

// ─── round trip without a previous document ───────────────────────

describe('projection without a previous document', () => {
  /**
   * The round trips above could all pass on a function that simply hands the
   * previous document back. This one has nothing to copy from: every value
   * has to come out of the node params.
   */
  it('reads every value out of the graph, not out of a document', () => {
    const doc = documentWith([
      layer({ id: 'L1', adjustments: LAYER_DELTA, opacity: 0.8 }),
      layer({ id: 'L2', adjustments: { exposure: -9 }, opacity: 0.5, blendMode: 'multiply' }),
    ]);
    const fresh = project(graphFor(doc));

    // Same picture: every field the graph carries agrees, field for field.
    // The rest (sharpenRadius, colorEditorMode, cropAspect, the AI-denoise
    // trio) has no node and no previous document to come from — it falls
    // back to the default, which is what "the graph is all there is" means.
    const before = documentToAdjustments(doc);
    const after = documentToAdjustments(fresh);
    for (const field of BUILDER_OWNED_ADJUSTMENT_FIELDS) {
      expect({ [field]: after[field] }).toEqual({ [field]: before[field] });
    }
    for (const field of ['sharpenRadius', 'colorEditorMode', 'cropAspect'] as (keyof Adjustments)[]) {
      expect(after[field]).toEqual(defaultAdjustments[field]);
    }
    expect(fresh.layers.map((l) => [l.opacity, l.blendMode]))
      .toEqual(doc.layers.map((l) => [l.opacity, l.blendMode]));
    // The adjustment layers carry only graph-owned fields, so they come back
    // whole — including the deltas, which exist nowhere but in the branch
    // params.
    expect(fresh.layers.slice(1).map((l) => layerAdjustmentsForRendering(l)))
      .toEqual(doc.layers.slice(1).map((l) => layerAdjustmentsForRendering(l)));
  });

  it('names the layers after the compositor nodes it found them at', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    const fresh = project(graphFor(doc));
    expect(fresh.layers.map((l) => l.id)).toEqual(['base', 'comp:L1']);
  });

  it('projects multiple graph-authored color sectors into Advanced deterministically', () => {
    const customSectors: ColorEditorSector[] = [
      {
        id: 'green', hueCenter: 120, hueHalfWidth: 24, satMin: 15, satMax: 75, feather: 9,
        pickRelHue: 0.2, pickRelSat: 0.7, selLightness: -11,
        dH: 7, dS: -13, dL: 19, enabled: true,
      },
      {
        id: 'violet', hueCenter: 285, hueHalfWidth: 17, satMin: 22, satMax: 88, feather: 6,
        pickRelHue: 0.8, pickRelSat: 0.3, selLightness: 14,
        dH: -4, dS: 21, dL: -9, enabled: false,
      },
    ];
    const sourceDocument = documentWith([], {
      ...BASE_ADJUSTMENTS,
      advancedSectors: customSectors,
    });
    const graph = graphFor(sourceDocument);

    const first = project(graph);
    const second = project(graph);
    expect(second).toEqual(first);

    const flat = documentToAdjustments(first);
    expect(flat.advancedSectors.map((sector) => ({
      hueCenter: sector.hueCenter,
      hueHalfWidth: sector.hueHalfWidth,
      feather: sector.feather,
      dH: sector.dH,
      dS: sector.dS,
      dL: sector.dL,
      enabled: sector.enabled,
    }))).toEqual(customSectors.map((sector) => ({
      hueCenter: sector.hueCenter,
      hueHalfWidth: sector.hueHalfWidth,
      feather: sector.feather,
      dH: sector.dH,
      dS: sector.dS,
      dL: sector.dL,
      enabled: sector.enabled,
    })));
    expect(flat.advancedSectors.map((sector) => ({
      id: sector.id,
      satMin: sector.satMin,
      satMax: sector.satMax,
      pickRelHue: sector.pickRelHue,
      pickRelSat: sector.pickRelSat,
      selLightness: sector.selLightness,
    }))).toEqual([
      {
        id: 'graph:default:transform:custom-hsl:0',
        satMin: 0, satMax: 100, pickRelHue: 0.5, pickRelSat: 0.5, selLightness: 0,
      },
      {
        id: 'graph:default:transform:custom-hsl:1',
        satMin: 0, satMax: 100, pickRelHue: 0.5, pickRelSat: 0.5, selLightness: 0,
      },
    ]);
    expect(flat.skinToneSectors).toEqual([]);
    expect(flat.skinToneSector).toEqual(defaultAdjustments.skinToneSector);
  });

  it('keeps the canonical no-custom-sector case sparse and unchanged', () => {
    const sourceDocument = documentWith([], {});
    const fresh = project(graphFor(sourceDocument));
    const base = findLayer(fresh, 'base').adjustments;
    const flat = documentToAdjustments(fresh);

    expect(base).not.toHaveProperty('advancedSectors');
    expect(base).not.toHaveProperty('skinToneSectors');
    expect(base).not.toHaveProperty('skinToneSector');
    expect(flat.advancedSectors).toEqual([]);
    expect(flat.skinToneSectors).toEqual([]);
    expect(flat.skinToneSector).toEqual(defaultAdjustments.skinToneSector);
  });
});

// ─── document level vs. layer level ───────────────────────────────

describe('document-level fields', () => {
  it('puts transform and effects on the document, never into a layer', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    const back = project(graphFor(doc), doc);

    expect(back.transform).toEqual(DOC_TRANSFORM);
    expect(back.finalEffects).toEqual(DOC_EFFECTS);
    for (const l of back.layers) {
      for (const field of DOCUMENT_LEVEL_FIELDS) {
        expect(l.adjustments).not.toHaveProperty(field);
      }
    }
  });

  it('follows a transform edited in the graph, on the document', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    // Both branches, or the shared-geometry rule blocks — which is the point
    // of the rule and is asserted separately below.
    let graph = patchParams(graphFor(doc), `default:${KIND_TRANSFORM}`, { flipH: false });
    graph = patchParams(graph, `layer:L1:default:${KIND_TRANSFORM}`, { flipH: false });
    const back = project(graph, doc);

    expect(back.transform.flipH).toBe(false);
    expect(back.transform.flipV).toBe(true);
    expect(findLayer(back, 'base').adjustments).not.toHaveProperty('flipH');
  });

  it('follows a vignette edited in the graph, on the document', () => {
    const doc = documentWith([]);
    const graph = patchParams(graphFor(doc), `default:${KIND_EFFECTS}`, { vignette: 0.25 });
    expect(project(graph, doc).finalEffects.vignette).toBe(25);
  });

  it('keeps cropAspect and the sky fields, which no node carries', () => {
    const doc = documentWith([]);
    doc.finalEffects.skyOpacity = 0.4;
    const back = project(graphFor(doc), doc);
    expect(back.transform.cropAspect).toBe('16:9');
    expect(back.finalEffects.skyOpacity).toBe(0.4);
  });
});

// ─── what the graph says, the document says ───────────────────────

describe('edits made in the graph', () => {
  it('takes a changed base parameter into the base layer', () => {
    const doc = documentWith([]);
    const graph = patchParams(graphFor(doc), `default:${KIND_TONE}`, { exposure: 0.5 });
    expect(findLayer(project(graph, doc), 'base').adjustments.exposure).toBe(50);
  });

  it('restores skin-tone uniformity from the HSL detail params', () => {
    const doc = documentWith([]);
    const graph = graphFor(doc);
    const hslDetail = nodeParams(graph, `default:${KIND_HSL_DETAIL}`);
    const skinTone = hslDetail.skinTone as Record<string, unknown>;
    const edited = patchParams(graph, `default:${KIND_HSL_DETAIL}`, {
      skinTone: { ...skinTone, uniHue: 0.41, uniSat: 0.22, uniLum: 0.63 },
    });

    expect(findLayer(project(edited, doc), 'base').adjustments.skinToneUniformity)
      .toEqual({ hue: 41, saturation: 22, luminance: 63 });
  });

  it('takes a changed terminal crop into the document transform', () => {
    const doc = documentWith([]);
    doc.transform.crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    const graph = patchParams(graphFor(doc), 'document:crop', { x: 0.25, width: 0.5 });

    expect(graph.nodes.get(graph.output)?.kind).toBe(KIND_CROP);
    expect(project(graph, doc).transform.crop).toEqual({ x: 0.25, y: 0.1, width: 0.5, height: 0.8 });
  });

  it('takes opacity and blend mode from the compositor', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA, opacity: 0.8 })]);
    const graph = patchParams(graphFor(doc), 'comp:L1', { opacity: 0.25, blendMode: 'screen' });
    const back = findLayer(project(graph, doc), 'L1');
    expect(back.opacity).toBe(0.25);
    expect(back.blendMode).toBe('screen');
  });

  it('resets a field whose node was deleted', () => {
    const doc = documentWith([]);
    const graph = withoutNode(graphFor(doc), `default:${KIND_TONE}`);
    const back = findLayer(project(graph, doc), 'base').adjustments;

    // The tone node is gone, so its six fields fall back to the default —
    // and nothing else moves.
    expect(back).not.toHaveProperty('exposure');
    expect(back).not.toHaveProperty('blacks');
    expect(back.clarity).toBe(28);
  });

  it('drops a mask the graph no longer binds', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA, mask: MASK })]);
    const graph = graphFor(doc);
    const withoutMask: RenderGraph = {
      ...graph,
      edges: graph.edges.filter((e) => e.to.port !== 'mask'),
    };
    expect(findLayer(project(withoutMask, doc), 'L1').mask).toBeNull();
  });

  it('carries a compositor the user added into a new layer', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    // Same document, one more branch — as if the user had wired it by hand.
    const base = adjustmentsToBuilderAdjustments(documentToAdjustments(doc));
    const graph = buildLayeredGraph(base, [
      { id: 'L1', adjustments: adjustmentsToBuilderAdjustments(LAYER_DELTA), opacity: 1, blendMode: 'normal' },
      { id: 'hand-made', adjustments: { exposure: 4 }, opacity: 0.3, blendMode: 'overlay' },
    ], SDR).graph;
    const back = project(graph, doc);

    expect(back.layers.map((l) => l.id)).toEqual(['base', 'L1', 'comp:hand-made']);
    const added = findLayer(back, 'comp:hand-made');
    expect(added.opacity).toBe(0.3);
    expect(added.blendMode).toBe('overlay');
    expect(added.adjustments).toEqual({ exposure: 4 });
  });
});

// ─── layers the graph never depicts ───────────────────────────────

describe('layers outside the graph', () => {
  it('keeps hidden, zero-opacity and non-adjustment layers in place', () => {
    const doc = documentWith([
      layer({ id: 'hidden', visible: false, adjustments: { exposure: 3 } }),
      layer({ id: 'L1', adjustments: LAYER_DELTA }),
      layer({ id: 'text', type: 'text', text: 'Titel' }),
      layer({ id: 'muted', opacity: 0, adjustments: { contrast: 4 } }),
      layer({ id: 'L2', adjustments: { exposure: -9 }, blendMode: 'multiply' }),
    ]);
    const back = project(graphFor(doc), doc);
    expect(back.layers.map((l) => l.id))
      .toEqual(['base', 'hidden', 'L1', 'text', 'muted', 'L2']);
    expect(back).toEqual(doc);
  });
});

// ─── blocking ─────────────────────────────────────────────────────

describe('blocked projections', () => {
  it('reports a node the classic view has no equivalent for', () => {
    const doc = documentWith([]);
    const graph = retypeNode(graphFor(doc), `default:${KIND_TONE}`, KIND_CUSTOM_LUT);
    expect(blockedBy(graph, doc)).toContainEqual({
      nodeId: `default:${KIND_TONE}`,
      reason: CHAIN_REASONS.noClassicEquivalent(KIND_CUSTOM_LUT),
    });
  });

  it('reports a branch whose transform drifted away from the base', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    const graph = patchParams(graphFor(doc), `layer:L1:default:${KIND_TRANSFORM}`, { flipH: false });
    expect(blockedBy(graph, doc)).toContainEqual({
      nodeId: `layer:L1:default:${KIND_TRANSFORM}`,
      reason: PARAM_REASONS.branchDiffers('flipH'),
    });
  });

  it('reports a structural finding on its own', () => {
    const doc = documentWith([]);
    const graph = graphFor(doc);
    const nodes = new Map(graph.nodes);
    nodes.set('second-source', { id: 'second-source', kind: KIND_IMAGE_BITMAP_SOURCE, params: {} });
    expect(blockedBy({ ...graph, nodes }, doc).map((b) => b.reason))
      .toEqual([SHAPE_REASONS.severalImageSources, SHAPE_REASONS.severalImageSources]);
  });

  it('reports a mask input that has no mask shape behind it', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA, mask: MASK })]);
    // Same graph, but the document that could explain the mask is gone.
    expect(blockedBy(graphFor(doc))).toContainEqual({
      nodeId: 'mask:L1',
      reason: DOCUMENT_REASONS.maskWithoutShape,
    });
  });

  it('reports custom color sectors that cannot be split up again', () => {
    const sector: ColorEditorSector = {
      id: 'a1', hueCenter: 120, hueHalfWidth: 30, satMin: 10, satMax: 90, feather: 0.25,
      pickRelHue: 0.5, pickRelSat: 0.5, selLightness: 0, dH: 5, dS: -10, dL: 15, enabled: true,
    };
    const doc = documentWith([], { ...BASE_ADJUSTMENTS, advancedSectors: [sector] });
    const graph = graphFor(doc);
    const sectors = nodeParams(graph, `default:${KIND_CUSTOM_HSL}`).sectors as unknown[];
    const withOneMore = patchParams(graph, `default:${KIND_CUSTOM_HSL}`, {
      sectors: [...sectors, { hueCenter: 300, hueHalfWidth: 10, feather: 0.2, dH: 1, dS: 2, dL: 3 }],
    });
    expect(blockedBy(withOneMore, doc)).toContainEqual({
      nodeId: withOneMore.output,
      reason: DOCUMENT_REASONS.customHslSplit,
    });
  });

  it('splits sectors back into the lists they came from', () => {
    const advanced: ColorEditorSector = {
      id: 'a1', hueCenter: 120, hueHalfWidth: 30, satMin: 10, satMax: 90, feather: 0.25,
      pickRelHue: 0.5, pickRelSat: 0.5, selLightness: 0, dH: 5, dS: -10, dL: 15, enabled: true,
    };
    const doc = documentWith([], { ...BASE_ADJUSTMENTS, advancedSectors: [advanced] });
    const graph = graphFor(doc);
    const sectors = nodeParams(graph, `default:${KIND_CUSTOM_HSL}`).sectors as Record<string, unknown>[];
    // The user drags the first sector's hue shift in the graph. It has to go
    // back into advancedSectors, keeping the id and saturation range the
    // node never saw.
    const edited = patchParams(graph, `default:${KIND_CUSTOM_HSL}`, {
      sectors: [{ ...sectors[0], dH: 44 }, sectors[1]],
    });
    const back = findLayer(project(edited, doc), 'base').adjustments;
    expect(back.advancedSectors).toEqual([{ ...advanced, dH: 44 }]);
    expect(back).not.toHaveProperty('skinToneSectors');
  });

  it('enables a base sector when the graph removes its optional enabled flag', () => {
    const advanced: ColorEditorSector = {
      id: 'disabled-base', hueCenter: 120, hueHalfWidth: 30, satMin: 10, satMax: 90, feather: 12,
      pickRelHue: 0.5, pickRelSat: 0.5, selLightness: 0,
      dH: 25, dS: 0, dL: 0, enabled: false,
    };
    const doc = documentWith([], { ...BASE_ADJUSTMENTS, advancedSectors: [advanced] });
    const graph = graphFor(doc);
    const id = `default:${KIND_CUSTOM_HSL}`;
    const sectors = nodeParams(graph, id).sectors as Record<string, unknown>[];
    const withoutEnabled = { ...sectors[0] };
    delete withoutEnabled.enabled;
    const edited = patchParams(graph, id, {
      sectors: [withoutEnabled, ...sectors.slice(1)],
    });

    expect(findLayer(project(graph, doc), 'base').adjustments.advancedSectors)
      .toEqual([advanced]);
    const projected = project(edited, doc);
    expect(findLayer(projected, 'base').adjustments.advancedSectors)
      .toEqual([{ ...advanced, enabled: true }]);
    expect(project(graphFor(projected), projected)).toEqual(projected);
  });

  it('applies the same omitted-enabled default to an adjustment layer', () => {
    const advanced: ColorEditorSector = {
      id: 'disabled-layer', hueCenter: 285, hueHalfWidth: 17, satMin: 22, satMax: 88, feather: 6,
      pickRelHue: 0.8, pickRelSat: 0.3, selLightness: 14,
      dH: -4, dS: 21, dL: -9, enabled: false,
    };
    const doc = documentWith([
      layer({ id: 'L1', adjustments: { advancedSectors: [advanced] } }),
    ], {});
    const graph = graphFor(doc);
    const id = `layer:L1:default:${KIND_CUSTOM_HSL}`;
    const sectors = nodeParams(graph, id).sectors as Record<string, unknown>[];
    const withoutEnabled = { ...sectors[0] };
    delete withoutEnabled.enabled;
    const edited = patchParams(graph, id, {
      sectors: [withoutEnabled, ...sectors.slice(1)],
    });

    expect(findLayer(project(graph, doc), 'L1').adjustments.advancedSectors)
      .toEqual([advanced]);
    const projected = project(edited, doc);
    expect(findLayer(projected, 'L1').adjustments.advancedSectors)
      .toEqual([{ ...advanced, enabled: true }]);
    expect(project(graphFor(projected), projected)).toEqual(projected);
  });

  it('keeps a legacy omitted base flag through round trips and shader edits', () => {
    const legacy: ColorEditorSector = {
      id: 'legacy-base', hueCenter: 80, hueHalfWidth: 21, satMin: 13, satMax: 79, feather: 7,
      pickRelHue: 0.3, pickRelSat: 0.6, selLightness: -8,
      dH: 12, dS: -5, dL: 9, enabled: true,
    };
    delete (legacy as Partial<ColorEditorSector>).enabled;
    const doc = documentWith([], { ...BASE_ADJUSTMENTS, advancedSectors: [legacy] });
    const graph = graphFor(doc);
    const id = `default:${KIND_CUSTOM_HSL}`;

    expect(Object.prototype.hasOwnProperty.call(legacy, 'enabled')).toBe(false);
    expect(project(graph, doc)).toEqual(doc);

    const sectors = nodeParams(graph, id).sectors as Record<string, unknown>[];
    const shaderEdited = patchParams(graph, id, {
      sectors: [{ ...sectors[0], dH: 44 }, ...sectors.slice(1)],
    });
    const projected = project(shaderEdited, doc);
    const projectedSector = findLayer(projected, 'base').adjustments.advancedSectors?.[0];
    expect(projectedSector).toEqual({ ...legacy, dH: 44 });
    expect(Object.prototype.hasOwnProperty.call(projectedSector, 'enabled')).toBe(false);
    expect(project(graphFor(projected), projected)).toEqual(projected);

    const explicitlyDisabled = project(patchParams(graph, id, {
      sectors: [{ ...sectors[0], enabled: false }, ...sectors.slice(1)],
    }), doc);
    expect(findLayer(explicitlyDisabled, 'base').adjustments.advancedSectors)
      .toEqual([{ ...legacy, enabled: false }]);
  });

  it('keeps a legacy omitted layer flag byte-identical', () => {
    const legacy: ColorEditorSector = {
      id: 'legacy-layer', hueCenter: 210, hueHalfWidth: 19, satMin: 7, satMax: 84, feather: 11,
      pickRelHue: 0.65, pickRelSat: 0.35, selLightness: 6,
      dH: -13, dS: 17, dL: -4, enabled: true,
    };
    delete (legacy as Partial<ColorEditorSector>).enabled;
    const doc = documentWith([
      layer({ id: 'L1', adjustments: { advancedSectors: [legacy] } }),
    ], {});

    const projected = project(graphFor(doc), doc);
    expect(projected).toEqual(doc);
    expect(Object.prototype.hasOwnProperty.call(
      findLayer(projected, 'L1').adjustments.advancedSectors?.[0],
      'enabled',
    )).toBe(false);
  });

  it('keeps all three sector lists exact when a previous document defines the split', () => {
    const advanced: ColorEditorSector = {
      id: 'advanced', hueCenter: 130, hueHalfWidth: 22, satMin: 5, satMax: 83, feather: 8,
      pickRelHue: 0.25, pickRelSat: 0.75, selLightness: -12,
      dH: 9, dS: -7, dL: 18, enabled: true,
    };
    const skinList: ColorEditorSector = {
      id: 'skin-list', hueCenter: 18, hueHalfWidth: 11, satMin: 12, satMax: 67, feather: 5,
      pickRelHue: 0.6, pickRelSat: 0.4, selLightness: 7,
      dH: -3, dS: 8, dL: -5, enabled: false,
    };
    const skinSingle: ColorEditorSector = {
      id: 'skin-single', hueCenter: 31, hueHalfWidth: 16, satMin: 24, satMax: 72, feather: 10,
      pickRelHue: 0.45, pickRelSat: 0.55, selLightness: 3,
      dH: 4, dS: -6, dL: 2, enabled: true,
    };
    const doc = documentWith([], {
      ...BASE_ADJUSTMENTS,
      advancedSectors: [advanced],
      skinToneSectors: [skinList],
      skinToneSector: skinSingle,
    });

    expect(project(graphFor(doc), doc)).toEqual(doc);
  });

  it('reports every independent finding at once', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    let graph = retypeNode(graphFor(doc), `default:${KIND_TONE}`, KIND_CUSTOM_LUT);
    graph = patchParams(graph, `layer:L1:default:${KIND_TRANSFORM}`, { flipH: false });
    const reasons = blockedBy(graph, doc).map((b) => b.reason);
    expect(reasons).toContainEqual(CHAIN_REASONS.noClassicEquivalent(KIND_CUSTOM_LUT));
    expect(reasons).toContainEqual(PARAM_REASONS.branchDiffers('flipH'));
  });
});

// ─── preset identity ──────────────────────────────────────────────

describe('preset layers', () => {
  it('keeps the preset marker so the next preset replaces the layer', () => {
    const doc = documentWith([
      layer({
        id: 'P1', name: 'Preset · Kodak', opacity: 0.65, presetSyncId: 'sync-kodak',
        adjustments: { saturation: 14, grain: 33 },
      }),
    ]);
    const back = findLayer(project(graphFor(doc), doc), 'P1');
    expect(back.presetSyncId).toBe('sync-kodak');
    // Its own grain stays on the layer — that is what the Amount slider fades.
    expect(back.adjustments.grain).toBe(33);
  });

  it('marks a projected preset layer even without a previous document', () => {
    const doc = documentWith([
      layer({ id: 'P1', opacity: 0.65, presetSyncId: 'sync-kodak', adjustments: { saturation: 14, grain: 33 } }),
    ]);
    const fresh = project(graphFor(doc));
    expect(findLayer(fresh, 'comp:P1').presetSyncId).toBe('sync-kodak');
    expect(findLayer(fresh, 'comp:P1').adjustments.grain).toBe(33);
  });

  it('leaves an ordinary layer without a marker', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    expect(findLayer(project(graphFor(doc), doc), 'L1')).not.toHaveProperty('presetSyncId');
  });
});

// ─── the strip rule mirrors PresetLayer ───────────────────────────

describe('what a layer may carry', () => {
  /**
   * `writeAdjustments` skips the transform fields on a preset layer and all
   * document-level fields on an ordinary one. That is a second spelling of
   * `layerAdjustmentsForRendering`'s rule, so it is checked against the
   * original rather than trusted.
   */
  it('skips exactly what layerAdjustmentsForRendering strips', () => {
    const all: Partial<Adjustments> = { rotation: 5, flipH: true, cropAspect: '1:1', vignette: 20, grain: 10 };
    const ordinary = layerAdjustmentsForRendering(layer({ id: 'x', adjustments: all }));
    const preset = layerAdjustmentsForRendering(
      layer({ id: 'y', adjustments: all, presetSyncId: 'p' }),
    );
    expect(Object.keys(ordinary)).toEqual([]);
    expect(Object.keys(preset).sort()).toEqual(['grain', 'vignette']);
  });
});

// ─── grouping for the "what is in the way" list ───────────────────

describe('groupBlockedByNode', () => {
  const FIRST = SHAPE_REASONS.cycle;
  const SECOND = SHAPE_REASONS.missingInput;
  const THIRD = SHAPE_REASONS.notAStack;

  it('puts every reason of one node into one entry', () => {
    // The case the gate list exists for: a node that broke two rules at once
    // must not read as two problems.
    expect(groupBlockedByNode([
      { nodeId: 'a', reason: FIRST },
      { nodeId: 'b', reason: SECOND },
      { nodeId: 'a', reason: THIRD },
    ])).toEqual([
      { nodeId: 'a', reasons: [FIRST, THIRD] },
      { nodeId: 'b', reasons: [SECOND] },
    ]);
  });

  it('keeps the order the rules reported the nodes in', () => {
    expect(groupBlockedByNode([{ nodeId: 'z', reason: FIRST }, { nodeId: 'a', reason: SECOND }])
      .map((g) => g.nodeId)).toEqual(['z', 'a']);
  });

  it('drops a reason that was reported twice for the same node', () => {
    expect(groupBlockedByNode([{ nodeId: 'a', reason: FIRST }, { nodeId: 'a', reason: FIRST }]))
      .toEqual([{ nodeId: 'a', reasons: [FIRST] }]);
  });

  it('tells two findings of the same rule apart by their params', () => {
    // Same key, different placeholder values: two sentences, so two entries.
    // Comparing the objects by identity would merge them.
    expect(groupBlockedByNode([
      { nodeId: 'a', reason: PARAM_REASONS.branchDiffers('flipH') },
      { nodeId: 'a', reason: PARAM_REASONS.branchDiffers('flipV') },
      { nodeId: 'a', reason: PARAM_REASONS.branchDiffers('flipH') },
    ])).toEqual([{
      nodeId: 'a',
      reasons: [PARAM_REASONS.branchDiffers('flipH'), PARAM_REASONS.branchDiffers('flipV')],
    }]);
  });

  it('groups what a real blocked projection reports', () => {
    const doc = documentWith([layer({ id: 'L1', adjustments: LAYER_DELTA })]);
    let graph = retypeNode(graphFor(doc), `default:${KIND_TONE}`, KIND_CUSTOM_LUT);
    graph = patchParams(graph, `layer:L1:default:${KIND_TRANSFORM}`, { flipH: false });
    const groups = groupBlockedByNode(blockedBy(graph, doc));
    expect(groups.map((g) => g.nodeId).sort())
      .toEqual([`default:${KIND_TONE}`, `layer:L1:default:${KIND_TRANSFORM}`]);
  });
});
