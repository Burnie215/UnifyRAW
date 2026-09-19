import type { NodeKindSpec, JsonSchema } from './types';
import type { NodeRegistry } from './NodeRegistry';
import { LensCorrectionPass } from '../passes/LensCorrectionPass';
import {
  TonePass, WhiteBalancePass, ToneCurvePass, HSLPass, HSLDetailPass, BWPass,
  ColorGradingPass, ClarityPass, TexturePass, DenoisePass, SharpenPass,
  EffectsPass, LevelsPass, TransformPass, CropPass, WhiteBalanceRawPass, ColorMatrixPass,
} from '../passes';
import { isFullCropRect, normalizeCropRect } from '../Crop';
import {
  areToneCurvesIdentity,
  buildToneCurveLut,
} from '../toneCurve';

/**
 * NodeKindSpec wrappers around the passes of the classic pipeline (deleted,
 * tag attic/pre-deadcode-2026-09). Each one ports its shader + uniform-binding
 * logic from the flat `Adjustments` model into a self-contained spec with
 * explicit params + per-pass identity check.
 *
 * Phase 0/1: inputSpace/outputSpace stay 'gamma' so the new pipeline produces
 * the same pixels as today. Phase 2 flips the math-bearing kinds to 'linear'
 * as a hard-cut behavioural change.
 *
 * Shaders are IMPORTED from src/engine/passes/ (single source of truth) —
 * bit-identity with the legacy pipeline is structural, not test-enforced.
 * Exceptions: customHsl (built programmatically) and outputColorSpace
 * (intentionally diverged: the graph engine drops the u_ocs_enabled gate,
 * convert placement decides activity instead).
 */

// ─── Helpers ──────────────────────────────────────────────────────

function uniformLoc(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation | null {
  // ProgramCache memoises lookups internally; cheap per-call cost.
  return gl.getUniformLocation(program, name);
}

// Adjustment kinds are space-agnostic — the same shader runs whether the
// segment FBO holds gamma-encoded sRGB (JPEG path) or linear-light (RAW
// path through HDR pre-passes). Marking ports as 'either' lets the
// compiler skip the linear↔gamma convert insertion that would otherwise
// stomp on the bit-exact behaviour against the classic pipeline (deleted,
// tag attic/pre-deadcode-2026-09).
const colorIn = { id: 'in', type: 'color', space: 'either' } as const;
const colorOut = { id: 'out', type: 'color', space: 'either' } as const;

const numberPm1: JsonSchema = { type: 'number', minimum: -1, maximum: 1, default: 0 };
// The BW mix is the one adjustment whose params stay on the editor scale:
// BWPass divides by 100 in the shader and the projection reads it back
// unscaled. Bounds say so, instead of leaving the form to guess (F018).
const numberPm100: JsonSchema = { type: 'number', minimum: -100, maximum: 100, default: 0 };

// ─── Kind: Tone ───────────────────────────────────────────────────

export const KIND_TONE = 'tone';

export interface ToneParams {
  exposure: number; contrast: number; highlights: number;
  shadows: number; whites: number; blacks: number;
}

const toneShader = TonePass.fragmentShader;

const toneKind: NodeKindSpec<ToneParams> = {
  kind: KIND_TONE,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: {
      exposure: numberPm1, contrast: numberPm1, highlights: numberPm1,
      shadows: numberPm1, whites: numberPm1, blacks: numberPm1,
    },
    required: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
  },
  fragmentShader: toneShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: (p) => p.exposure === 0 && p.contrast === 0 && p.highlights === 0 &&
                     p.shadows === 0 && p.whites === 0 && p.blacks === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as ToneParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_exposure'), p.exposure);
    gl.uniform1f(uniformLoc(gl, program, 'u_contrast'), p.contrast);
    gl.uniform1f(uniformLoc(gl, program, 'u_highlights'), p.highlights);
    gl.uniform1f(uniformLoc(gl, program, 'u_shadows'), p.shadows);
    gl.uniform1f(uniformLoc(gl, program, 'u_whites'), p.whites);
    gl.uniform1f(uniformLoc(gl, program, 'u_blacks'), p.blacks);
  },
};

// ─── Kind: WhiteBalance ───────────────────────────────────────────

export const KIND_WHITE_BALANCE = 'whiteBalance';

export interface WhiteBalanceParams {
  temperature: number; tint: number;
}

const whiteBalanceShader = WhiteBalancePass.fragmentShader;

const whiteBalanceKind: NodeKindSpec<WhiteBalanceParams> = {
  kind: KIND_WHITE_BALANCE,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: { temperature: numberPm1, tint: numberPm1 },
    required: ['temperature', 'tint'],
  },
  fragmentShader: whiteBalanceShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: (p) => p.temperature === 0 && p.tint === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as WhiteBalanceParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_temperature'), p.temperature);
    gl.uniform1f(uniformLoc(gl, program, 'u_tint'), p.tint);
  },
};

// ─── Kind: HSL (Vibrance + Saturation, ported from HSLPass) ────────

export const KIND_HSL = 'hsl';

export interface HslParams {
  vibrance: number; saturation: number;
}

const hslShader = HSLPass.fragmentShader;

const hslKind: NodeKindSpec<HslParams> = {
  kind: KIND_HSL,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: { vibrance: numberPm1, saturation: numberPm1 },
    required: ['vibrance', 'saturation'],
  },
  fragmentShader: hslShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: (p) => p.vibrance === 0 && p.saturation === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as HslParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_vibrance'), p.vibrance);
    gl.uniform1f(uniformLoc(gl, program, 'u_saturation'), p.saturation);
  },
};

// ─── Kind: Levels (multi-channel) ─────────────────────────────────

export const KIND_LEVELS = 'levels';

export interface LevelsChannel {
  inBlack: number;   // 0..1
  inWhite: number;   // 0..1
  gamma: number;     // 0.01..10
  outBlack: number;  // 0..1
  outWhite: number;  // 0..1
}

export interface LevelsParams {
  rgb: LevelsChannel;
  red: LevelsChannel;
  green: LevelsChannel;
  blue: LevelsChannel;
}

const defaultLevelsChannel: LevelsChannel = {
  inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1,
};

function isLevelsIdentity(c: LevelsChannel): boolean {
  return c.inBlack < 0.001 && Math.abs(c.inWhite - 1) < 0.001 &&
         Math.abs(c.gamma - 1) < 0.001 &&
         c.outBlack < 0.001 && Math.abs(c.outWhite - 1) < 0.001;
}

const levelsChannelSchema: JsonSchema = {
  type: 'object',
  properties: {
    inBlack: { type: 'number', minimum: 0, maximum: 1, default: 0 },
    inWhite: { type: 'number', minimum: 0, maximum: 1, default: 1 },
    gamma: { type: 'number', minimum: 0.01, maximum: 10, default: 1 },
    outBlack: { type: 'number', minimum: 0, maximum: 1, default: 0 },
    outWhite: { type: 'number', minimum: 0, maximum: 1, default: 1 },
  },
  required: ['inBlack', 'inWhite', 'gamma', 'outBlack', 'outWhite'],
};

const levelsShader = LevelsPass.fragmentShader;

