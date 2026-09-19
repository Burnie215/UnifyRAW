/**
 * Compositor-Node kinds (Phase 1.C). Multi-input nodes that blend two
 * color inputs under an optional mask.
 *
 * Sampler convention (per executor):
 *   port 'in'    → `u_texture` (primary input — the running stack)
 *   port 'layer' → `u_layer`   (this layer's rendered output)
 *   port 'mask'  → `u_mask`    (per-pixel alpha, single-channel in .r)
 *
 * Blend modes mirror LayerCompositor.ts's set. Each is implemented inline
 * in GLSL — equivalent to the Canvas2D `globalCompositeOperation` math but
 * runs on the GPU.
 */
import type { NodeKindSpec, JsonSchema } from './types';
import type { NodeRegistry } from './NodeRegistry';

export const KIND_COMPOSITE = 'composite';

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay'
  | 'soft-light' | 'hard-light' | 'difference'
  | 'darken' | 'lighten' | 'color' | 'luminosity';

const BLEND_MODE_INDEX: Record<BlendMode, number> = {
  'normal':     0,
  'multiply':   1,
  'screen':     2,
  'overlay':    3,
  'soft-light': 4,
  'hard-light': 5,
  'difference': 6,
  'darken':     7,
  'lighten':    8,
  'color':      9,
  'luminosity': 10,
};

export interface CompositeParams {
  /** 0..1 — how strongly the layer overrides the base. */
  opacity: number;
  blendMode: BlendMode;
  /** If true, the `mask` input is honoured per-pixel; if false, the layer
   *  covers the entire base region at `opacity` × global. */
  useMask: boolean;
  /**
   * Set when this layer came from a preset (`DocLayer.presetSyncId`). Not a
   * render parameter — the shader ignores it. It rides along because a preset
   * layer is allowed to carry its own grain and vignette so the Amount slider
   * can fade them, while every other branch has to match the base on those
   * fields. Without the marker the projection cannot tell the two apart and
   * would lock the way back on an ordinary document that merely has a look
   * preset applied. It is also what lets a projected document keep its preset
   * identity, so the next preset replaces the layer instead of stacking.
   */
  presetSyncId?: string;
}

const compositeShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;    // base (running stack)
uniform sampler2D u_layer;      // this layer's render
uniform sampler2D u_mask;       // single-channel alpha in .r
uniform float u_opacity;        // 0..1
uniform float u_blendMode;      // int 0..10
uniform float u_useMask;        // 0 or 1

// ─── Blend-mode helpers (perception-matched to Canvas2D operators) ───
vec3 blendMultiply(vec3 b, vec3 l) { return b * l; }
vec3 blendScreen  (vec3 b, vec3 l) { return 1.0 - (1.0 - b) * (1.0 - l); }
vec3 blendOverlay (vec3 b, vec3 l) {
  return vec3(
    b.r < 0.5 ? 2.0 * b.r * l.r : 1.0 - 2.0 * (1.0 - b.r) * (1.0 - l.r),
    b.g < 0.5 ? 2.0 * b.g * l.g : 1.0 - 2.0 * (1.0 - b.g) * (1.0 - l.g),
    b.b < 0.5 ? 2.0 * b.b * l.b : 1.0 - 2.0 * (1.0 - b.b) * (1.0 - l.b)
  );
}
float softLightChan(float b, float l) {
  if (l <= 0.5) return b - (1.0 - 2.0 * l) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * l - 1.0) * (d - b);
}
vec3 blendSoftLight(vec3 b, vec3 l) {
  return vec3(softLightChan(b.r, l.r), softLightChan(b.g, l.g), softLightChan(b.b, l.b));
}
vec3 blendHardLight(vec3 b, vec3 l) { return blendOverlay(l, b); }
vec3 blendDifference(vec3 b, vec3 l) { return abs(b - l); }
vec3 blendDarken (vec3 b, vec3 l) { return min(b, l); }
vec3 blendLighten(vec3 b, vec3 l) { return max(b, l); }

