import { describe, expect, it } from 'vitest';
import { projectToDocument } from './projectToDocument';
import { BASE_ADJUSTMENTS, RAW, SDR, documentWith, graphFor, layer } from './projectionFixtures';
import { TRANSFORM_FIELDS } from '../../DocumentModel';
import { defaultAdjustments, withoutLensCorrection, type Adjustments } from '../../../types';

/** What applyPresetAsLayer stores: the whole Adjustments of the photo the
 *  preset was saved from, minus the transform and the lens correction (the
 *  glass is not a look, f0e36b2) - default color ranges included. */
function presetLook(over: Partial<Adjustments> = {}): Partial<Adjustments> {
  const look = withoutLensCorrection(
    { ...defaultAdjustments, saturation: 14, grain: 33, ...over },
  ) as Record<string, unknown>;
  for (const field of TRANSFORM_FIELDS) delete look[field];
  return look as Partial<Adjustments>;
}

/** The base the app can produce: no UI sets a manual lens profile or strength
 *  (the correction comes from the resolved camera profile, for every branch). */
const APP_BASE: Partial<Adjustments> = {
  ...BASE_ADJUSTMENTS, lensCorrection: false, lensCorrectionProfile: null, lensCorrectionStrength: 100,
};

const reasons = (result: ReturnType<typeof projectToDocument>) =>
  result.ok ? [] : result.blocked.map((b) => b.reason);

describe('a preset layer and the color ranges', () => {
  it.each([['SDR', SDR], ['RAW', RAW]] as const)(
    'lets a %s photo with a preset layer go back to classic', (_name, source) => {
      const doc = documentWith([
        layer({ id: 'P1', presetSyncId: 'sync-look', opacity: 0.7, adjustments: presetLook() }),
      ], APP_BASE);
      expect(reasons(projectToDocument(graphFor(doc, source), source, doc))).toEqual([]);
    });

  it('keeps a preset layer\'s own color range through the round trip', () => {
    const ownRange = { ...defaultAdjustments.skinToneSector, id: 'teal', hueCenter: 185, dH: 12, dS: -20 };
    const doc = documentWith([
      layer({ id: 'P1', presetSyncId: 'sync-teal', opacity: 0.7, adjustments: presetLook({ advancedSectors: [ownRange] }) }),
    ], APP_BASE);
    const result = projectToDocument(graphFor(doc, SDR), SDR, doc);
    expect(reasons(result)).toEqual([]);
    if (!result.ok) return;
    const preset = result.document.layers.find((l) => l.id === 'P1')!;
    expect(preset.adjustments.advancedSectors).toEqual([ownRange]);
  });
});
