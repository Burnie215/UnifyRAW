import type { ColorEditorSector } from '../types';
import type { HslDetailSkinTone } from './graph/passKinds';

export interface SkinToneUniformity {
  hue: number;
  saturation: number;
  luminance: number;
}

export function skinTonePickFor(sector: ColorEditorSector): { hue: number; sat: number } {
  const hue = sector.hueCenter
    + (sector.pickRelHue - 0.5) * 2 * sector.hueHalfWidth;
  const sat = sector.satMin
    + sector.pickRelSat * (sector.satMax - sector.satMin);
  return { hue: (hue + 360) % 360, sat };
}

export function skinToneParamsFor(
  sector: ColorEditorSector,
  uniformity: SkinToneUniformity,
): HslDetailSkinTone | undefined {
  if (uniformity.hue === 0
    && uniformity.saturation === 0
    && uniformity.luminance === 0) return undefined;

  const pick = skinTonePickFor(sector);
  return {
    refHue: pick.hue,
    refSat: pick.sat,
    refLum: 50 + sector.selLightness * 0.5,
    uniHue: uniformity.hue / 100,
    uniSat: uniformity.saturation / 100,
    uniLum: uniformity.luminance / 100,
    halfWidth: sector.hueHalfWidth,
  };
}
