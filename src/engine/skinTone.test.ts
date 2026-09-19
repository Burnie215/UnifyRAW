import { describe, expect, it } from 'vitest';

import { defaultAdjustments } from '../types';
import { skinToneParamsFor, skinTonePickFor } from './skinTone';

const SECTOR = {
  ...defaultAdjustments.skinToneSector,
  hueCenter: 350,
  hueHalfWidth: 20,
  satMin: 10,
  satMax: 90,
  pickRelHue: 0.75,
  pickRelSat: 0.25,
  selLightness: -40,
};

describe('skinToneParamsFor', () => {
  it('derives the shader reference and normalized strengths from the persisted controls', () => {
    expect(skinToneParamsFor(SECTOR, {
      hue: 25,
      saturation: 50,
      luminance: 75,
    })).toEqual({
      refHue: 0,
      refSat: 30,
      refLum: 30,
      uniHue: 0.25,
      uniSat: 0.5,
      uniLum: 0.75,
      halfWidth: 20,
    });
  });

  it('returns no skin-tone params for the identity controls', () => {
    expect(skinToneParamsFor(SECTOR, {
      hue: 0,
      saturation: 0,
      luminance: 0,
    })).toBeUndefined();
  });

  it('shares the wrapped picker formula with the color-editor UI', () => {
    expect(skinTonePickFor(SECTOR)).toEqual({ hue: 0, sat: 30 });
  });
});
