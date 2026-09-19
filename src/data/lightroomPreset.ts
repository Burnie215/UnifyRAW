import { defaultAdjustments, type Adjustments, type HSLChannel, type ToneCurveAdjustment } from '../types';
import {
  CRS_FIELDS,
  COLOR_GRADE_SCALE,
  CURVE_CALIBRATION,
  HSL_SCALE,
  LEGACY_CALIBRATION_KEYS,
  clamp,
} from './crsScale';

export interface LightroomPresetImport {
  name: string;
  category: string;
  adjustments: Partial<Adjustments>;
  warnings: string[];
  importedFields: string[];
}

const HSL_CHANNELS: HSLChannel[] = [
  'red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta',
];

/** The scale itself lives in crsScale.ts; this is only the lookup the parser
 * walks. */
const SIMPLE_FIELDS: Record<string, {
  key: keyof Adjustments;
  convert: (value: number) => number;
}> = Object.fromEntries(CRS_FIELDS.map((field) => [field.crs, {
  key: field.key,
  convert: field.fromCrs,
}]));

const METADATA_ATTRIBUTES = new Set([
  'PresetType', 'Cluster', 'UUID', 'Name', 'Treatment', 'ProcessVersion',
  'HasSettings', 'SupportsAmount', 'SupportsColor', 'SupportsMonochrome',
  'SupportsHighDynamicRange', 'SupportsNormalDynamicRange',
  'SupportsSceneReferred', 'SupportsOutputReferred', 'RequiresRenditionBehavior',
  'Version', 'WhiteBalance',
]);

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attributesFromPresetDescription(xmp: string): Map<string, string> {
  // Only inspect the outer preset description. Mask/local-adjustment blocks
  // can contain their own Exposure2012 etc. and must not leak into a global preset.
  const opening = xmp.match(/<rdf:Description\b([^>]*)>/i)?.[1] ?? '';
  const attributes = new Map<string, string>();
  const regex = /\bcrs:([\w-]+)\s*=\s*(["'])(.*?)\2/gs;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(opening)) !== null) {
    if (!attributes.has(match[1])) attributes.set(match[1], decodeXml(match[3]));
  }
  return attributes;
}

function alternateText(xmp: string, property: 'Name' | 'Group'): string | null {
  const section = xmp.match(new RegExp(`<crs:${property}\\b[^>]*>([\\s\\S]*?)<\\/crs:${property}>`, 'i'))?.[1];
  if (!section) return null;
  const value = section.match(/<rdf:li\b[^>]*>([\s\S]*?)<\/rdf:li>/i)?.[1];
  return value ? decodeXml(value.trim()) : null;
}

function cloneToneCurve(): ToneCurveAdjustment {
  return {
    rgb: defaultAdjustments.toneCurve.rgb.map((point) => ({ ...point })),
    luma: defaultAdjustments.toneCurve.luma.map((point) => ({ ...point })),
    red: defaultAdjustments.toneCurve.red.map((point) => ({ ...point })),
    green: defaultAdjustments.toneCurve.green.map((point) => ({ ...point })),
    blue: defaultAdjustments.toneCurve.blue.map((point) => ({ ...point })),
  };
}

function parseCurve(xmp: string, property: string): Array<{ x: number; y: number }> | null {
  const body = xmp.match(new RegExp(`<crs:${property}\\b[^>]*>([\\s\\S]*?)<\\/crs:${property}>`, 'i'))?.[1];
  if (!body) return null;
  const points: Array<{ x: number; y: number }> = [];
  const regex = /<rdf:li\b[^>]*>\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*<\/rdf:li>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    points.push({
      x: clamp(Number(match[1]) / 255, 0, 1),
      y: clamp(Number(match[2]) / 255, 0, 1),
    });
  }
  return points.length >= 2 ? points : null;
}

function curvesEqual(
  first: Array<{ x: number; y: number }>,
  second: Array<{ x: number; y: number }>,
): boolean {
  return first.length === second.length && first.every((point, index) =>
    Math.abs(point.x - second[index].x) < 0.005 && Math.abs(point.y - second[index].y) < 0.005);
}