const levelsKind: NodeKindSpec<LevelsParams> = {
  kind: KIND_LEVELS,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: {
      rgb: levelsChannelSchema,
      red: levelsChannelSchema,
      green: levelsChannelSchema,
      blue: levelsChannelSchema,
    },
    required: ['rgb', 'red', 'green', 'blue'],
  },
  fragmentShader: levelsShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: (p) =>
    isLevelsIdentity(p.rgb) && isLevelsIdentity(p.red) &&
    isLevelsIdentity(p.green) && isLevelsIdentity(p.blue),
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as LevelsParams;
    const bindChannel = (ch: 'rgb' | 'red' | 'green' | 'blue', vals: LevelsChannel) => {
      gl.uniform1f(uniformLoc(gl, program, `u_lev_${ch}_inBlack`), vals.inBlack);
      gl.uniform1f(uniformLoc(gl, program, `u_lev_${ch}_inWhite`), vals.inWhite);
      gl.uniform1f(uniformLoc(gl, program, `u_lev_${ch}_gamma`), vals.gamma);
      gl.uniform1f(uniformLoc(gl, program, `u_lev_${ch}_outBlack`), vals.outBlack);
      gl.uniform1f(uniformLoc(gl, program, `u_lev_${ch}_outWhite`), vals.outWhite);
    };
    bindChannel('rgb', p.rgb);
    bindChannel('red', p.red);
    bindChannel('green', p.green);
    bindChannel('blue', p.blue);
  },
};

// ─── Kind: Black & White ──────────────────────────────────────────

export const KIND_BW = 'bw';

export interface BwMix {
  red: number; orange: number; yellow: number; green: number;
  aqua: number; blue: number; purple: number; magenta: number;
}

export interface BwParams {
  enabled: boolean;
  mix: BwMix;
}

const defaultBwMix: BwMix = { red: 0, orange: 0, yellow: 0, green: 0, aqua: 0, blue: 0, purple: 0, magenta: 0 };

const bwShader = BWPass.fragmentShader;

const bwMixSchema: JsonSchema = {
  type: 'object',
  properties: {
    red: numberPm100, orange: numberPm100, yellow: numberPm100, green: numberPm100,
    aqua: numberPm100, blue: numberPm100, purple: numberPm100, magenta: numberPm100,
  },
  required: ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'],
};

const bwKind: NodeKindSpec<BwParams> = {
  kind: KIND_BW,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: false },
      mix: bwMixSchema,
    },
    required: ['enabled', 'mix'],
  },
  fragmentShader: bwShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: (p) => !p.enabled,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as BwParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_bw_enabled'), p.enabled ? 1 : 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_bw_red'), p.mix.red);
    gl.uniform1f(uniformLoc(gl, program, 'u_bw_orange'), p.mix.orange);
    gl.uniform1f(uniformLoc(gl, program, 'u_bw_yellow'), p.mix.yellow);
    gl.uniform1f(uniformLoc(gl, program, 'u_bw_green'), p.mix.green);
    gl.uniform1f(uniformLoc(gl, program, 'u_bw_aqua'), p.mix.aqua);
    gl.uniform1f(uniformLoc(gl, program, 'u_bw_blue'), p.mix.blue);
    gl.uniform1f(uniformLoc(gl, program, 'u_bw_purple'), p.mix.purple);
    gl.uniform1f(uniformLoc(gl, program, 'u_bw_magenta'), p.mix.magenta);
  },
};

// ─── Kind: Sharpen (multi-pixel-read) ─────────────────────────────

export const KIND_SHARPEN = 'sharpen';

export interface SharpenParams {
  sharpness: number; // 0..1.5 (editor range 0..150)
}

const sharpenShader = SharpenPass.fragmentShader;

const sharpenKind: NodeKindSpec<SharpenParams> = {
  kind: KIND_SHARPEN,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: { sharpness: { type: 'number', minimum: 0, maximum: 1.5, default: 0 } },
    required: ['sharpness'],
  },
  fragmentShader: sharpenShader,
  inputSpace: 'gamma',
  outputSpace: 'gamma',
  requiresFloat: false,
  samplesNeighbors: true, // 3x3 Laplacian neighbour reads
  isIdentity: (p) => p.sharpness === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    gl.uniform1f(uniformLoc(gl, program, 'u_sharpness'), (params as SharpenParams).sharpness);
    // u_resolution is auto-bound by the executor.
  },
};

// ─── Kind: Transform (geometric, space-agnostic) ──────────────────

export const KIND_TRANSFORM = 'transform';

export interface TransformParams {
  rotation: number;     // radians
  flipH: boolean;
  flipV: boolean;
  perspectiveH: number; // -1..1
  perspectiveV: number; // -1..1
  distortion: number;   // -1..1
}

const transformShader = TransformPass.fragmentShader;

const transformKind: NodeKindSpec<TransformParams> = {
  kind: KIND_TRANSFORM,
  category: 'adjustment',
  userPlaceable: true,
  // Transform is purely geometric — space-agnostic. Compiler picks the
  // surrounding chain's space via 'either' resolution.
  inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
  outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: {
      rotation: { type: 'number', minimum: -Math.PI, maximum: Math.PI, default: 0 },
      flipH: { type: 'boolean', default: false },
      flipV: { type: 'boolean', default: false },
      perspectiveH: numberPm1,
      perspectiveV: numberPm1,
      distortion: numberPm1,
    },
    required: ['rotation', 'flipH', 'flipV', 'perspectiveH', 'perspectiveV', 'distortion'],
  },
  fragmentShader: transformShader,
  inputSpace: 'either',
  outputSpace: 'either',
  preferredSpace: 'gamma',
  requiresFloat: false,
  samplesNeighbors: true, // arbitrary uv lookups
  isIdentity: (p) => p.rotation === 0 && !p.flipH && !p.flipV &&
                     p.perspectiveH === 0 && p.perspectiveV === 0 && p.distortion === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as TransformParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_rotation'), p.rotation);
    gl.uniform1f(uniformLoc(gl, program, 'u_flipH'), p.flipH ? -1 : 1);
    gl.uniform1f(uniformLoc(gl, program, 'u_flipV'), p.flipV ? -1 : 1);
    gl.uniform1f(uniformLoc(gl, program, 'u_perspH'), p.perspectiveH);
    gl.uniform1f(uniformLoc(gl, program, 'u_perspV'), p.perspectiveV);
    gl.uniform1f(uniformLoc(gl, program, 'u_distortion'), p.distortion);
  },
};

// ─── Kind: Crop (terminal, space-agnostic) ────────────────────────

export const KIND_CROP = 'crop';

export interface CropParams {
  x: number;
  y: number;
  width: number;
  height: number;
}

const cropKind: NodeKindSpec<CropParams> = {
  kind: KIND_CROP,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: {
      x: { type: 'number', minimum: 0, maximum: 1, default: 0 },
      y: { type: 'number', minimum: 0, maximum: 1, default: 0 },
      width: { type: 'number', minimum: 0.001, maximum: 1, default: 1 },
      height: { type: 'number', minimum: 0.001, maximum: 1, default: 1 },
    },
    required: ['x', 'y', 'width', 'height'],
  },
  fragmentShader: CropPass.fragmentShader,
  inputSpace: 'either',
  outputSpace: 'either',
  preferredSpace: 'gamma',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: (params) => isFullCropRect(params),
  isAsync: false,
  outputGeometry: (inputGeometries, params) => {
    const input = inputGeometries[0] ?? { width: 1, height: 1, pixelRatio: 1 };
    const crop = normalizeCropRect(params);
    return {
      width: Math.max(1, Math.round(input.width * crop.width)),
      height: Math.max(1, Math.round(input.height * crop.height)),
      pixelRatio: input.pixelRatio,
    };
  },
  bindUniforms: (gl, program, params) => {
    const crop = normalizeCropRect(params as CropParams);
    gl.uniform2f(uniformLoc(gl, program, 'u_cropOrigin'), crop.x, crop.y);
    gl.uniform2f(uniformLoc(gl, program, 'u_cropSize'), crop.width, crop.height);
  },
};

