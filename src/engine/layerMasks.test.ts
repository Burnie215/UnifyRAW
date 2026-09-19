import { describe, expect, it } from 'vitest';

import { addMaskToDocument, layerIdOfMask, masksOfDocument, normalizeLoadedDocument } from './layerMasks';
import { createDocLayer, createDocument, type DocLayer, type PhotoDocument } from './DocumentModel';
import { createMask, type MaskDefinition } from './Mask';
import type { Adjustments } from '../types';

function docWith(...layers: Partial<DocLayer>[]): PhotoDocument {
  const base = createDocument();
  return {
    ...base,
    layers: [
      ...base.layers,
      ...layers.map((over, i) => ({ ...createDocLayer('adjustment'), id: `L${i}`, ...over })),
    ],
  };
}

/** A mask as it was stored while the effect still sat on the mask. */
function legacyMask(id: string, adjustments: Partial<Adjustments>): MaskDefinition {
  return { ...createMask('radial-gradient'), id, adjustments } as MaskDefinition;
}

describe('addMaskToDocument', () => {
  it('creates an adjustment layer when nothing is selected', () => {
    const doc = createDocument();
    const mask = createMask('brush');
    const { document, layerId } = addMaskToDocument(doc, null, mask);

    expect(document.layers).toHaveLength(2);
    const added = document.layers[1];
    expect(added.id).toBe(layerId);
    expect(added.type).toBe('adjustment');
    expect(added.mask).toBe(mask);
    // The input document is never touched — it may still be rendering.
    expect(doc.layers).toHaveLength(1);
  });

  it('creates an adjustment layer right behind the base layer', () => {
    const doc = docWith({ id: 'L0' });
    const baseId = doc.layers[0].id;
    const { document, layerId } = addMaskToDocument(doc, baseId, createMask('brush'));

    expect(document.layers.map((l) => l.id)).toEqual([baseId, layerId, 'L0']);
    expect(document.layers[0].mask).toBeNull();
  });

  it('puts the mask on an active adjustment layer that has none', () => {
    const doc = docWith({ id: 'L0', adjustments: { exposure: 30 } });
    const mask = createMask('radial-gradient');
    const { document, layerId } = addMaskToDocument(doc, 'L0', mask);

    expect(layerId).toBe('L0');
    expect(document.layers).toHaveLength(2);
    expect(document.layers[1].mask).toBe(mask);
    expect(document.layers[1].adjustments).toEqual({ exposure: 30 });
  });

  it('adds a NEW layer instead of replacing a mask that is already there', () => {
    const existing = createMask('brush');
    existing.strokes = [{ points: [{ x: 0.1, y: 0.1 }], radius: 20, feather: 0.5, flow: 1, erase: false }];
    const doc = docWith({ id: 'L0', mask: existing }, { id: 'L1' });
    const { document, layerId } = addMaskToDocument(doc, 'L0', createMask('radial-gradient'));

    expect(layerId).not.toBe('L0');
    expect(document.layers.map((l) => l.id)).toEqual([doc.layers[0].id, 'L0', layerId, 'L1']);
    // The strokes the user drew survive.
    expect(document.layers[1].mask).toBe(existing);
    expect(document.layers[2].mask?.type).toBe('radial-gradient');
  });
});

describe('layerIdOfMask / masksOfDocument', () => {
  it('names the owning layer and lists the masks in layer order', () => {
    const first = createMask('brush');
    const second = createMask('linear-gradient');
    const doc = docWith({ id: 'L0', mask: first }, { id: 'L1' }, { id: 'L2', mask: second });

    expect(masksOfDocument(doc)).toEqual([first, second]);
    expect(layerIdOfMask(doc, first.id)).toBe('L0');
    expect(layerIdOfMask(doc, second.id)).toBe('L2');
    expect(layerIdOfMask(doc, 'nope')).toBeNull();
    expect(layerIdOfMask(doc, null)).toBeNull();
    expect(masksOfDocument(null)).toEqual([]);
  });
});

describe('normalizeLoadedDocument', () => {
  it('moves an old mask.adjustments into the layer and drops the field', () => {
    const doc = docWith({ id: 'L0', adjustments: { contrast: 12 }, mask: legacyMask('m1', { exposure: 50 }) });
    const normalized = normalizeLoadedDocument(doc);

    expect(normalized.layers[1].adjustments).toEqual({ contrast: 12, exposure: 50 });
    expect('adjustments' in normalized.layers[1].mask!).toBe(false);
  });

  it('lets the migrated value win over the layer for the same field', () => {
    const doc = docWith({ id: 'L0', adjustments: { exposure: 10 }, mask: legacyMask('m1', { exposure: -40 }) });
    expect(normalizeLoadedDocument(doc).layers[1].adjustments).toEqual({ exposure: -40 });
  });

  it('strips an empty field without inventing adjustments', () => {
    const doc = docWith({ id: 'L0', adjustments: { exposure: 10 }, mask: legacyMask('m1', {}) });
    const normalized = normalizeLoadedDocument(doc);

    expect(normalized.layers[1].adjustments).toEqual({ exposure: 10 });
    expect('adjustments' in normalized.layers[1].mask!).toBe(false);
  });

  it('hands back a document that has nothing to migrate unchanged', () => {
    const doc = docWith({ id: 'L0', mask: createMask('brush') }, { id: 'L1' });
    expect(normalizeLoadedDocument(doc)).toBe(doc);
  });
});
