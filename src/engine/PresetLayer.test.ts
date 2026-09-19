import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PresetRow } from '../storage/repos';
import { withoutLensCorrection } from '../types';
import { createDocument } from './DocumentModel';
import {
  applyPresetAsLayer,
  DEFAULT_PRESET_STRENGTH,
  findPresetLayer,
  setPresetLayerStrength,
} from './PresetLayer';

const preset = (syncId: string, exposure: number): PresetRow => ({
  id: 1,
  syncId,
  name: syncId,
  adjustments: { exposure, rotation: 12, grain: 20 },
  category: 'Test',
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
});

describe('preset look layer', () => {
  it('creates the gallery preset layer at the default strength', () => {
    const document = createDocument();
    document.layers[0].adjustments = { exposure: 17 };

    const result = applyPresetAsLayer(document, preset('gallery', 10), DEFAULT_PRESET_STRENGTH);

    expect(result.layers[0].adjustments).toEqual({ exposure: 17 });
    expect(findPresetLayer(result)).toMatchObject({ presetSyncId: 'gallery', opacity: 1 });
  });

  it('preserves base edits and strips geometry from the preset layer', () => {
    const document = createDocument();
    document.layers[0].adjustments = { exposure: 17 };

    const result = applyPresetAsLayer(document, preset('warm', 10), 65);
    const layer = findPresetLayer(result)!;

    expect(result.layers[0].adjustments.exposure).toBe(17);
    expect(layer.adjustments).toMatchObject({ exposure: 10, grain: 20 });
    expect(layer.adjustments.rotation).toBeUndefined();
    expect(layer.opacity).toBe(0.65);
  });

  it('replaces the current preset instead of stacking looks', () => {
    const first = applyPresetAsLayer(createDocument(), preset('warm', 10));
    const second = applyPresetAsLayer(first, preset('cool', -10), 80);

    expect(second.layers).toHaveLength(2);
    expect(findPresetLayer(second)).toMatchObject({
      presetSyncId: 'cool',
      opacity: 0.8,
      adjustments: { exposure: -10 },
    });
  });

  it('updates only the preset layer opacity', () => {
    const document = applyPresetAsLayer(createDocument(), preset('warm', 10));
    expect(findPresetLayer(setPresetLayerStrength(document, 25))?.opacity).toBe(0.25);
  });
});

describe('lens correction is a property of the glass, not of a preset', () => {
  /** A preset made on a photo whose lens was corrected with profile X. */
  const glassPreset = (): PresetRow => ({
    ...preset('film', 10),
    adjustments: {
      exposure: 10,
      lensCorrection: true,
      lensCorrectionProfile: 'X',
      lensCorrectionStrength: 60,
      vignette: -20,
      vignetteFeather: 70,
      distortion: 12,
    },
  });

  it('drops only the three correction fields from a set of adjustments', () => {
    const stripped = withoutLensCorrection(glassPreset().adjustments);

    expect(stripped.lensCorrection).toBeUndefined();
    expect(stripped.lensCorrectionProfile).toBeUndefined();
    expect(stripped.lensCorrectionStrength).toBeUndefined();
    expect(stripped).toEqual({
      exposure: 10, vignette: -20, vignetteFeather: 70, distortion: 12,
    });
  });

  it('keeps the correction off the preset layer and the vignette on it', () => {
    const layer = findPresetLayer(applyPresetAsLayer(createDocument(), glassPreset()))!;

    expect(layer.adjustments.lensCorrection).toBeUndefined();
    expect(layer.adjustments.lensCorrectionProfile).toBeUndefined();
    expect(layer.adjustments.lensCorrectionStrength).toBeUndefined();
    expect(layer.adjustments.vignette).toBe(-20);
    expect(layer.adjustments.vignetteFeather).toBe(70);
  });

  it('sets the designerly distortion on the document, never on the layer', () => {
    const result = applyPresetAsLayer(createDocument(), glassPreset());

    // Geometry on a layer would be re-applied once per layer.
    expect(findPresetLayer(result)!.adjustments.distortion).toBeUndefined();
    expect(result.transform.distortion).toBe(12);
  });

  it('does not undo a hand-dialled distortion with a preset that carries the default', () => {
    const document = createDocument();
    document.transform.distortion = 8;
    const flat = { ...glassPreset(), adjustments: { exposure: 10, distortion: 0 } };

    expect(applyPresetAsLayer(document, flat).transform.distortion).toBe(8);
    // And a preset that says nothing about distortion leaves it alone too.
    expect(applyPresetAsLayer(document, preset('warm', 10)).transform.distortion).toBe(8);
  });
});

describe('retired classic preset path', () => {
  it('does not restore the test-only applyPresetAdjustments export', () => {
    const source = readFileSync(fileURLToPath(new URL('./PresetLayer.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/export function applyPresetAdjustments\b/);
  });

  it('keeps both gallery entry points on the document fan-out preset-layer path', () => {
    const source = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');
    const layerChanges = source.match(
      /\(document\) => applyPresetAsLayer\(document, preset, DEFAULT_PRESET_STRENGTH\)/g,
    );

    expect(layerChanges).toHaveLength(2);
    expect(source).not.toContain('fanOutQuickDev');
  });
});
