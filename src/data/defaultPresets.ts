import { defaultAdjustments, type Adjustments, type HSLChannel } from '../types';

export interface DefaultPresetDefinition {
  syncId: string;
  name: string;
  category: string;
  adjustments: Partial<Adjustments>;
}

// Older than every user action: only advance this together with new versioned
// sync IDs (photolib-default-v2-*), never just because the app was installed.
export const DEFAULT_PRESETS_STAMP = Date.UTC(2026, 0, 1);

type HslOverrides = Partial<Record<HSLChannel, Partial<Adjustments['hsl'][HSLChannel]>>>;

function hsl(overrides: HslOverrides): Adjustments['hsl'] {
  const result = Object.fromEntries(
    (Object.keys(defaultAdjustments.hsl) as HSLChannel[]).map((channel) => [
      channel,
      { ...defaultAdjustments.hsl[channel], ...(overrides[channel] ?? {}) },
    ]),
  ) as Adjustments['hsl'];
  return result;
}

function curve(
  rgb: Array<[number, number]>,
  channels: Partial<Record<'red' | 'green' | 'blue', Array<[number, number]>>> = {},
): Adjustments['toneCurve'] {
  const points = (values: Array<[number, number]>) => values.map(([x, y]) => ({ x, y }));
  return {
    rgb: points(rgb),
    luma: defaultAdjustments.toneCurve.luma.map((point) => ({ ...point })),
    red: points(channels.red ?? [[0, 0], [1, 1]]),
    green: points(channels.green ?? [[0, 0], [1, 1]]),
    blue: points(channels.blue ?? [[0, 0], [1, 1]]),
  };
}

function grading(args: {
  shadows?: [number, number];
  midtones?: [number, number];
  highlights?: [number, number];
  blending?: number;
  balance?: number;
}): Adjustments['colorGrading'] {
  const zone = (value?: [number, number]) => ({
    ...defaultAdjustments.colorGrading.shadows,
    hue: value?.[0] ?? 0,
    saturation: value?.[1] ?? 0,
  });
  return {
    shadows: zone(args.shadows),
    midtones: zone(args.midtones),
    highlights: zone(args.highlights),
    blending: args.blending ?? 50,
    balance: args.balance ?? 0,
  };
}

function preset(
  id: string,
  name: string,
  category: string,
  adjustments: Partial<Adjustments>,
): DefaultPresetDefinition {
  return {
    syncId: `photolib-default-v1-${id}`,
    name,
    category,
    adjustments: adjustments.toneCurve
      ? { ...adjustments, toneCurveSpace: adjustments.toneCurveSpace ?? 'gamma' }
      : adjustments,
  };
}

/** Original PhotoLib looks. Film names describe an aesthetic direction, not
 * measured ICC/DCP emulations of a particular manufacturer's stock/profile. */