// ─── Kind: ToneCurve (LUT via derivedTextures) ─────────────────────

export const KIND_TONE_CURVE = 'toneCurve';

export interface CurvePoint { x: number; y: number; }

export interface ToneCurveParams {
  rgb: CurvePoint[];
  luma: CurvePoint[];
  red: CurvePoint[];
  green: CurvePoint[];
  blue: CurvePoint[];
}

export const IDENTITY_CURVE: CurvePoint[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];

const toneCurveShader = ToneCurvePass.fragmentShader;

const curveArraySchema: JsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      x: { type: 'number', minimum: 0, maximum: 1 },
      y: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['x', 'y'],
  },
  minItems: 2,
};

const toneCurveKind: NodeKindSpec<ToneCurveParams> = {
  kind: KIND_TONE_CURVE,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: {
      rgb: curveArraySchema, luma: curveArraySchema,
      red: curveArraySchema, green: curveArraySchema, blue: curveArraySchema,
    },
    required: ['rgb', 'luma', 'red', 'green', 'blue'],
  },
  fragmentShader: toneCurveShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: (p) => areToneCurvesIdentity(p),
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as ToneCurveParams;
    const anyActive = !areToneCurvesIdentity(p);
    gl.uniform1f(uniformLoc(gl, program, 'u_curveEnabled'), anyActive ? 1 : 0);
  },
  derivedTextures: (params) => [{
    name: 'u_curveLut',
    data: { width: 256, height: 1, pixels: buildToneCurveLut(params as ToneCurveParams) },
  }],
};

// ─── Kind: Clarity ─────────────────────────────────────────────────

export const KIND_CLARITY = 'clarity';

export interface ClarityParams {
  clarity: number; // -1..1
  dehaze: number;  // -1..1
}

const clarityShader = ClarityPass.fragmentShader;

const clarityKind: NodeKindSpec<ClarityParams> = {
  kind: KIND_CLARITY,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: { clarity: numberPm1, dehaze: numberPm1 },
    required: ['clarity', 'dehaze'],
  },
  fragmentShader: clarityShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: true, // 5x5 box blur
  isIdentity: (p) => p.clarity === 0 && p.dehaze === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as ClarityParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_clarity'), p.clarity);
    gl.uniform1f(uniformLoc(gl, program, 'u_dehaze'), p.dehaze);
  },
};

// ─── Kind: Texture (bandpass on medium frequencies) ────────────────

export const KIND_TEXTURE = 'texture';

export interface TextureParams { amount: number; /* -1..1 */ }

const textureShader = TexturePass.fragmentShader;

const textureKind: NodeKindSpec<TextureParams> = {
  kind: KIND_TEXTURE,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: { amount: numberPm1 },
    required: ['amount'],
  },
  fragmentShader: textureShader,
  inputSpace: 'gamma',
  outputSpace: 'gamma',
  requiresFloat: false,
  samplesNeighbors: true,
  isIdentity: (p) => p.amount === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    gl.uniform1f(uniformLoc(gl, program, 'u_texture_amount'), (params as TextureParams).amount);
  },
};

// ─── Kind: Denoise (Y/CbCr bilateral, ported from DenoisePass) ─────

export const KIND_DENOISE = 'denoise';

export interface DenoiseParams {
  luma: number;   // 0..1
  chroma: number; // 0..1
  detail: number; // 0..1
}

const denoiseShader = DenoisePass.fragmentShader;

const number01: JsonSchema = { type: 'number', minimum: 0, maximum: 1, default: 0 };

const denoiseKind: NodeKindSpec<DenoiseParams> = {
  kind: KIND_DENOISE,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: { luma: number01, chroma: number01, detail: number01 },
    required: ['luma', 'chroma', 'detail'],
  },
  fragmentShader: denoiseShader,
  inputSpace: 'gamma',
  outputSpace: 'gamma',
  requiresFloat: false,
  samplesNeighbors: true,
  isIdentity: (p) => p.luma === 0 && p.chroma === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as DenoiseParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_denoise_luma'), p.luma);
    gl.uniform1f(uniformLoc(gl, program, 'u_denoise_chroma'), p.chroma);
    gl.uniform1f(uniformLoc(gl, program, 'u_denoise_detail'), p.detail);
  },
};

// ─── Kind: Effects (vignette + grain + noise-reduction) ────────────

export const KIND_EFFECTS = 'effects';

export interface EffectsParams {
  vignette: number;        // -1..1
  vignetteFeather: number; // 0..1
  grain: number;           // 0..1
  grainSize: number;       // 1..N (pixels)
  noiseReduction: number;  // 0..1
}

const effectsShader = EffectsPass.fragmentShader;

const effectsKind: NodeKindSpec<EffectsParams> = {
  kind: KIND_EFFECTS,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: {
      vignette: numberPm1,
      vignetteFeather: number01,
      grain: number01,
      grainSize: { type: 'number', minimum: 1, maximum: 100, multipleOf: 1, default: 1 },
      noiseReduction: number01,
    },
    required: ['vignette', 'vignetteFeather', 'grain', 'grainSize', 'noiseReduction'],
  },
  fragmentShader: effectsShader,
  inputSpace: 'gamma',
  outputSpace: 'gamma',
  requiresFloat: false,
  samplesNeighbors: true, // noise-reduction blur reads neighbours
  isIdentity: (p) => p.vignette === 0 && p.grain === 0 && p.noiseReduction === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as EffectsParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_vignette'), p.vignette);
    gl.uniform1f(uniformLoc(gl, program, 'u_vignetteFeather'), p.vignetteFeather);
    gl.uniform1f(uniformLoc(gl, program, 'u_grain'), p.grain);
    gl.uniform1f(uniformLoc(gl, program, 'u_grainSize'), p.grainSize);
    gl.uniform1f(uniformLoc(gl, program, 'u_noiseReduction'), p.noiseReduction);
  },
};

// ─── Kind: ColorGrading (3 zones × HSL + balance/blending) ─────────

export const KIND_COLOR_GRADING = 'colorGrading';

export interface ColorGradingZone {
  hue: number;        // 0..360
  saturation: number; // 0..100
  satAdj: number;     // -1..1
  lumAdj: number;     // -1..1
}

export interface ColorGradingParams {
  shadows: ColorGradingZone;
  midtones: ColorGradingZone;
  highlights: ColorGradingZone;
  balance: number;    // -100..100
  blending: number;   // 0..100
}

export const IDENTITY_GRADING_ZONE: ColorGradingZone = {
  hue: 0, saturation: 0, satAdj: 0, lumAdj: 0,
};

const colorGradingShader = ColorGradingPass.fragmentShader;

const colorGradingZoneSchema: JsonSchema = {
  type: 'object',
  properties: {
    hue: { type: 'number', minimum: 0, maximum: 360, default: 0 },
    saturation: { type: 'number', minimum: 0, maximum: 100, default: 0 },
    satAdj: numberPm1,
    lumAdj: numberPm1,
  },
  required: ['hue', 'saturation', 'satAdj', 'lumAdj'],
};

function isGradingZoneIdentity(z: ColorGradingZone): boolean {
  return z.saturation < 0.001 && z.satAdj === 0 && z.lumAdj === 0;
}