function calibrateCurve(points: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  return points.map(({ x, y }) => ({ x, y: clamp(x + (y - x) * CURVE_CALIBRATION, 0, 1) }));
}

/** One-time repair for presets imported before PhotoLib calibrated Lightroom
 * XMP curves. The repeated composite curve is a sufficiently specific marker,
 * and disappears after migration, making this function idempotent. */
export function calibrateLegacyLightroomAdjustments(
  source: Partial<Adjustments>,
): Partial<Adjustments> | null {
  const toneCurve = source.toneCurve;
  if (!toneCurve || toneCurve.rgb.length < 3 ||
      !curvesEqual(toneCurve.red, toneCurve.rgb) ||
      !curvesEqual(toneCurve.green, toneCurve.rgb) ||
      !curvesEqual(toneCurve.blue, toneCurve.rgb)) {
    return null;
  }

  const result: Partial<Adjustments> = { ...source };
  for (const field of CRS_FIELDS) {
    if (!LEGACY_CALIBRATION_KEYS.includes(field.key)) continue;
    const value = (result as Record<string, unknown>)[field.key];
    if (typeof value === 'number') {
      (result as Record<string, unknown>)[field.key] = field.fromCrs(value);
    }
  }

  if (source.hsl) {
    result.hsl = Object.fromEntries(HSL_CHANNELS.map((channel) => [
      channel,
      {
        hue: clamp(source.hsl![channel].hue * HSL_SCALE, -100, 100),
        saturation: clamp(source.hsl![channel].saturation * HSL_SCALE, -100, 100),
        luminance: clamp(source.hsl![channel].luminance * HSL_SCALE, -100, 100),
      },
    ])) as Adjustments['hsl'];
  }
  if (source.colorGrading) {
    result.colorGrading = {
      ...source.colorGrading,
      shadows: {
        ...source.colorGrading.shadows,
        saturation: clamp(source.colorGrading.shadows.saturation * COLOR_GRADE_SCALE.saturation, 0, 100),
        lumAdj: clamp(source.colorGrading.shadows.lumAdj * COLOR_GRADE_SCALE.lumAdj, -100, 100),
      },
      midtones: {
        ...source.colorGrading.midtones,
        saturation: clamp(source.colorGrading.midtones.saturation * COLOR_GRADE_SCALE.saturation, 0, 100),
        lumAdj: clamp(source.colorGrading.midtones.lumAdj * COLOR_GRADE_SCALE.lumAdj, -100, 100),
      },
      highlights: {
        ...source.colorGrading.highlights,
        saturation: clamp(source.colorGrading.highlights.saturation * COLOR_GRADE_SCALE.saturation, 0, 100),
        lumAdj: clamp(source.colorGrading.highlights.lumAdj * COLOR_GRADE_SCALE.lumAdj, -100, 100),
      },
    };
  }
  result.toneCurve = {
    ...toneCurve,
    rgb: calibrateCurve(toneCurve.rgb),
    red: defaultAdjustments.toneCurve.red.map((point) => ({ ...point })),
    green: defaultAdjustments.toneCurve.green.map((point) => ({ ...point })),
    blue: defaultAdjustments.toneCurve.blue.map((point) => ({ ...point })),
  };
  result.toneCurveSpace = 'gamma';
  return result;
}

function fileStem(fileName?: string): string {
  if (!fileName) return 'Lightroom Preset';
  return fileName.replace(/\.(xmp|json)$/i, '') || 'Lightroom Preset';
}

function assignNumber(
  target: Partial<Adjustments>,
  key: keyof Adjustments,
  raw: string | undefined,
  convert: (value: number) => number = (value) => value,
): boolean {
  if (raw === undefined || raw.trim() === '') return false;
  const value = Number(raw);
  if (!Number.isFinite(value)) return false;
  (target as Record<string, unknown>)[key] = convert(value);
  return true;
}

/** Convert a modern Adobe Camera Raw / Lightroom `.xmp` develop preset into
 * PhotoLib's native, partial adjustment format. Unsupported profile/LUT and
 * local-mask data is deliberately ignored and reported to the caller. */
