import type { PresetRow } from '../storage/repos';
import { defaultAdjustments, withoutLensCorrection, type Adjustments } from '../types';
import {
  createDocLayer,
  documentOwnedFields,
  TRANSFORM_FIELDS,
  type DocLayer,
  type DocTransform,
  type PhotoDocument,
} from './DocumentModel';

export const DEFAULT_PRESET_STRENGTH = 100;

export function findPresetLayer(document: PhotoDocument): DocLayer | null {
  return [...document.layers].reverse().find(
    (layer) => layer.type === 'adjustment' && !!layer.presetSyncId,
  ) ?? null;
}

function presetAdjustments(preset: PresetRow): Partial<Adjustments> {
  // The lens correction belongs to the glass, never to a look: on a preset
  // layer it would bend a foreign lens profile onto this photo, once per layer.
  const adjustments = withoutLensCorrection({ ...preset.adjustments });
  // Geometry remains document-level. Look effects such as grain/vignette are
  // intentionally kept on the preset layer so Amount can blend them too.
  for (const field of TRANSFORM_FIELDS) {
    delete (adjustments as Record<string, unknown>)[field];
  }
  return adjustments;
}

/**
 * The document transform a preset leaves behind.
 *
 * `distortion` is the one designerly field that is geometry: a layer carrying
 * it would re-apply it once per layer (DOCUMENT_LEVEL_FIELDS), so the preset
 * sets it on the document instead. Only a non-default value counts as set -
 * every preset saved from a photo carries `distortion: 0` whether or not the
 * user meant anything by it, and that must not undo a distortion dialled in
 * by hand.
 */
function presetTransform(current: DocTransform, adjustments: Partial<Adjustments>): DocTransform {
  const { distortion } = adjustments;
  if (distortion === undefined || distortion === defaultAdjustments.distortion) return current;
  return { ...current, distortion };
}

/** Remove fields that cannot safely be evaluated inside this layer type. */
export function layerAdjustmentsForRendering(layer: DocLayer): Partial<Adjustments> {
  const adjustments = { ...(layer.adjustments ?? {}) };
  for (const field of documentOwnedFields(layer.presetSyncId)) {
    delete (adjustments as Record<string, unknown>)[field];
  }
  return adjustments;
}

/** Apply a preset as one replaceable look layer, preserving all base edits. */
export function applyPresetAsLayer(
  document: PhotoDocument,
  preset: PresetRow,
  strength = DEFAULT_PRESET_STRENGTH,
): PhotoDocument {
  const opacity = Math.max(0, Math.min(1, strength / 100));
  const current = findPresetLayer(document);
  const nextLayer: DocLayer = {
    ...(current ?? createDocLayer('adjustment')),
    name: `Preset · ${preset.name}`,
    type: 'adjustment',
    visible: true,
    opacity,
    blendMode: 'normal',
    adjustments: presetAdjustments(preset),
    mask: null,
    presetSyncId: preset.syncId,
  };

  return {
    ...document,
    transform: presetTransform(document.transform, preset.adjustments),
    layers: current
      ? document.layers.map((layer) => layer.id === current.id ? nextLayer : layer)
      : [...document.layers, nextLayer],
  };
}

export function setPresetLayerStrength(document: PhotoDocument, strength: number): PhotoDocument {
  const presetLayer = findPresetLayer(document);
  if (!presetLayer) return document;
  const opacity = Math.max(0, Math.min(1, strength / 100));
  return {
    ...document,
    layers: document.layers.map((layer) =>
      layer.id === presetLayer.id ? { ...layer, opacity } : layer),
  };
}