const colorGradingKind: NodeKindSpec<ColorGradingParams> = {
  kind: KIND_COLOR_GRADING,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: {
      shadows: colorGradingZoneSchema,
      midtones: colorGradingZoneSchema,
      highlights: colorGradingZoneSchema,
      balance: { type: 'number', minimum: -100, maximum: 100, default: 0 },
      blending: { type: 'number', minimum: 0, maximum: 100, default: 50 },
    },
    required: ['shadows', 'midtones', 'highlights', 'balance', 'blending'],
  },
  fragmentShader: colorGradingShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: (p) =>
    isGradingZoneIdentity(p.shadows) &&
    isGradingZoneIdentity(p.midtones) &&
    isGradingZoneIdentity(p.highlights),
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as ColorGradingParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_shadow_h'), p.shadows.hue);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_shadow_s'), p.shadows.saturation);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_shadow_satAdj'), p.shadows.satAdj);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_shadow_lumAdj'), p.shadows.lumAdj);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_mid_h'), p.midtones.hue);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_mid_s'), p.midtones.saturation);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_mid_satAdj'), p.midtones.satAdj);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_mid_lumAdj'), p.midtones.lumAdj);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_high_h'), p.highlights.hue);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_high_s'), p.highlights.saturation);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_high_satAdj'), p.highlights.satAdj);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_high_lumAdj'), p.highlights.lumAdj);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_balance'), p.balance);
    gl.uniform1f(uniformLoc(gl, program, 'u_cg_blending'), p.blending);
  },
};

// ─── Kind: HSLDetail (8-channel per-hue HSL + view/skin extras) ────

export const KIND_HSL_DETAIL = 'hslDetail';

const HSL_CHANNELS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
type HslChannelName = typeof HSL_CHANNELS[number];

export interface HslChannel {
  hue: number;        // -100..100
  saturation: number; // -100..100
  luminance: number;  // -100..100
}

export type HslChannels = { [K in HslChannelName]: HslChannel };

export interface HslDetailViewSelected {
  hue: number;         // 0..360
  halfWidth: number;   // degrees
  satMin: number;      // 0..1
  satMax: number;      // 0..1
}

export interface HslDetailSkinTone {
  refHue: number;      // degrees, 0..360
  refSat: number;      // 0..100
  refLum: number;      // 0..100
  uniHue: number;      // 0..1
  uniSat: number;      // 0..1
  uniLum: number;      // 0..1
  halfWidth: number;   // degrees
}

export interface HslDetailParams {
  channels: HslChannels;
  /** Transient range preview; absent → uniforms set to inactive defaults. */
  viewSelected?: HslDetailViewSelected;
  /** Persisted skin-tone uniformity derived by the default graph builder. */
  skinTone?: HslDetailSkinTone;
}

const IDENTITY_HSL_CHANNEL: HslChannel = { hue: 0, saturation: 0, luminance: 0 };
export const IDENTITY_HSL_CHANNELS: HslChannels = {
  red: { ...IDENTITY_HSL_CHANNEL },
  orange: { ...IDENTITY_HSL_CHANNEL },
  yellow: { ...IDENTITY_HSL_CHANNEL },
  green: { ...IDENTITY_HSL_CHANNEL },
  aqua: { ...IDENTITY_HSL_CHANNEL },
  blue: { ...IDENTITY_HSL_CHANNEL },
  purple: { ...IDENTITY_HSL_CHANNEL },
  magenta: { ...IDENTITY_HSL_CHANNEL },
};

const hslChannelSchema: JsonSchema = {
  type: 'object',
  properties: {
    hue: { type: 'number', minimum: -100, maximum: 100, default: 0 },
    saturation: { type: 'number', minimum: -100, maximum: 100, default: 0 },
    luminance: { type: 'number', minimum: -100, maximum: 100, default: 0 },
  },
  required: ['hue', 'saturation', 'luminance'],
};

const hslDetailShader = HSLDetailPass.fragmentShader;

function isHslDetailIdentity(p: HslDetailParams): boolean {
  for (const ch of HSL_CHANNELS) {
    const c = p.channels[ch];
    if (c.hue !== 0 || c.saturation !== 0 || c.luminance !== 0) return false;
  }
  if (p.viewSelected) return false;
  if (p.skinTone && (p.skinTone.uniHue > 0 || p.skinTone.uniSat > 0 || p.skinTone.uniLum > 0)) return false;
  return true;
}

const hslDetailKind: NodeKindSpec<HslDetailParams> = {
  kind: KIND_HSL_DETAIL,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: {
      channels: {
        type: 'object',
        properties: Object.fromEntries(HSL_CHANNELS.map((ch) => [ch, hslChannelSchema])),
        required: [...HSL_CHANNELS],
      },
    },
    required: ['channels'],
  },
  fragmentShader: hslDetailShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: isHslDetailIdentity,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as HslDetailParams;
    for (const ch of HSL_CHANNELS) {
      const c = p.channels[ch];
      gl.uniform1f(uniformLoc(gl, program, `u_hsl_${ch}_h`), c.hue);
      gl.uniform1f(uniformLoc(gl, program, `u_hsl_${ch}_s`), c.saturation);
      gl.uniform1f(uniformLoc(gl, program, `u_hsl_${ch}_l`), c.luminance);
    }
    const v = p.viewSelected;
    gl.uniform1f(uniformLoc(gl, program, 'u_view_sel_hue'), v ? v.hue : -1);
    gl.uniform1f(uniformLoc(gl, program, 'u_view_sel_hw'), v ? v.halfWidth : 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_view_sel_sat_min'), v ? v.satMin : 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_view_sel_sat_max'), v ? v.satMax : 0);
    const s = p.skinTone;
    gl.uniform1f(uniformLoc(gl, program, 'u_skin_ref_hue'), s ? s.refHue : 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_skin_ref_sat'), s ? s.refSat : 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_skin_ref_lum'), s ? s.refLum : 50);
    gl.uniform1f(uniformLoc(gl, program, 'u_skin_uni_hue'), s ? s.uniHue : 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_skin_uni_sat'), s ? s.uniSat : 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_skin_uni_lum'), s ? s.uniLum : 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_skin_hw'), s ? s.halfWidth : 0);
  },
};

// ─── Kind: CustomHSL (up to 8 dynamic sectors) ─────────────────────

export const KIND_CUSTOM_HSL = 'customHSL';
const MAX_CUSTOM_HSL_SECTORS = 8;

export interface CustomHslSector {
  hueCenter: number;
  hueHalfWidth: number;
  feather: number;
  dH: number; dS: number; dL: number;
  enabled?: boolean;
}

export interface CustomHslParams {
  sectors: CustomHslSector[];
}

const customHslShader = buildCustomHslShader();