export function parseLightroomPreset(xmp: string, fileName?: string): LightroomPresetImport {
  if (!/<x:xmpmeta\b/i.test(xmp) || !/camera-raw-settings\/1\.0/i.test(xmp)) {
    throw new Error('Die Datei ist kein Lightroom/Camera-Raw-XMP-Preset.');
  }

  const attributes = attributesFromPresetDescription(xmp);
  const adjustments: Partial<Adjustments> = {};
  const handled = new Set<string>();
  const warnings: string[] = [];

  for (const [attribute, mapping] of Object.entries(SIMPLE_FIELDS)) {
    if (assignNumber(adjustments, mapping.key, attributes.get(attribute), mapping.convert)) {
      handled.add(attribute);
    }
  }

  // The Kelvin approximation is CRS_FIELDS' Temperature entry and was applied
  // by the loop above; only the warning belongs to the parser.
  if (handled.has('Temperature')) {
    warnings.push('Absoluter Lightroom-Weißabgleich wurde relativ angenähert.');
  }

  const hsl = Object.fromEntries(HSL_CHANNELS.map((channel) => [
    channel,
    { ...defaultAdjustments.hsl[channel] },
  ])) as Adjustments['hsl'];
  let hasHsl = false;
  for (const channel of HSL_CHANNELS) {
    const suffix = channel.charAt(0).toUpperCase() + channel.slice(1);
    for (const [prefix, key] of [
      ['HueAdjustment', 'hue'],
      ['SaturationAdjustment', 'saturation'],
      ['LuminanceAdjustment', 'luminance'],
    ] as const) {
      const attribute = `${prefix}${suffix}`;
      const raw = attributes.get(attribute);
      if (raw === undefined || !Number.isFinite(Number(raw))) continue;
      hsl[channel][key] = clamp(Number(raw) * HSL_SCALE, -100, 100);
      handled.add(attribute);
      hasHsl = true;
    }
  }
  if (hasHsl) adjustments.hsl = hsl;

  const colorGrading: Adjustments['colorGrading'] = {
    shadows: { ...defaultAdjustments.colorGrading.shadows },
    midtones: { ...defaultAdjustments.colorGrading.midtones },
    highlights: { ...defaultAdjustments.colorGrading.highlights },
    blending: defaultAdjustments.colorGrading.blending,
    balance: defaultAdjustments.colorGrading.balance,
  };
  let hasColorGrading = false;
  for (const [lrZone, zone] of [
    ['Shadow', 'shadows'], ['Midtone', 'midtones'], ['Highlight', 'highlights'],
  ] as const) {
    for (const [suffix, key, min, max] of [
      ['Hue', 'hue', 0, 360], ['Sat', 'saturation', 0, 100], ['Lum', 'lumAdj', -100, 100],
    ] as const) {
      const attribute = `ColorGrade${lrZone}${suffix}`;
      const raw = attributes.get(attribute);
      if (raw === undefined || !Number.isFinite(Number(raw))) continue;
      const scale = key === 'saturation' ? COLOR_GRADE_SCALE.saturation
        : key === 'lumAdj' ? COLOR_GRADE_SCALE.lumAdj : 1;
      colorGrading[zone][key] = clamp(Number(raw) * scale, min, max);
      handled.add(attribute);
      hasColorGrading = true;
    }
  }
  const gradeBalance = Number(attributes.get('ColorGradeBalance'));
  if (Number.isFinite(gradeBalance)) {
    colorGrading.balance = clamp(gradeBalance, -100, 100);
    handled.add('ColorGradeBalance');
    hasColorGrading = true;
  }
  const gradeBlending = Number(attributes.get('ColorGradeBlending'));
  if (Number.isFinite(gradeBlending)) {
    colorGrading.blending = clamp(gradeBlending, 0, 100);
    handled.add('ColorGradeBlending');
    hasColorGrading = true;
  }

  // Older Lightroom presets use Split Toning instead of Color Grading.
  if (!hasColorGrading) {
    const splitMappings = [
      ['SplitToningShadowHue', 'shadows', 'hue'],
      ['SplitToningShadowSaturation', 'shadows', 'saturation'],
      ['SplitToningHighlightHue', 'highlights', 'hue'],
      ['SplitToningHighlightSaturation', 'highlights', 'saturation'],
    ] as const;
    for (const [attribute, zone, key] of splitMappings) {
      const raw = attributes.get(attribute);
      if (raw === undefined || !Number.isFinite(Number(raw))) continue;
      colorGrading[zone][key] = Number(raw);
      handled.add(attribute);
      hasColorGrading = true;
    }
    const balance = attributes.get('SplitToningBalance');
    if (balance !== undefined && Number.isFinite(Number(balance))) {
      colorGrading.balance = clamp(Number(balance), -100, 100);
      handled.add('SplitToningBalance');
      hasColorGrading = true;
    }
  }
  if (hasColorGrading) adjustments.colorGrading = colorGrading;

  const curveXml = xmp.replace(/<crs:Look\b[\s\S]*?<\/crs:Look>/gi, '');
  const curve = cloneToneCurve();
  const parsedCurves = new Map<keyof ToneCurveAdjustment, Array<{ x: number; y: number }>>();
  for (const [property, channel] of [
    ['ToneCurvePV2012', 'rgb'],
    ['ToneCurvePV2012Red', 'red'],
    ['ToneCurvePV2012Green', 'green'],
    ['ToneCurvePV2012Blue', 'blue'],
  ] as const) {
    const points = parseCurve(curveXml, property);
    if (points) parsedCurves.set(channel, points);
  }
  const compositeCurve = parsedCurves.get('rgb');
  for (const [channel, points] of parsedCurves) {
    // Lightroom exports commonly repeat its composite curve verbatim into
    // R/G/B. Applying all four curves sequentially is the primary source of
    // the compressed PhotoLib histogram, so identical channel copies are
    // collapsed to identity here.
    if (channel !== 'rgb' && compositeCurve && curvesEqual(points, compositeCurve)) continue;
    curve[channel] = calibrateCurve(points);
  }
  if (parsedCurves.size > 0) {
    adjustments.toneCurve = curve;
    adjustments.toneCurveSpace = 'gamma';
  }

  if (/^(true|1)$/i.test(attributes.get('ConvertToGrayscale') ?? '')) {
    adjustments.bwEnabled = true;
    handled.add('ConvertToGrayscale');
    const mix = { ...defaultAdjustments.bwMix };
    for (const channel of HSL_CHANNELS) {
      const suffix = channel.charAt(0).toUpperCase() + channel.slice(1);
      const attribute = `GrayMixer${suffix}`;
      const raw = attributes.get(attribute);
      if (raw === undefined || !Number.isFinite(Number(raw))) continue;
      mix[channel] = clamp(Number(raw), -100, 100);
      handled.add(attribute);
    }
    adjustments.bwMix = mix;
  }

  const unsupported = [...attributes.keys()].filter((attribute) =>
    !handled.has(attribute) && !METADATA_ATTRIBUTES.has(attribute));
  if (/<crs:Look\b|\bcrs:CameraProfile=/i.test(xmp)) {
    warnings.push('Adobe-Profil/LUT kann nicht übernommen werden.');
  }
  if (/<crs:(?:Mask|CorrectionMasks|PaintBasedCorrections|GradientBasedCorrections)\b/i.test(xmp)) {
    warnings.push('Lokale Masken werden nicht importiert.');
  }
  if (unsupported.length > 0) {
    warnings.push(`${unsupported.length} nicht unterstützte Lightroom-Einstellung(en) wurden übersprungen.`);
  }

  if (Object.keys(adjustments).length === 0) {
    throw new Error('Das XMP enthält keine von PhotoLib unterstützten Entwicklungseinstellungen.');
  }

  return {
    name: alternateText(xmp, 'Name') ?? attributes.get('Name') ?? fileStem(fileName),
    category: alternateText(xmp, 'Group') ?? 'Lightroom Import',
    adjustments,
    warnings,
    importedFields: Object.keys(adjustments),
  };
}
