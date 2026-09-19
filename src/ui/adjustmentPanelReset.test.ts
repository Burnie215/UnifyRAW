import { describe, expect, it } from 'vitest';
import { defaultAdjustments } from '../types';
import { modifiedAdjustmentPanelIds, resetAdjustmentPanel } from './adjustmentPanelReset';

describe('adjustment panel reset', () => {
  it('does not mark neutral panels as modified', () => {
    expect(modifiedAdjustmentPanelIds(defaultAdjustments)).toEqual(new Set());
  });

  it('detects both scalar and nested panel changes', () => {
    const adjustments = {
      ...defaultAdjustments,
      exposure: 20,
      colorGrading: {
        ...defaultAdjustments.colorGrading,
        shadows: { ...defaultAdjustments.colorGrading.shadows, saturation: 12 },
      },
    };
    expect(modifiedAdjustmentPanelIds(adjustments)).toEqual(new Set(['basic', 'colorgrading']));
  });

  it('resets only the requested panel and clones nested defaults', () => {
    const adjustments = {
      ...defaultAdjustments,
      exposure: 18,
      clarity: 22,
      dehaze: 9,
    };
    const reset = resetAdjustmentPanel(adjustments, 'presence');
    expect(reset.exposure).toBe(18);
    expect(reset.clarity).toBe(0);
    expect(reset.dehaze).toBe(0);
    expect(reset.toneCurve).toBe(adjustments.toneCurve);
  });

  it('removes optional color-space overrides when resetting their panel', () => {
    const adjustments = { ...defaultAdjustments, toneCurveSpace: 'gamma' as const };
    const reset = resetAdjustmentPanel(adjustments, 'tonecurve');
    expect(reset.toneCurveSpace).toBeUndefined();
    expect(Object.hasOwn(reset, 'toneCurveSpace')).toBe(false);
  });
});