export const DEFAULT_PRESETS: DefaultPresetDefinition[] = [
  preset('mood-moody-matte', 'Moody Matte', '01 · Stimmung', {
    exposure: -8, contrast: 18, highlights: -38, shadows: -8, whites: -12, blacks: -8,
    clarity: 8, dehaze: 7, vibrance: -10, saturation: -5,
    toneCurve: curve([[0, 0.055], [0.22, 0.17], [0.52, 0.49], [0.78, 0.8], [1, 0.96]]),
    colorGrading: grading({ shadows: [205, 18], highlights: [38, 9], balance: -22 }),
    vignette: -14, vignetteFeather: 72,
  }),
  preset('mood-sunset-glow', 'Sunset Glow', '01 · Stimmung', {
    temperature: 18, tint: 5, contrast: 8, highlights: -28, shadows: 16, whites: 12,
    vibrance: 22, saturation: 5, dehaze: 4,
    hsl: hsl({ orange: { saturation: 18, luminance: 8 }, yellow: { hue: -12, saturation: 10 }, blue: { saturation: -12, luminance: -8 } }),
    colorGrading: grading({ shadows: [225, 7], midtones: [32, 9], highlights: [42, 24], balance: 24 }),
  }),
  preset('mood-happy-bright', 'Happy & Bright', '01 · Stimmung', {
    exposure: 12, contrast: -4, highlights: -22, shadows: 30, whites: 17, blacks: 7,
    temperature: 4, vibrance: 24, saturation: 6, clarity: 3,
    hsl: hsl({ orange: { luminance: 8 }, yellow: { saturation: 10, luminance: 8 }, green: { saturation: 6, luminance: 6 }, blue: { saturation: 9, luminance: 8 } }),
  }),
  preset('mood-cinematic-night', 'Cinematic Night', '01 · Stimmung', {
    exposure: -10, contrast: 23, highlights: -42, shadows: 8, whites: -8, blacks: -18,
    temperature: -7, dehaze: 12, vibrance: 8,
    hsl: hsl({ orange: { saturation: 8, luminance: 5 }, yellow: { saturation: -25 }, green: { hue: 22, saturation: -30 }, aqua: { hue: -18, saturation: 15 }, blue: { hue: -10, saturation: 18, luminance: -15 } }),
    colorGrading: grading({ shadows: [205, 27], midtones: [195, 7], highlights: [32, 17], blending: 68, balance: -28 }),
    vignette: -20, vignetteFeather: 68,
  }),

  preset('occasion-wedding-airy', 'Wedding · Airy', '02 · Anlässe & People', {
    exposure: 15, contrast: -8, highlights: -32, shadows: 34, whites: 12, blacks: 10,
    temperature: 7, tint: 3, texture: -7, clarity: -5, vibrance: 9, saturation: -4,
    hsl: hsl({ orange: { saturation: -5, luminance: 13 }, yellow: { saturation: -14, luminance: 10 }, green: { saturation: -22, luminance: 12 }, blue: { saturation: -15, luminance: 15 } }),
    colorGrading: grading({ highlights: [42, 9], balance: 30 }),
  }),
  preset('occasion-wedding-timeless', 'Wedding · Timeless', '02 · Anlässe & People', {
    contrast: 8, highlights: -28, shadows: 22, whites: 7, blacks: -4,
    temperature: 6, tint: 2, clarity: 2, vibrance: 10, saturation: -2,
    hsl: hsl({ orange: { saturation: -4, luminance: 9 }, yellow: { saturation: -15 }, green: { saturation: -18 }, blue: { saturation: -8 } }),
    colorGrading: grading({ shadows: [218, 5], highlights: [40, 10], balance: 16 }),
  }),
  preset('people-natural-skin', 'People · Natural Skin', '02 · Anlässe & People', {
    highlights: -20, shadows: 18, whites: 5, texture: -5, clarity: -4, vibrance: 8,
    hsl: hsl({ red: { saturation: -5, luminance: 3 }, orange: { hue: -2, saturation: -6, luminance: 12 }, yellow: { saturation: -12 } }),
  }),
  preset('people-editorial', 'People · Editorial', '02 · Anlässe & People', {
    contrast: 17, highlights: -24, shadows: 8, whites: 8, blacks: -12,
    texture: 7, clarity: 5, saturation: -9,
    hsl: hsl({ orange: { saturation: -10, luminance: 8 }, yellow: { saturation: -28 }, green: { saturation: -35 }, blue: { saturation: -18, luminance: -8 } }),
    colorGrading: grading({ shadows: [215, 10], highlights: [34, 8], balance: -10 }),
    vignette: -10, vignetteFeather: 75,
  }),

  preset('landscape-natural', 'Landscape · Natural', '03 · Landschaft', {
    contrast: 10, highlights: -32, shadows: 24, whites: 12, blacks: -8,
    texture: 12, clarity: 9, dehaze: 7, vibrance: 14,
    hsl: hsl({ green: { hue: -5, saturation: 5, luminance: 3 }, aqua: { saturation: 6 }, blue: { saturation: 10, luminance: -7 } }),
  }),
  preset('landscape-dramatic', 'Landscape · Dramatic', '03 · Landschaft', {
    contrast: 24, highlights: -55, shadows: 18, whites: 18, blacks: -20,
    texture: 20, clarity: 17, dehaze: 18, vibrance: 15,
    toneCurve: curve([[0, 0], [0.2, 0.14], [0.5, 0.51], [0.78, 0.86], [1, 1]]),
    hsl: hsl({ yellow: { saturation: -8 }, green: { saturation: -12, luminance: -7 }, blue: { saturation: 18, luminance: -17 } }),
    vignette: -12, vignetteFeather: 76,
  }),
  preset('landscape-forest', 'Forest · Deep Green', '03 · Landschaft', {
    exposure: -5, contrast: 16, highlights: -38, shadows: 16, blacks: -14,
    temperature: -3, texture: 11, clarity: 10, dehaze: 12, vibrance: -2,
    hsl: hsl({ yellow: { hue: 20, saturation: -18 }, green: { hue: 15, saturation: -8, luminance: -18 }, aqua: { hue: 15, saturation: -15 }, blue: { saturation: -25 } }),
    colorGrading: grading({ shadows: [170, 15], highlights: [46, 7], balance: -25 }),
    vignette: -16, vignetteFeather: 70,
  }),
  preset('landscape-coastal', 'Coastal · Airy Blue', '03 · Landschaft', {
    exposure: 9, contrast: -5, highlights: -25, shadows: 28, whites: 12, blacks: 8,
    temperature: -5, clarity: 4, dehaze: 3, vibrance: 10, saturation: -4,
    hsl: hsl({ yellow: { saturation: -20 }, green: { saturation: -25 }, aqua: { hue: -12, saturation: 10, luminance: 13 }, blue: { hue: -8, saturation: 7, luminance: 18 } }),
    colorGrading: grading({ shadows: [200, 7], highlights: [44, 6], balance: 12 }),
  }),

  preset('color-teal-orange', 'Teal & Orange', '04 · Farbe', {
    contrast: 14, highlights: -28, shadows: 20, whites: 8, blacks: -8, vibrance: 10,
    hsl: hsl({ orange: { saturation: 14, luminance: 8 }, yellow: { hue: -18, saturation: -12 }, green: { hue: 45, saturation: -35 }, aqua: { hue: -25, saturation: 12 }, blue: { hue: -18, saturation: 5, luminance: -10 } }),
    colorGrading: grading({ shadows: [202, 24], midtones: [28, 6], highlights: [36, 18], blending: 72, balance: -20 }),
  }),
  preset('color-warm-earth', 'Warm Earth', '04 · Farbe', {
    temperature: 12, contrast: 10, highlights: -24, shadows: 13, saturation: -5, vibrance: 10,
    hsl: hsl({ red: { hue: 5, saturation: -5 }, orange: { hue: -5, saturation: 10, luminance: 5 }, yellow: { hue: -20, saturation: -8 }, green: { hue: 30, saturation: -38 }, aqua: { saturation: -35 }, blue: { saturation: -32 } }),
    colorGrading: grading({ shadows: [28, 10], highlights: [45, 13], balance: 15 }),
  }),
  preset('color-cool-minimal', 'Cool Minimal', '04 · Farbe', {
    temperature: -12, tint: -2, contrast: -6, highlights: -18, shadows: 24, whites: 8, blacks: 7,
    clarity: -2, saturation: -18, vibrance: 5,
    hsl: hsl({ yellow: { saturation: -30 }, green: { saturation: -35 }, aqua: { hue: -8, luminance: 10 }, blue: { saturation: -8, luminance: 13 } }),
    colorGrading: grading({ shadows: [210, 10], highlights: [195, 5], balance: -5 }),
  }),
  preset('color-pastel', 'Soft Pastel', '04 · Farbe', {
    exposure: 8, contrast: -16, highlights: -20, shadows: 28, whites: 5, blacks: 13,
    texture: -5, clarity: -7, vibrance: 8, saturation: -8,
    toneCurve: curve([[0, 0.045], [0.25, 0.28], [0.52, 0.55], [0.8, 0.82], [1, 0.97]]),
    hsl: hsl({ red: { saturation: -8, luminance: 7 }, orange: { saturation: -10, luminance: 10 }, yellow: { saturation: -18, luminance: 12 }, green: { saturation: -20, luminance: 10 }, blue: { saturation: -13, luminance: 12 } }),
  }),

  preset('film-golden-200', 'Golden 200 · Film Look', '05 · Film-Looks', {
    exposure: 5, contrast: -10, highlights: -42, shadows: 25, whites: -12, blacks: 12,
    temperature: 9, vibrance: 8, saturation: 3,
    hsl: hsl({ red: { hue: 5, saturation: 8 }, orange: { hue: -3, saturation: 13, luminance: 10 }, yellow: { hue: -12, saturation: 16, luminance: 7 }, green: { hue: 18, saturation: -18, luminance: -5 }, aqua: { saturation: -10 }, blue: { hue: -8, saturation: -16, luminance: -8 }, purple: { saturation: -22 }, magenta: { saturation: -22 } }),
    colorGrading: grading({ shadows: [208, 14], highlights: [48, 14], balance: -20 }),
    grain: 27, grainSize: 25,
  }),
  preset('film-classic-muted', 'Classic Muted · Fuji Look', '05 · Film-Looks', {
    contrast: 7, highlights: -32, shadows: 18, whites: -5, blacks: 8,
    saturation: -16, vibrance: 5, clarity: 3,
    hsl: hsl({ red: { hue: 6, saturation: -8 }, orange: { saturation: -10, luminance: 6 }, yellow: { hue: -12, saturation: -28 }, green: { hue: 16, saturation: -32 }, aqua: { hue: -12, saturation: -20 }, blue: { hue: -10, saturation: -14, luminance: -10 } }),
    colorGrading: grading({ shadows: [205, 9], highlights: [42, 7], balance: -15 }),
    grain: 18, grainSize: 22,
  }),
  preset('film-eterna-cinema', 'Eterna Cinema · Fuji Look', '05 · Film-Looks', {
    contrast: -12, highlights: -40, shadows: 26, whites: -12, blacks: 10,
    saturation: -20, vibrance: 2, clarity: -2,
    toneCurve: curve([[0, 0.03], [0.25, 0.25], [0.5, 0.51], [0.75, 0.76], [1, 0.96]]),
    hsl: hsl({ orange: { saturation: -10, luminance: 5 }, yellow: { saturation: -25 }, green: { hue: 18, saturation: -35 }, aqua: { hue: -10, saturation: -18 }, blue: { saturation: -20, luminance: -5 } }),
    colorGrading: grading({ shadows: [195, 12], highlights: [38, 7], blending: 70, balance: -12 }),
    grain: 12, grainSize: 20,
  }),
  preset('film-vintage-fade', 'Vintage Fade', '05 · Film-Looks', {
    contrast: -8, highlights: -24, shadows: 20, whites: -16, blacks: 16,
    temperature: 8, tint: 3, clarity: -5, saturation: -13,
    toneCurve: curve([[0, 0.09], [0.22, 0.24], [0.52, 0.53], [0.8, 0.78], [1, 0.92]], {
      red: [[0, 0.03], [0.5, 0.53], [1, 1]],
      blue: [[0, 0.08], [0.5, 0.48], [1, 0.94]],
    }),
    hsl: hsl({ yellow: { hue: -12, saturation: -12 }, green: { hue: 18, saturation: -32 }, blue: { saturation: -22 } }),
    grain: 32, grainSize: 30, vignette: -8, vignetteFeather: 82,
  }),
  preset('film-silver-bw', 'Silver Grain · B&W', '05 · Film-Looks', {
    bwEnabled: true,
    bwMix: { red: 18, orange: 26, yellow: 12, green: -4, aqua: -10, blue: -22, purple: -8, magenta: 8 },
    contrast: 20, highlights: -30, shadows: 17, whites: 12, blacks: -16,
    texture: 8, clarity: 10,
    toneCurve: curve([[0, 0.02], [0.22, 0.16], [0.5, 0.5], [0.78, 0.85], [1, 0.98]]),
    grain: 35, grainSize: 28, vignette: -12, vignetteFeather: 74,
  }),
];
