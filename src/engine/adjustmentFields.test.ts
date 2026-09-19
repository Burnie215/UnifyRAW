import { describe, expect, it } from 'vitest';
import { defaultAdjustments, type Adjustments } from '../types';
import { ADJUSTMENT_PANEL_FIELDS, adjustmentsForPanels } from './adjustmentFields';

const OPTIONAL_ADJUSTMENT_FIELDS = [
  'toneCurveSpace', 'colorGradingSpace', 'hslSpace',
] as const satisfies readonly (keyof Adjustments)[];

describe('adjustment panel field ownership', () => {
  it('classifies every Adjustment key in exactly one panel', () => {
    const expected = [...Object.keys(defaultAdjustments), ...OPTIONAL_ADJUSTMENT_FIELDS].sort();
    const classified = Object.values(ADJUSTMENT_PANEL_FIELDS).flat();

    expect([...classified].sort()).toEqual(expected);
    expect(new Set(classified).size).toBe(classified.length);
    expect(ADJUSTMENT_PANEL_FIELDS.transform).toEqual(expect.arrayContaining([
      'lensCorrection', 'lensCorrectionProfile', 'lensCorrectionStrength',
    ]));
  });

  it('keeps the curve space with a tone-curve-only preset', () => {
    const selected = adjustmentsForPanels(
      { ...defaultAdjustments, toneCurveSpace: 'gamma', exposure: 25 },
      ['tonecurve'],
    );

    expect(selected).toEqual({
      toneCurve: defaultAdjustments.toneCurve,
      toneCurveSpace: 'gamma',
    });
  });
});