function buildCustomHslShader(): string {
  let sectorUniforms = '';
  let sectorLogic = '';
  for (let i = 0; i < MAX_CUSTOM_HSL_SECTORS; i++) {
    sectorUniforms += `uniform float u_chsl_${i}_hueCenter, u_chsl_${i}_hueHW, u_chsl_${i}_feather;\n`;
    sectorUniforms += `uniform float u_chsl_${i}_dH, u_chsl_${i}_dS, u_chsl_${i}_dL;\n`;
    sectorLogic += `
    if (float(${i}) < u_custom_hsl_count) {
      float hw${i} = u_chsl_${i}_hueHW;
      float fe${i} = u_chsl_${i}_feather;
      float outerEdge${i} = hw${i} + fe${i} * 0.5;
      float innerEdge${i} = outerEdge${i} * 0.65;
      float dh${i} = abs(pixHue - u_chsl_${i}_hueCenter);
      if (dh${i} > 180.0) dh${i} = 360.0 - dh${i};
      float fade${i} = smoothstep(innerEdge${i}, outerEdge${i}, dh${i});
      float w${i} = 1.0 - fade${i};
      if (w${i} > 0.001) {
        hsl.x = fract(hsl.x + (u_chsl_${i}_dH / 360.0) * w${i});
        hsl.y = clamp(hsl.y + (u_chsl_${i}_dS / 100.0) * w${i}, 0.0, 1.0);
        hsl.z = clamp(hsl.z + (u_chsl_${i}_dL / 100.0) * w${i}, 0.0, 1.0);
        pixHue = hsl.x * 360.0;
      }
    }
`;
  }
  return `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_custom_hsl_count;
${sectorUniforms}

vec3 rgb2hsl(vec3 c) {
  float maxC = max(c.r, max(c.g, c.b));
  float minC = min(c.r, min(c.g, c.b));
  float l = (maxC + minC) * 0.5;
  float d = maxC - minC;
  float s = (d < 0.001) ? 0.0 : d / (1.0 - abs(2.0 * l - 1.0));
  float h = 0.0;
  if (d > 0.001) {
    if (maxC == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (maxC == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}

float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0/2.0) return q;
  if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
  return p;
}

vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x, s = hsl.y, l = hsl.z;
  if (s < 0.001) return vec3(l);
  float q = (l < 0.5) ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(
    hue2rgb(p, q, h + 1.0/3.0),
    hue2rgb(p, q, h),
    hue2rgb(p, q, h - 1.0/3.0)
  );
}

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  if (u_custom_hsl_count < 0.5) {
    fragColor = color;
    return;
  }
  vec3 hsl = rgb2hsl(color.rgb);
  float pixHue = hsl.x * 360.0;

${sectorLogic}

  fragColor = vec4(clamp(hsl2rgb(hsl), 0.0, 1.0), color.a);
}`;
}

function activeCustomHslSectors(sectors: readonly CustomHslSector[]): CustomHslSector[] {
  return sectors.filter((s) =>
    s.enabled !== false && (s.dH !== 0 || s.dS !== 0 || s.dL !== 0),
  ).slice(0, MAX_CUSTOM_HSL_SECTORS);
}

const customHslKind: NodeKindSpec<CustomHslParams> = {
  kind: KIND_CUSTOM_HSL,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: {
      sectors: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hueCenter: { type: 'number', minimum: 0, maximum: 360, multipleOf: 1, default: 0 },
            hueHalfWidth: { type: 'number', minimum: 1, maximum: 180, multipleOf: 1, default: 18 },
            feather: { type: 'number', minimum: 1, maximum: 30, default: 12 },
            dH: { type: 'number', minimum: -180, maximum: 180, multipleOf: 1, default: 0 },
            dS: { type: 'number', minimum: -100, maximum: 100, default: 0 },
            dL: { type: 'number', minimum: -100, maximum: 100, default: 0 },
            enabled: { type: 'boolean', default: true },
          },
          required: ['hueCenter', 'hueHalfWidth', 'feather', 'dH', 'dS', 'dL'],
        },
        maxItems: MAX_CUSTOM_HSL_SECTORS,
      },
    },
    required: ['sectors'],
  },
  fragmentShader: customHslShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: (p) => activeCustomHslSectors(p.sectors).length === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as CustomHslParams;
    const active = activeCustomHslSectors(p.sectors);
    gl.uniform1f(uniformLoc(gl, program, 'u_custom_hsl_count'), active.length);
    for (let i = 0; i < MAX_CUSTOM_HSL_SECTORS; i++) {
      const s = active[i];
      gl.uniform1f(uniformLoc(gl, program, `u_chsl_${i}_hueCenter`), s?.hueCenter ?? 0);
      gl.uniform1f(uniformLoc(gl, program, `u_chsl_${i}_hueHW`), s?.hueHalfWidth ?? 18);
      gl.uniform1f(uniformLoc(gl, program, `u_chsl_${i}_feather`), s?.feather ?? 12);
      gl.uniform1f(uniformLoc(gl, program, `u_chsl_${i}_dH`), s?.dH ?? 0);
      gl.uniform1f(uniformLoc(gl, program, `u_chsl_${i}_dS`), s?.dS ?? 0);
      gl.uniform1f(uniformLoc(gl, program, `u_chsl_${i}_dL`), s?.dL ?? 0);
    }
  },
};

// ─── Kind: WhiteBalanceRaw (HDR/linear, RAW path only) ────────────

export const KIND_WHITE_BALANCE_RAW = 'whiteBalanceRaw';

export interface WhiteBalanceRawParams {
  /** Per-channel multipliers from camera AsShotNeutral (already inverted to
   *  WB-applying form). [1,1,1] = identity. */
  wb: [number, number, number];
}

const colorInLinear = { id: 'in', type: 'color', space: 'linear' } as const;
const colorOutLinear = { id: 'out', type: 'color', space: 'linear' } as const;

const whiteBalanceRawShader = WhiteBalanceRawPass.fragmentShader;

const whiteBalanceRawKind: NodeKindSpec<WhiteBalanceRawParams> = {
  kind: KIND_WHITE_BALANCE_RAW,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorInLinear],
  outputPorts: [colorOutLinear],
  paramSchema: {
    type: 'object',
    properties: {
      wb: {
        type: 'array',
        items: { type: 'number', minimum: 0.1, maximum: 4, multipleOf: 0.01 },
        minItems: 3, maxItems: 3,
        default: [1, 1, 1],
      },
    },
    required: ['wb'],
  },
  fragmentShader: whiteBalanceRawShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: true,
  samplesNeighbors: false,
  isIdentity: (p) => p.wb[0] === 1 && p.wb[1] === 1 && p.wb[2] === 1,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as WhiteBalanceRawParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_wb_r'), p.wb[0]);
    gl.uniform1f(uniformLoc(gl, program, 'u_wb_g'), p.wb[1]);
    gl.uniform1f(uniformLoc(gl, program, 'u_wb_b'), p.wb[2]);
  },
};

// ─── Kind: Retouch (heal/clone discs, linear) ─────────────────────

export const KIND_RETOUCH = 'retouch';

/**
 * How many discs one node can carry. A uniform array has to be declared at
 * compile time, so this is a hard edge rather than a soft one: the editor
 * refuses the seventeenth spot instead of silently dropping it.
 */
export const MAX_RETOUCH_SPOTS = 16;

/**
 * One disc, in fractions of the image: `tx`/`ty` and `sx`/`sy` are 0..1 of
 * width and height, `r` is a fraction of the WIDTH. Resolution-independent on
 * purpose - the same spot has to land in the same place on a 300px thumbnail
 * and on the full-resolution export, which a radius in preview pixels never
 * did (F009).
 */
export interface RetouchSpot {
  tx: number; ty: number;
  sx: number; sy: number;
  r: number;
  /** 0..1 of the radius: how much of the disc is the falloff. */
  feather: number;
  opacity: number;
  mode: 'heal' | 'clone';
}

export interface RetouchParams {
  spots: RetouchSpot[];
  /** The later transform whose display-space points these spots describe. */
  displayTransform?: TransformParams;
  /** Serial transforms in source-to-output order for a free graph. */
  displayTransforms?: TransformParams[];
}

const RETOUCH_TRANSFORM_FIELDS = 6;