// HSL helpers for 'color' / 'luminosity' blend modes.
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 setLuma(vec3 c, float l) {
  float d = l - luma(c);
  return clamp(c + vec3(d), 0.0, 1.0);
}
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float maxC = max(max(c.r, c.g), c.b);
  float minC = min(min(c.r, c.g), c.b);
  float curr = maxC - minC;
  if (curr <= 0.0) return vec3(0.0);
  return (c - minC) * s / curr;
}

vec3 blend(vec3 b, vec3 l, float mode) {
  if (mode < 0.5)  return l;                                              // normal
  if (mode < 1.5)  return blendMultiply(b, l);
  if (mode < 2.5)  return blendScreen(b, l);
  if (mode < 3.5)  return blendOverlay(b, l);
  if (mode < 4.5)  return blendSoftLight(b, l);
  if (mode < 5.5)  return blendHardLight(b, l);
  if (mode < 6.5)  return blendDifference(b, l);
  if (mode < 7.5)  return blendDarken(b, l);
  if (mode < 8.5)  return blendLighten(b, l);
  if (mode < 9.5)  return setLuma(setSat(l, sat(b)), luma(b));            // color
  return setLuma(b, luma(l));                                             // luminosity
}

void main() {
  vec4 base  = texture(u_texture, v_texCoord);
  vec4 layer = texture(u_layer,   v_texCoord);
  float a = u_opacity;
  if (u_useMask > 0.5) {
    a *= texture(u_mask, v_texCoord).r;
  }
  vec3 blended = blend(base.rgb, layer.rgb, u_blendMode);
  fragColor = vec4(mix(base.rgb, blended, a), base.a);
}`;

const blendModeSchema: JsonSchema = {
  type: 'string',
  enum: Object.keys(BLEND_MODE_INDEX),
  default: 'normal',
};

const compositeKind: NodeKindSpec<CompositeParams> = {
  kind: KIND_COMPOSITE,
  category: 'compositor',
  userPlaceable: true,
  inputPorts: [
    { id: 'in',    type: 'color', space: 'either' },
    { id: 'layer', type: 'color', space: 'either' },
    // 'many' multiplicity = 0+ incoming edges, used here as "optional one":
    // mask is bound by callers that need it; pure-blend compositors leave
    // it dangling. The executor's multi-input wiring already handles the
    // 0-edges case by simply not binding `u_mask`.
    { id: 'mask',  type: 'mask',  space: 'either', multiplicity: 'many' },
  ],
  outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: {
      opacity:   { type: 'number', minimum: 0, maximum: 1, default: 1 },
      blendMode: blendModeSchema,
      useMask:   { type: 'boolean', default: false },
      // Carried, not rendered — see CompositeParams.presetSyncId.
      presetSyncId: { type: 'string' },
    },
    required: ['opacity', 'blendMode', 'useMask'],
  },
  fragmentShader: compositeShader,
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  // Identity when opacity=0 OR (blend=normal AND mask off AND opacity=0).
  // Opacity > 0 with any mode is treated as active to keep mask paths
  // exercised even when blend is normal+full (visual no-op but the
  // compositor still needs to copy `layer` over `base`).
  isIdentity: (p) => p.opacity === 0,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as CompositeParams;
    const loc = (n: string) => gl.getUniformLocation(program, n);
    gl.uniform1f(loc('u_opacity'), p.opacity);
    gl.uniform1f(loc('u_blendMode'), BLEND_MODE_INDEX[p.blendMode] ?? 0);
    gl.uniform1f(loc('u_useMask'), p.useMask ? 1 : 0);
  },
};

// ─── Phase 5a sub-phases: utility compositors for compare/diff workflows ───

export const KIND_AB_SWAP = 'abSwap';
export const KIND_DIFFERENCE = 'difference';

export interface AbSwapParams {
  /** false = pass `in` (A), true = pass `layer` (B). UI binds this to a
   *  hotkey for quick before/after toggling. */
  showB: boolean;
}

const abSwapShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture; // A
uniform sampler2D u_layer;   // B
uniform float u_showB;
void main() {
  fragColor = u_showB > 0.5
    ? texture(u_layer, v_texCoord)
    : texture(u_texture, v_texCoord);
}`;

