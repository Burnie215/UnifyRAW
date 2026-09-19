/**
 * What the panels show and write while an adjustment layer is selected.
 *
 * Measured in the running editor first (plans/screenshots/editorobs): with a
 * layer selected, one vignette change wrote the layer's panel values into the
 * base layer (exposure 40 -> 0, contrast 0 -> 30) and reset the document
 * geometry (rotation 10 -> 0). Both are pinned here.
 *
 * The panels also showed the DEFAULTS for the document's own fields, so a
 * document at vignette 40 read 0 and every change sprang back. Since the
 * user's decision of 2026-09-12 they show and write the document's real
 * values, which is also what makes a reset to the default expressible.
 */
import { describe, expect, it } from 'vitest';

import { defaultAdjustments, type Adjustments } from '../types';
import {
  DOCUMENT_LEVEL_FIELDS,
  applyAdjustmentsToDocument,
  adjustmentsToDocument,
  createDocLayer,
  documentOwnedFields,
  documentToAdjustments,
  patchBaseAdjustments,
  panelAdjustmentsForLayer,
  splitPanelChange,
  type PhotoDocument,
} from './DocumentModel';

const LAYER_ID = 'layer-1';

/** A document with base edits, a rotation, and one adjustment layer. */
function editedDocument(
  layerAdjustments: Partial<Adjustments>,
  presetSyncId?: string,
  documentFields: Partial<Adjustments> = {},
): PhotoDocument {
  const doc = adjustmentsToDocument({ ...defaultAdjustments, exposure: 40, rotation: 10, ...documentFields });
  const layer = { ...createDocLayer('adjustment'), id: LAYER_ID, adjustments: layerAdjustments, presetSyncId };
  return { ...doc, layers: [...doc.layers, layer] };
}

/** Exactly what PhotoEditor.handlePanelChange does for a selected layer. */
function panelChange(doc: PhotoDocument, panelAdjustments: Adjustments): PhotoDocument {
  const layer = doc.layers.find((l) => l.id === LAYER_ID)!;
  const { layerDelta, documentAdjustments } = splitPanelChange(
    panelAdjustments, documentToAdjustments(doc), documentOwnedFields(layer.presetSyncId),
  );
  const withLayer: PhotoDocument = {
    ...doc,
    layers: doc.layers.map((l) => l.id === LAYER_ID ? { ...l, adjustments: layerDelta } : l),
  };
  return documentAdjustments ? applyAdjustmentsToDocument(withLayer, documentAdjustments) : withLayer;
}

/** What the panel shows while that layer is selected. */
function panelOf(doc: PhotoDocument): Adjustments {
  const layer = doc.layers.find((l) => l.id === LAYER_ID)!;
  return panelAdjustmentsForLayer(layer, documentToAdjustments(doc));
}

describe('a panel edit with an adjustment layer selected', () => {
  it('writes a document-level field without touching the base or the geometry', () => {
    const doc = editedDocument({ contrast: 30 });
    const next = panelChange(doc, { ...panelOf(doc), vignette: 40 });

    const base = next.layers.find((l) => l.type === 'base')!;
    expect(base.adjustments.exposure).toBe(40);
    expect(base.adjustments.contrast).toBe(0);
    expect(next.transform.rotation).toBe(10);
    expect(next.finalEffects.vignette).toBe(40);
    expect(next.layers.find((l) => l.id === LAYER_ID)!.adjustments).toEqual({ contrast: 30 });
  });

  it('leaves the document alone when only the layer changed', () => {
    const doc = editedDocument({ contrast: 30 });
    const next = panelChange(doc, { ...panelOf(doc), contrast: 45 });

    expect(next.layers.find((l) => l.id === LAYER_ID)!.adjustments).toEqual({ contrast: 45 });
    expect(next.layers.find((l) => l.type === 'base')).toBe(doc.layers.find((l) => l.type === 'base'));
    expect(next.transform).toBe(doc.transform);
    expect(next.finalEffects).toBe(doc.finalEffects);
  });

  it('keeps the look effects on a preset layer and the geometry on the document', () => {
    const doc = editedDocument({ contrast: 30 }, 'preset-1');
    const next = panelChange(doc, { ...panelOf(doc), vignette: 40 });

    expect(next.layers.find((l) => l.id === LAYER_ID)!.adjustments).toEqual({ contrast: 30, vignette: 40 });
    expect(next.finalEffects.vignette).toBe(0);
    expect(next.transform.rotation).toBe(10);
    expect(next.layers.find((l) => l.type === 'base')!.adjustments.exposure).toBe(40);
  });
});

