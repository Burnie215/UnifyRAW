/**
 * Masks as pure document operations.
 *
 * A mask belongs to exactly one adjustment layer and its effect IS that
 * layer's `adjustments`. Nothing else owns a mask: no hook state beside the
 * document, and no `adjustments` field on the mask itself (F001). Every
 * surface — canvas, thumbnail, export, graph view, sync — reads the document,
 * so a mask that lives here is a mask everybody sees.
 */
import { createDocLayer, type DocLayer, type PhotoDocument } from './DocumentModel';
import type { MaskDefinition } from './Mask';
import type { Adjustments } from '../types';

/** A mask as it was stored while `MaskDefinition` still carried its own effect. */
type LegacyMask = MaskDefinition & { adjustments?: Partial<Adjustments> };

/** Every mask in the document, in layer order. */
export function masksOfDocument(doc: PhotoDocument | null | undefined): MaskDefinition[] {
  if (!doc) return [];
  return doc.layers.filter((l): l is DocLayer & { mask: MaskDefinition } => !!l.mask).map((l) => l.mask);
}

/** Which layer owns this mask, or null if no layer does. */
export function layerIdOfMask(doc: PhotoDocument | null | undefined, maskId: string | null): string | null {
  if (!doc || !maskId) return null;
  return doc.layers.find((l) => l.mask?.id === maskId)?.id ?? null;
}

/**
 * Put `mask` on a layer and say which layer got it.
 *
 * An active adjustment layer without a mask takes it. Anything else — no
 * selection, the base layer, or an adjustment layer that ALREADY has a mask —
 * gets a fresh adjustment layer right behind the active one. Replacing an
 * existing mask here would throw away brush strokes without asking; the layer
 * panel stays the place to do that deliberately (user decision 2026-09-12).
 */
export function addMaskToDocument(
  doc: PhotoDocument,
  activeLayerId: string | null,
  mask: MaskDefinition,
): { document: PhotoDocument; layerId: string } {
  const index = doc.layers.findIndex((l) => l.id === activeLayerId);
  const active = index >= 0 ? doc.layers[index] : null;

  if (active && active.type === 'adjustment' && !active.mask) {
    return {
      document: { ...doc, layers: doc.layers.map((l) => (l.id === active.id ? { ...l, mask } : l)) },
      layerId: active.id,
    };
  }

  const layer: DocLayer = { ...createDocLayer('adjustment'), mask };
  const layers = [...doc.layers];
  layers.splice(index >= 0 ? index + 1 : layers.length, 0, layer);
  return { document: { ...doc, layers }, layerId: layer.id };
}

/**
 * Move a stored document to the one-owner model: an old `mask.adjustments`
 * becomes the adjustments of the layer that carries the mask, then the field
 * is gone for good.
 *
 * The migrated values win over the layer's own for the fields they name: on
 * the old canvas the CSS overlay drew them ON TOP of the layer's engine
 * render, so that is the picture the user last saw. They never reached export,
 * thumbnail or sync, so those surfaces change — deliberately (user decision
 * 2026-09-12).
 */
export function normalizeLoadedDocument(doc: PhotoDocument): PhotoDocument {
  let changed = false;
  const layers = doc.layers.map((l) => {
    if (!l.mask) return l;
    const { adjustments: legacy, ...mask } = l.mask as LegacyMask;
    if (legacy === undefined) return l;
    changed = true;
    return { ...l, adjustments: { ...l.adjustments, ...legacy }, mask: mask as MaskDefinition };
  });
  return changed ? { ...doc, layers } : doc;
}