/** Encode arbitrary-length transform chains without imposing a shader-array cap. */
function retouchTransformTexture(transforms: readonly TransformParams[]): Uint8Array {
  const bytes = new Uint8Array(RETOUCH_TRANSFORM_FIELDS * Math.max(1, transforms.length) * 4);
  const view = new DataView(bytes.buffer);
  for (let row = 0; row < transforms.length; row++) {
    const t = transforms[row];
    const values = [
      t.rotation,
      t.flipH ? -1 : 1,
      t.flipV ? -1 : 1,
      t.perspectiveH,
      t.perspectiveV,
      t.distortion,
    ];
    for (let field = 0; field < values.length; field++) {
      view.setFloat32((row * RETOUCH_TRANSFORM_FIELDS + field) * 4, values[field], true);
    }
  }
  return bytes;
}

const retouchShader = buildRetouchShader();

function buildRetouchShader(): string {
  let uniforms = '';
  let logic = '';
  for (let i = 0; i < MAX_RETOUCH_SPOTS; i++) {
    uniforms += `uniform vec2 u_rt_${i}_target, u_rt_${i}_source;\n`;
    uniforms += `uniform float u_rt_${i}_radius, u_rt_${i}_feather, u_rt_${i}_opacity, u_rt_${i}_heal;\n`;
    logic += `
    if (float(${i}) < u_retouch_count) {
      vec2 target${i} = retouchInputPoint(u_rt_${i}_target);
      vec2 source${i} = retouchInputPoint(u_rt_${i}_source);
      vec2 d${i} = (v_texCoord - target${i}) * vec2(1.0, aspect);
      float a${i} = spotAlpha(length(d${i}), u_rt_${i}_radius, u_rt_${i}_feather) * u_rt_${i}_opacity;
      if (a${i} > 0.0) {
        vec2 uv${i} = clamp(v_texCoord + (source${i} - target${i}), vec2(0.0), vec2(1.0));
        vec3 src${i} = texture(u_texture, uv${i}).rgb;
        vec3 repl${i} = src${i};
        if (u_rt_${i}_heal > 0.5) {
          float sl${i} = dot(src${i}, RETOUCH_LUMA);
          float tl${i} = dot(rgb, RETOUCH_LUMA);
          repl${i} = sl${i} > 0.0 ? src${i} * (tl${i} / sl${i}) : rgb;
        }
        rgb = mix(rgb, max(repl${i}, vec3(0.0)), a${i});
      }
    }
`;
  }
  return `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_retouch_count;
uniform float u_rt_rotation, u_rt_flipH, u_rt_flipV;
uniform float u_rt_perspH, u_rt_perspV, u_rt_distortion;
uniform sampler2D u_rt_transform_data;
uniform float u_rt_transform_count;
${uniforms}

const vec3 RETOUCH_LUMA = vec3(0.299, 0.587, 0.114);

// Retouch runs before transform, while its points are selected on the
// transformed canvas. This is the same output-to-input map as TransformPass:
// it puts each displayed point into the image space this shader receives.
vec2 mapRetouchPoint(
  vec2 uv,
  float rotation,
  float flipH,
  float flipV,
  float perspH,
  float perspV,
  float distortion
) {
  uv.x = (flipH < 0.0) ? 1.0 - uv.x : uv.x;
  uv.y = (flipV < 0.0) ? 1.0 - uv.y : uv.y;
  uv -= 0.5;
  float imageAspect = max(u_resolution.x, 1.0) / max(u_resolution.y, 1.0);
  vec2 p = vec2(uv.x * imageAspect, uv.y);
  if (abs(perspH) > 0.001 || abs(perspV) > 0.001) {
    float w = 1.0 + perspH * 0.5 * p.x + perspV * 0.5 * p.y;
    p = p / max(w, 0.1);
  }
  if (abs(distortion) > 0.001) {
    float r2 = dot(p, p);
    p *= 1.0 + distortion * r2;
  }
  if (abs(rotation) > 0.001) {
    float s = sin(-rotation);
    float co = cos(-rotation);
    p = vec2(co * p.x - s * p.y, s * p.x + co * p.y);
  }
  uv = vec2(p.x / imageAspect, p.y);
  return uv + 0.5;
}

float retouchTransformField(int field, int transformIndex) {
  vec4 sampleValue = texelFetch(u_rt_transform_data, ivec2(field, transformIndex), 0);
  uvec4 bytes = uvec4(round(sampleValue * 255.0));
  uint bits = bytes.r | (bytes.g << 8u) | (bytes.b << 16u) | (bytes.a << 24u);
  return uintBitsToFloat(bits);
}

vec2 retouchInputPoint(vec2 uv) {
  if (u_rt_transform_count < 0.5) {
    return mapRetouchPoint(
      uv,
      u_rt_rotation,
      u_rt_flipH,
      u_rt_flipV,
      u_rt_perspH,
      u_rt_perspV,
      u_rt_distortion
    );
  }

  // Rendering flows from the retouch node toward the display. Sampling maps
  // the displayed point back through that same chain in reverse order.
  for (int i = int(u_rt_transform_count) - 1; i >= 0; --i) {
    uv = mapRetouchPoint(
      uv,
      retouchTransformField(0, i),
      retouchTransformField(1, i),
      retouchTransformField(2, i),
      retouchTransformField(3, i),
      retouchTransformField(4, i),
      retouchTransformField(5, i)
    );
  }
  return uv;
}

// The CPU version this replaces smoothstepped between the edges r and
// r * (1 - feather), which divides by zero at feather 0: both edges land on
// r, every alpha comes out NaN and the disc renders as a hole (card
// obs-retouch-feather-zero-nan). Written out, the degenerate case is simply
// a hard edge and says so.
float spotAlpha(float dist, float r, float feather) {
  if (r <= 0.0) return 0.0;
  float ramp = r * feather;
  if (ramp <= 0.0) return dist <= r ? 1.0 : 0.0;
  float t = clamp((r - dist) / ramp, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

void main() {
  vec4 color = texture(u_texture, v_texCoord);
  if (u_retouch_count < 0.5) {
    fragColor = color;
    return;
  }
  // The radius is a fraction of the width, so the vertical offset has to be
  // measured in the same unit - otherwise a disc is an ellipse on every
  // image that is not square.
  float aspect = max(u_resolution.y, 1.0) / max(u_resolution.x, 1.0);
  vec3 rgb = color.rgb;

${logic}

  fragColor = vec4(rgb, color.a);
}`;
}

/**
 * The spots that change a pixel, capped at what the shader declares. A disc
 * without radius or without opacity is one the user is still placing.
 */
export function activeRetouchSpots(spots: readonly RetouchSpot[] | undefined): RetouchSpot[] {
  return (spots ?? [])
    .filter((s) => s.r > 0 && s.opacity > 0)
    .slice(0, MAX_RETOUCH_SPOTS);
}

