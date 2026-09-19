import { describe, expect, it } from 'vitest';
import { calibrateLegacyLightroomAdjustments, parseLightroomPreset } from './lightroomPreset';

const SAMPLE = `<x:xmpmeta xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:x="adobe:ns:meta/">
<rdf:RDF>
<rdf:Description rdf:about="" crs:Name="Fallback Name" crs:Exposure2012="+0.50" crs:Contrast2012="+20" crs:Highlights2012="-35" crs:HueAdjustmentOrange="-8" crs:SaturationAdjustmentBlue="-20" crs:ColorGradeShadowHue="205" crs:ColorGradeShadowSat="18" crs:ColorGradeHighlightHue="42" crs:ColorGradeHighlightSat="12" crs:ColorGradeBlending="70" crs:ColorGradeBalance="-20" crs:GrainAmount="25" crs:GrainSize="28" crs:CameraProfile="Adobe Color">
<crs:Name><rdf:Alt><rdf:li xml:lang="x-default">Imported Look</rdf:li></rdf:Alt></crs:Name>
<crs:Group><rdf:Alt><rdf:li xml:lang="x-default">Cinematic</rdf:li></rdf:Alt></crs:Group>
<crs:Look><rdf:Description crs:Exposure2012="+4.00" /></crs:Look>
<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 12</rdf:li><rdf:li>128, 128</rdf:li><rdf:li>255, 242</rdf:li></rdf:Seq></crs:ToneCurvePV2012>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>`;

describe('Lightroom XMP preset import', () => {
  it('maps supported global settings and ignores nested profile settings', () => {
    const parsed = parseLightroomPreset(SAMPLE, 'fallback.xmp');

    expect(parsed.name).toBe('Imported Look');
    expect(parsed.category).toBe('Cinematic');
    expect(parsed.adjustments.exposure).toBe(25);
    expect(parsed.adjustments.contrast).toBe(13);
    expect(parsed.adjustments.highlights).toBe(-22.75);
    expect(parsed.adjustments.hsl?.orange.hue).toBe(-6.4);
    expect(parsed.adjustments.hsl?.blue.saturation).toBe(-16);
    expect(parsed.adjustments.colorGrading?.shadows).toMatchObject({ hue: 205, saturation: 13.5 });
    expect(parsed.adjustments.colorGrading?.highlights).toMatchObject({ hue: 42, saturation: 9 });
    expect(parsed.adjustments.toneCurve?.rgb).toHaveLength(3);
    expect(parsed.adjustments.toneCurveSpace).toBe('gamma');
    expect(parsed.adjustments.grain).toBe(20);
    expect(parsed.warnings).toContain('Adobe-Profil/LUT kann nicht übernommen werden.');
  });

  it('reports mask data rather than importing local exposure as global', () => {
    const xmp = `<x:xmpmeta xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:x="adobe:ns:meta/">
      <rdf:RDF><rdf:Description crs:Contrast2012="10"><crs:CorrectionMasks><rdf:Seq><rdf:li crs:Exposure2012="2" /></rdf:Seq></crs:CorrectionMasks></rdf:Description></rdf:RDF>
    </x:xmpmeta>`;
    const parsed = parseLightroomPreset(xmp, 'Masked.xmp');
    expect(parsed.adjustments.exposure).toBeUndefined();
    expect(parsed.adjustments.contrast).toBe(6.5);
    expect(parsed.warnings).toContain('Lokale Masken werden nicht importiert.');
  });

  it('collapses Lightroom channel copies of the composite curve', () => {
    const curve = '<rdf:Seq><rdf:li>0, 12</rdf:li><rdf:li>128, 128</rdf:li><rdf:li>255, 242</rdf:li></rdf:Seq>';
    const xmp = `<x:xmpmeta xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description crs:Name="Curve"><crs:ToneCurvePV2012>${curve}</crs:ToneCurvePV2012><crs:ToneCurvePV2012Red>${curve}</crs:ToneCurvePV2012Red><crs:ToneCurvePV2012Green>${curve}</crs:ToneCurvePV2012Green><crs:ToneCurvePV2012Blue>${curve}</crs:ToneCurvePV2012Blue></rdf:Description></rdf:RDF></x:xmpmeta>`;

    const parsed = parseLightroomPreset(xmp, 'curve.xmp');
    expect(parsed.adjustments.toneCurve?.rgb[0].y).toBeGreaterThan(0);
    expect(parsed.adjustments.toneCurve?.red).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(parsed.adjustments.toneCurve?.green).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(parsed.adjustments.toneCurve?.blue).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('migrates previously imported repeated curves exactly once', () => {
    const repeated = [
      { x: 0, y: 0.1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.9 },
    ];
    const migrated = calibrateLegacyLightroomAdjustments({
      contrast: 20,
      toneCurve: {
        rgb: repeated, luma: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        red: repeated, green: repeated, blue: repeated,
      },
    });

    expect(migrated?.contrast).toBe(13);
    expect(migrated?.toneCurveSpace).toBe('gamma');
    expect(migrated?.toneCurve?.red).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(calibrateLegacyLightroomAdjustments(migrated!)).toBeNull();
  });

  it('rejects unrelated XMP metadata', () => {
    expect(() => parseLightroomPreset('<x:xmpmeta></x:xmpmeta>', 'meta.xmp')).toThrow(/kein Lightroom/);
  });
});