describe('the document sliders with an adjustment layer selected', () => {
  it('shows the document values and not the defaults', () => {
    const panel = panelOf(editedDocument({ contrast: 30 }, undefined, { vignette: 40, grain: 15 }));

    expect(panel.vignette).toBe(40);
    expect(panel.grain).toBe(15);
    expect(panel.rotation).toBe(10);
    // The layer's own fields still read layer-over-defaults, not the document.
    expect(panel.contrast).toBe(30);
    expect(panel.exposure).toBe(0);
  });

  it('resets a document field to its default instead of dropping the write', () => {
    const doc = editedDocument({ contrast: 30 }, undefined, { vignette: 40 });
    const next = panelChange(doc, { ...panelOf(doc), vignette: 0 });

    expect(next.finalEffects.vignette).toBe(0);
    expect(panelOf(next).vignette).toBe(0);
    expect(next.transform.rotation).toBe(10);
    expect(next.layers.find((l) => l.id === LAYER_ID)!.adjustments).toEqual({ contrast: 30 });
    expect(next.layers.find((l) => l.type === 'base')!.adjustments.exposure).toBe(40);
  });

  it('clears a geometry field the same way', () => {
    const doc = editedDocument({ contrast: 30 });
    const next = panelChange(doc, { ...panelOf(doc), rotation: 0 });

    expect(next.transform.rotation).toBe(0);
    expect(panelOf(next).rotation).toBe(0);
    expect(next.layers.find((l) => l.type === 'base')!.adjustments.exposure).toBe(40);
  });

  it('shows the document geometry on a preset layer, and clears it', () => {
    const doc = editedDocument({ contrast: 30 }, 'preset-1', { distortion: 8, vignette: 40 });

    expect(panelOf(doc).distortion).toBe(8);
    // A preset layer owns the look effects, so the vignette slider is the
    // LAYER's there - it stays at the layer's own value.
    expect(panelOf(doc).vignette).toBe(0);

    const next = panelChange(doc, { ...panelOf(doc), distortion: 0 });
    expect(next.transform.distortion).toBe(0);
    expect(next.finalEffects.vignette).toBe(40);
  });
});

describe('applyAdjustmentsToDocument', () => {
  it('routes document fields while preserving layers, masks and graph metadata', () => {
    const doc = editedDocument({ contrast: 30 });
    const adjustmentLayer = doc.layers.find((layer) => layer.id === LAYER_ID)!;
    adjustmentLayer.mask = {
      id: 'mask-1', name: 'Brush', type: 'brush', visible: true, strokes: [],
    };
    doc.pipelineGraph = {
      id: 'graph-1', nodes: [], edges: [], output: 'output',
      metadata: { createdAt: 1, updatedAt: 2, revision: 3 },
    };
    doc.pipelineMode = 'graph';
    doc.graphLayout = { output: { x: 4, y: 5 } };
    doc.finalEffects.skyOpacity = 0.6;

    const next = applyAdjustmentsToDocument(doc, {
      ...defaultAdjustments, exposure: 25, rotation: -5, grain: 12, vignette: -8,
    });

    const base = next.layers.find((l) => l.type === 'base')!;
    expect(base.adjustments.exposure).toBe(25);
    for (const field of DOCUMENT_LEVEL_FIELDS) {
      expect(Object.hasOwn(base.adjustments, field), field).toBe(false);
    }
    expect(next.transform.rotation).toBe(-5);
    expect(next.finalEffects.grain).toBe(12);
    expect(next.finalEffects.vignette).toBe(-8);
    expect(next.finalEffects.skyOpacity).toBe(0.6);
    expect(next.layers.find((l) => l.id === LAYER_ID)).toBe(adjustmentLayer);
    expect(next.layers.find((l) => l.id === LAYER_ID)!.mask).toBe(adjustmentLayer.mask);
    expect(next.pipelineGraph).toBe(doc.pipelineGraph);
    expect(next.pipelineMode).toBe('graph');
    expect(next.graphLayout).toBe(doc.graphLayout);
  });

  it('preserves the document crop across legacy flat-adjustment writes', () => {
    const doc = editedDocument({ contrast: 30 });
    doc.transform.crop = { x: 0.1, y: 0.2, width: 0.7, height: 0.6 };

    const next = applyAdjustmentsToDocument(doc, { ...defaultAdjustments, exposure: 25 });

    expect(next.transform.crop).toEqual(doc.transform.crop);
  });
});

describe('patchBaseAdjustments', () => {
  it('routes transform and final-effect patches instead of storing dead base keys', () => {
    const doc = editedDocument({ contrast: 30 });
    const next = patchBaseAdjustments(doc, { exposure: 15, rotation: 7, vignette: 30 });
    const base = next.layers.find((layer) => layer.type === 'base')!;

    expect(base.adjustments.exposure).toBe(15);
    expect(base.adjustments.rotation).toBeUndefined();
    expect(base.adjustments.vignette).toBeUndefined();
    expect(next.transform.rotation).toBe(7);
    expect(next.finalEffects.vignette).toBe(30);
    expect(next.layers.find((layer) => layer.id === LAYER_ID)!.adjustments).toEqual({ contrast: 30 });
  });
});