const retouchKind: NodeKindSpec<RetouchParams> = {
  kind: KIND_RETOUCH,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorInLinear],
  outputPorts: [colorOutLinear],
  paramSchema: {
    type: 'object',
    properties: {
      spots: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tx: { type: 'number', minimum: 0, maximum: 1, default: 0 },
            ty: { type: 'number', minimum: 0, maximum: 1, default: 0 },
            sx: { type: 'number', minimum: 0, maximum: 1, default: 0 },
            sy: { type: 'number', minimum: 0, maximum: 1, default: 0 },
            r: { type: 'number', minimum: 0, maximum: 1, default: 0 },
            feather: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
            opacity: { type: 'number', minimum: 0, maximum: 1, default: 1 },
            mode: { type: 'string', enum: ['heal', 'clone'], default: 'heal' },
          },
          required: ['tx', 'ty', 'sx', 'sy', 'r', 'feather', 'opacity', 'mode'],
        },
        maxItems: MAX_RETOUCH_SPOTS,
        default: [],
      },
    },
    required: ['spots'],
  },
  fragmentShader: retouchShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: true, // reads the source disc somewhere else in the frame
  isIdentity: (p) => activeRetouchSpots(p.spots).length === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as RetouchParams;
    const active = activeRetouchSpots(p.spots);
    const t = p.displayTransform;
    gl.uniform1f(uniformLoc(gl, program, 'u_retouch_count'), active.length);
    gl.uniform1f(uniformLoc(gl, program, 'u_rt_transform_count'), p.displayTransforms?.length ?? 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_rt_rotation'), t?.rotation ?? 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_rt_flipH'), t?.flipH ? -1 : 1);
    gl.uniform1f(uniformLoc(gl, program, 'u_rt_flipV'), t?.flipV ? -1 : 1);
    gl.uniform1f(uniformLoc(gl, program, 'u_rt_perspH'), t?.perspectiveH ?? 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_rt_perspV'), t?.perspectiveV ?? 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_rt_distortion'), t?.distortion ?? 0);
    for (let i = 0; i < MAX_RETOUCH_SPOTS; i++) {
      const s = active[i];
      gl.uniform2f(uniformLoc(gl, program, `u_rt_${i}_target`), s?.tx ?? 0, s?.ty ?? 0);
      gl.uniform2f(uniformLoc(gl, program, `u_rt_${i}_source`), s?.sx ?? 0, s?.sy ?? 0);
      gl.uniform1f(uniformLoc(gl, program, `u_rt_${i}_radius`), s?.r ?? 0);
      gl.uniform1f(uniformLoc(gl, program, `u_rt_${i}_feather`), s?.feather ?? 0);
      gl.uniform1f(uniformLoc(gl, program, `u_rt_${i}_opacity`), s?.opacity ?? 0);
      gl.uniform1f(uniformLoc(gl, program, `u_rt_${i}_heal`), s?.mode === 'heal' ? 1 : 0);
    }
  },
  derivedTextures: (params) => {
    const transforms = (params as RetouchParams).displayTransforms;
    return transforms && transforms.length > 0 ? [{
      name: 'u_rt_transform_data',
      data: {
        width: RETOUCH_TRANSFORM_FIELDS,
        height: transforms.length,
        pixels: retouchTransformTexture(transforms),
      },
    }] : [];
  },
};

// ─── Kind: ColorMatrix (HDR/linear, RAW path only) ────────────────

export const KIND_COLOR_MATRIX = 'colorMatrix';

export interface ColorMatrixParams {
  /** 3×3 row-major Camera-RGB → working-space (linear sRGB).
   *  Identity matrix = pass-through. */
  matrix: number[];
}

const colorMatrixShader = ColorMatrixPass.fragmentShader;

const IDENTITY_COLOR_MATRIX = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function isIdentityMatrix3(m: readonly number[]): boolean {
  if (m.length < 9) return false;
  for (let i = 0; i < 9; i++) if (m[i] !== IDENTITY_COLOR_MATRIX[i]) return false;
  return true;
}

const colorMatrixKind: NodeKindSpec<ColorMatrixParams> = {
  kind: KIND_COLOR_MATRIX,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorInLinear],
  outputPorts: [colorOutLinear],
  paramSchema: {
    type: 'object',
    properties: {
      matrix: {
        type: 'array',
        items: { type: 'number' },
        minItems: 9, maxItems: 9,
        default: IDENTITY_COLOR_MATRIX,
      },
    },
    required: ['matrix'],
  },
  fragmentShader: colorMatrixShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: true,
  samplesNeighbors: false,
  isIdentity: (p) => isIdentityMatrix3(p.matrix),
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const m = (params as ColorMatrixParams).matrix;
    gl.uniform1f(uniformLoc(gl, program, 'u_cm_r0'), m[0]);
    gl.uniform1f(uniformLoc(gl, program, 'u_cm_r1'), m[1]);
    gl.uniform1f(uniformLoc(gl, program, 'u_cm_r2'), m[2]);
    gl.uniform1f(uniformLoc(gl, program, 'u_cm_g0'), m[3]);
    gl.uniform1f(uniformLoc(gl, program, 'u_cm_g1'), m[4]);
    gl.uniform1f(uniformLoc(gl, program, 'u_cm_g2'), m[5]);
    gl.uniform1f(uniformLoc(gl, program, 'u_cm_b0'), m[6]);
    gl.uniform1f(uniformLoc(gl, program, 'u_cm_b1'), m[7]);
    gl.uniform1f(uniformLoc(gl, program, 'u_cm_b2'), m[8]);
  },
};

// ─── Kind: OutputColorSpace (HDR linear → gamma-encoded target) ────

export const KIND_OUTPUT_COLOR_SPACE = 'outputColorSpace';

export interface OutputColorSpaceParams {
  /** 3×3 row-major linear-sRGB → linear-target. Identity for sRGB output. */
  matrix: number[];
  /** 0=sRGB piecewise, 1=power 2.2, 2=ProPhoto, 3=Rec.2020 */
  gammaType: 0 | 1 | 2 | 3;
}

const outputColorSpaceShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_ocs_r0; uniform float u_ocs_r1; uniform float u_ocs_r2;
uniform float u_ocs_g0; uniform float u_ocs_g1; uniform float u_ocs_g2;
uniform float u_ocs_b0; uniform float u_ocs_b1; uniform float u_ocs_b2;
uniform float u_ocs_gamma_type;

float srgbEncode(float v) {
  v = clamp(v, 0.0, 1.0);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}
float prophotoEncode(float v) {
  v = clamp(v, 0.0, 1.0);
  return v <= 0.001953125 ? v * 16.0 : pow(v, 1.0 / 1.8);
}
float rec2020Encode(float v) {
  v = clamp(v, 0.0, 1.0);
  float a = 1.09929682680944;
  float b_ = 0.018053968510807;
  return v < b_ ? 4.5 * v : a * pow(v, 0.45) - (a - 1.0);
}
float encode(float v, float gtype) {
  if (gtype < 0.5) return srgbEncode(v);
  if (gtype < 1.5) return pow(clamp(v, 0.0, 1.0), 1.0 / 2.2);
  if (gtype < 2.5) return prophotoEncode(v);
  return rec2020Encode(v);
}