const abSwapKind: NodeKindSpec<AbSwapParams> = {
  kind: KIND_AB_SWAP,
  category: 'compositor',
  userPlaceable: true,
  inputPorts: [
    { id: 'in',    type: 'color', space: 'either' },
    { id: 'layer', type: 'color', space: 'either' },
  ],
  outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: { showB: { type: 'boolean', default: false } },
    required: ['showB'],
  },
  fragmentShader: abSwapShader,
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  // showB=false copies A → identity-skip from the executor's perspective
  // would short-circuit to upstream-A directly. Acceptable optimisation.
  isIdentity: (p) => !p.showB,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    gl.uniform1f(gl.getUniformLocation(program, 'u_showB'), (params as AbSwapParams).showB ? 1 : 0);
  },
};

export interface DifferenceParams {
  /** Multiplier on |A−B|. Defaults to 10× so subtle diffs are visible. */
  amplify: number;
}

const differenceShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture; // A
uniform sampler2D u_layer;   // B
uniform float u_amplify;
void main() {
  vec3 a = texture(u_texture, v_texCoord).rgb;
  vec3 b = texture(u_layer, v_texCoord).rgb;
  fragColor = vec4(clamp(abs(a - b) * u_amplify, 0.0, 1.0), 1.0);
}`;

const differenceKind: NodeKindSpec<DifferenceParams> = {
  kind: KIND_DIFFERENCE,
  category: 'compositor',
  userPlaceable: true,
  inputPorts: [
    { id: 'in',    type: 'color', space: 'either' },
    { id: 'layer', type: 'color', space: 'either' },
  ],
  outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: { amplify: { type: 'number', minimum: 1, maximum: 100, default: 10 } },
    required: ['amplify'],
  },
  fragmentShader: differenceShader,
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: () => false, // pure diff-vis is never identity
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    gl.uniform1f(gl.getUniformLocation(program, 'u_amplify'), (params as DifferenceParams).amplify);
  },
};

// ─── Phase 5a sub-phase: Side-by-side compare ──────────────────────

export const KIND_SIDE_BY_SIDE = 'sideBySide';

export interface SideBySideParams {
  /** 0..1 horizontal split position. Pixels with U < split sample A,
   *  U ≥ split sample B. Default 0.5 = clean center split. */
  split: number;
  /** If true, swap A/B sides (useful for keyboard-toggling without
   *  re-wiring the graph). */
  flip: boolean;
}

const sideBySideShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture; // A
uniform sampler2D u_layer;   // B
uniform float u_split;
uniform float u_flip;
void main() {
  bool aSide = v_texCoord.x < u_split;
  if (u_flip > 0.5) aSide = !aSide;
  fragColor = aSide ? texture(u_texture, v_texCoord) : texture(u_layer, v_texCoord);
}`;

const sideBySideKind: NodeKindSpec<SideBySideParams> = {
  kind: KIND_SIDE_BY_SIDE,
  category: 'compositor',
  userPlaceable: true,
  inputPorts: [
    { id: 'in',    type: 'color', space: 'either' },
    { id: 'layer', type: 'color', space: 'either' },
  ],
  outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: {
      split: { type: 'number', minimum: 0, maximum: 1, default: 0.5 },
      flip:  { type: 'boolean', default: false },
    },
    required: ['split', 'flip'],
  },
  fragmentShader: sideBySideShader,
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  // split=0 or split=1 ⇒ output is one full side; identity if A wins.
  isIdentity: (p) => (p.split >= 1 && !p.flip) || (p.split <= 0 && p.flip),
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as SideBySideParams;
    gl.uniform1f(gl.getUniformLocation(program, 'u_split'), p.split);
    gl.uniform1f(gl.getUniformLocation(program, 'u_flip'), p.flip ? 1 : 0);
  },
};

export function registerBuiltinCompositors(registry: NodeRegistry): void {
  registry.replace(compositeKind as NodeKindSpec);
  registry.replace(abSwapKind as NodeKindSpec);
  registry.replace(differenceKind as NodeKindSpec);
  registry.replace(sideBySideKind as NodeKindSpec);
}

export const BLEND_MODE_NAMES: ReadonlyArray<BlendMode> = Object.keys(BLEND_MODE_INDEX) as BlendMode[];