void main() {
  vec4 src = texture(u_texture, v_texCoord);
  vec3 c = src.rgb;
  float r = u_ocs_r0 * c.r + u_ocs_r1 * c.g + u_ocs_r2 * c.b;
  float g = u_ocs_g0 * c.r + u_ocs_g1 * c.g + u_ocs_g2 * c.b;
  float b = u_ocs_b0 * c.r + u_ocs_b1 * c.g + u_ocs_b2 * c.b;
  fragColor = vec4(
    encode(r, u_ocs_gamma_type),
    encode(g, u_ocs_gamma_type),
    encode(b, u_ocs_gamma_type),
    src.a
  );
}`;

const colorInLinearForOcs = { id: 'in', type: 'color', space: 'linear' } as const;
const colorOutGammaForOcs = { id: 'out', type: 'color', space: 'gamma' } as const;

const outputColorSpaceKind: NodeKindSpec<OutputColorSpaceParams> = {
  kind: KIND_OUTPUT_COLOR_SPACE,
  category: 'convert',
  userPlaceable: true,
  inputPorts: [colorInLinearForOcs],
  outputPorts: [colorOutGammaForOcs],
  paramSchema: {
    type: 'object',
    properties: {
      matrix: {
        type: 'array',
        items: { type: 'number' },
        minItems: 9, maxItems: 9,
        default: IDENTITY_COLOR_MATRIX,
      },
      gammaType: { type: 'integer', minimum: 0, maximum: 3, default: 0 },
    },
    required: ['matrix', 'gammaType'],
  },
  fragmentShader: outputColorSpaceShader,
  inputSpace: 'linear',
  outputSpace: 'gamma',
  // Output is gamma-encoded sRGB-ish 8-bit — no need for RGBA16F downstream.
  requiresFloat: false,
  samplesNeighbors: false,
  // Never identity: even with identity matrix + sRGB gamma, the encode is
  // load-bearing for the linear→gamma transition. Skipping would output
  // linear-light pixels into an 8-bit framebuffer (crushed midtones).
  isIdentity: () => false,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as OutputColorSpaceParams;
    const m = p.matrix;
    gl.uniform1f(uniformLoc(gl, program, 'u_ocs_r0'), m[0]);
    gl.uniform1f(uniformLoc(gl, program, 'u_ocs_r1'), m[1]);
    gl.uniform1f(uniformLoc(gl, program, 'u_ocs_r2'), m[2]);
    gl.uniform1f(uniformLoc(gl, program, 'u_ocs_g0'), m[3]);
    gl.uniform1f(uniformLoc(gl, program, 'u_ocs_g1'), m[4]);
    gl.uniform1f(uniformLoc(gl, program, 'u_ocs_g2'), m[5]);
    gl.uniform1f(uniformLoc(gl, program, 'u_ocs_b0'), m[6]);
    gl.uniform1f(uniformLoc(gl, program, 'u_ocs_b1'), m[7]);
    gl.uniform1f(uniformLoc(gl, program, 'u_ocs_b2'), m[8]);
    gl.uniform1f(uniformLoc(gl, program, 'u_ocs_gamma_type'), p.gammaType);
  },
};

// ─── Identity defaults (helper for builder + tests) ──────────────

export const IDENTITY_LEVELS_CHANNEL: LevelsChannel = { ...defaultLevelsChannel };
export const IDENTITY_BW_MIX: BwMix = { ...defaultBwMix };
export const IDENTITY_RAW_WB: [number, number, number] = [1, 1, 1];
export const IDENTITY_COLOR_MATRIX_3X3: readonly number[] = IDENTITY_COLOR_MATRIX;

// ─── Registration ────────────────────────────────────────────────

// ─── Kind: LensCorrection ─────────────────────────────────────────

export const KIND_LENS_CORRECTION = 'lensCorrection';

/** Profile coefficients resolved at build time (LENS_PROFILES lives on the
 *  main thread; the worker only ever sees plain numbers). */
export interface LensCorrectionParams {
  enabled: boolean;
  /** Brown-Conrady radial distortion coefficients. */
  k1: number; k2: number; k3: number;
  /** Vignetting-correction polynomial coefficients. */
  v1: number; v2: number; v3: number;
  /** Chromatic-aberration offsets for the R/B channels. */
  caR: number; caB: number;
  /** 0..1 */
  strength: number;
}

// LensCorrectionPass does not clamp, and the projection's mul100 does not
// either: a coefficient outside these ranges is not a strong correction, it is
// a broken frame. Measured profiles sit at 0.0x, so the step the form derives
// from the range (1/100 of it) is fine enough to dial one in.
const lensCoefficient: JsonSchema = { type: 'number', minimum: -1, maximum: 1, default: 0 };
const lensChromatic: JsonSchema = { type: 'number', minimum: -0.05, maximum: 0.05, default: 0 };

// Shader is IMPORTED from the legacy pass, not copied — both engines share
// one source of truth for the lens math during the migration window.
const lensCorrectionKind: NodeKindSpec<LensCorrectionParams> = {
  kind: KIND_LENS_CORRECTION,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [colorIn],
  outputPorts: [colorOut],
  paramSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: false },
      k1: lensCoefficient, k2: lensCoefficient, k3: lensCoefficient,
      v1: lensCoefficient, v2: lensCoefficient, v3: lensCoefficient,
      caR: lensChromatic, caB: lensChromatic,
      strength: { type: 'number', minimum: 0, maximum: 1, default: 1 },
    },
    required: ['enabled', 'k1', 'k2', 'k3', 'v1', 'v2', 'v3', 'caR', 'caB', 'strength'],
  },
  fragmentShader: LensCorrectionPass.fragmentShader,
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: false,
  samplesNeighbors: true,
  isIdentity: (p) => !p.enabled || p.strength === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as LensCorrectionParams;
    gl.uniform1f(uniformLoc(gl, program, 'u_lc_enabled'), p.enabled ? 1 : 0);
    gl.uniform1f(uniformLoc(gl, program, 'u_lc_k1'), p.k1);
    gl.uniform1f(uniformLoc(gl, program, 'u_lc_k2'), p.k2);
    gl.uniform1f(uniformLoc(gl, program, 'u_lc_k3'), p.k3);
    gl.uniform1f(uniformLoc(gl, program, 'u_lc_v1'), p.v1);
    gl.uniform1f(uniformLoc(gl, program, 'u_lc_v2'), p.v2);
    gl.uniform1f(uniformLoc(gl, program, 'u_lc_v3'), p.v3);
    gl.uniform1f(uniformLoc(gl, program, 'u_lc_ca_r'), p.caR);
    gl.uniform1f(uniformLoc(gl, program, 'u_lc_ca_b'), p.caB);
    gl.uniform1f(uniformLoc(gl, program, 'u_lc_strength'), p.strength);
  },
};

export function registerBuiltinPassKinds(registry: NodeRegistry): void {
  registry.replace(lensCorrectionKind as NodeKindSpec);
  registry.replace(toneKind as NodeKindSpec);
  registry.replace(whiteBalanceKind as NodeKindSpec);
  registry.replace(toneCurveKind as NodeKindSpec);
  registry.replace(levelsKind as NodeKindSpec);
  registry.replace(hslKind as NodeKindSpec);
  registry.replace(hslDetailKind as NodeKindSpec);
  registry.replace(customHslKind as NodeKindSpec);
  registry.replace(bwKind as NodeKindSpec);
  registry.replace(colorGradingKind as NodeKindSpec);
  registry.replace(clarityKind as NodeKindSpec);
  registry.replace(textureKind as NodeKindSpec);
  registry.replace(denoiseKind as NodeKindSpec);
  registry.replace(sharpenKind as NodeKindSpec);
  registry.replace(effectsKind as NodeKindSpec);
  registry.replace(transformKind as NodeKindSpec);
  registry.replace(cropKind as NodeKindSpec);
  registry.replace(whiteBalanceRawKind as NodeKindSpec);
  registry.replace(retouchKind as NodeKindSpec);
  registry.replace(colorMatrixKind as NodeKindSpec);
  registry.replace(outputColorSpaceKind as NodeKindSpec);
}

/** Canonical Lightroom-order chain. Default-graph builder reads this list. */
export const BUILTIN_PASS_KIND_ORDER: ReadonlyArray<string> = [
  KIND_LENS_CORRECTION,
  KIND_TONE,
  KIND_WHITE_BALANCE,
  KIND_TONE_CURVE,
  KIND_LEVELS,
  KIND_HSL,
  KIND_HSL_DETAIL,
  KIND_CUSTOM_HSL,
  KIND_BW,
  KIND_COLOR_GRADING,
  KIND_CLARITY,
  KIND_TEXTURE,
  KIND_DENOISE,
  KIND_SHARPEN,
  KIND_EFFECTS,
  KIND_TRANSFORM,
  KIND_CROP,
];
