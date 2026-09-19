/**
 * Mask-generator nodes (Phase 1.C/D2). Produce single-channel masks that
 * the Compositor's `mask` port consumes.
 *
 * Phase 1.C ships **rangeMask** only — a shader-driven luminance- or
 * color-range mask. Brush, linear-/radial-gradient and AI-segment masks
 * are kept on the legacy CPU rasterizer (`renderMaskToCanvas`) and bound
 * as externally-rasterized textures via a future `rasterizedMaskSource`
 * kind. Decision-point: porting those into dedicated nodes is tracked
 * separately (UI-tied: brushes need stroke state, AI needs ONNX worker).
 *
 * Output convention: mask alpha lives in the .r channel, matching the
 * Compositor shader's `texture(u_mask, …).r` read.
 */
import type { NodeKindSpec, JsonSchema } from './types';
import type { NodeRegistry } from './NodeRegistry';

export const KIND_RANGE_MASK = 'rangeMask';

export type RangeMaskType = 'luminance' | 'color';

export interface RangeMaskParams {
  /** 'luminance' samples luma; 'color' samples HSL distance to refColor. */
  type: RangeMaskType;
  /** 0..1, in the chosen domain (luma for 'luminance'; hue-distance for 'color'). */
  min: number;
  max: number;
  /** 0..1 — soft falloff outside [min, max]. */
  feather: number;
  /** Reference color for 'color' mode. RGB in 0..1. */
  refColor?: { r: number; g: number; b: number };
  /** If true, mask = 1 - mask. */
  invert?: boolean;
}

const rangeMaskShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform float u_type;        // 0=luminance, 1=color
uniform float u_min;
uniform float u_max;
uniform float u_feather;
uniform vec3  u_refColor;    // ignored when type=luminance
uniform float u_invert;      // 0 or 1

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

float rangeMask(float v) {
  // Smooth-step into [min, max] with feather falloff on both sides.
  float lo = u_min - u_feather;
  float hi = u_max + u_feather;
  float left  = smoothstep(lo, u_min, v);
  float right = 1.0 - smoothstep(u_max, hi, v);
  return clamp(left * right, 0.0, 1.0);
}

void main() {
  vec3 c = texture(u_texture, v_texCoord).rgb;
  float metric;
  if (u_type < 0.5) {
    metric = luma(c);
  } else {
    // HSL-distance approximation: euclidean RGB distance to refColor,
    // normalised by sqrt(3). Sufficient for color-range UI selection;
    // a real HSL conversion would be more accurate but ~5× more shader
    // ops for marginal perceptual gain.
    vec3 d = c - u_refColor;
    metric = 1.0 - clamp(length(d) / 1.7320508, 0.0, 1.0);
  }
  float m = rangeMask(metric);
  if (u_invert > 0.5) m = 1.0 - m;
  // Mask alpha lives in .r; .g/.b mirror for debugging tools that
  // visualise it as a grayscale overlay.
  fragColor = vec4(m, m, m, 1.0);
}`;

const refColorSchema: JsonSchema = {
  type: 'object',
  properties: {
    r: { type: 'number', minimum: 0, maximum: 1, default: 1 },
    g: { type: 'number', minimum: 0, maximum: 1, default: 0 },
    b: { type: 'number', minimum: 0, maximum: 0, default: 0 },
  },
  required: ['r', 'g', 'b'],
};

const rangeMaskKind: NodeKindSpec<RangeMaskParams> = {
  kind: KIND_RANGE_MASK,
  category: 'mask',
  userPlaceable: true,
  inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
  // Output is a mask but lives in an RGBA8 texture for simplicity. The
  // compositor reads .r when binding via `u_mask`.
  outputPorts: [{ id: 'out', type: 'mask', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: {
      type:    { type: 'string', enum: ['luminance', 'color'], default: 'luminance' },
      min:     { type: 'number', minimum: 0, maximum: 1, default: 0 },
      max:     { type: 'number', minimum: 0, maximum: 1, default: 1 },
      feather: { type: 'number', minimum: 0, maximum: 1, default: 0.1 },
      refColor: refColorSchema,
      invert:  { type: 'boolean', default: false },
    },
    required: ['type', 'min', 'max', 'feather'],
  },
  fragmentShader: rangeMaskShader,
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  // Full-pass mask (min=0, max=1) with no feather + no invert is the
  // identity-mask (all white) — composite layer always applies fully.
  isIdentity: (p) =>
    p.type === 'luminance' && p.min === 0 && p.max === 1 && !p.invert,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as RangeMaskParams;
    const loc = (n: string) => gl.getUniformLocation(program, n);
    gl.uniform1f(loc('u_type'), p.type === 'color' ? 1 : 0);
    gl.uniform1f(loc('u_min'), p.min);
    gl.uniform1f(loc('u_max'), p.max);
    gl.uniform1f(loc('u_feather'), p.feather);
    const ref = p.refColor ?? { r: 1, g: 0, b: 0 };
    gl.uniform3f(loc('u_refColor'), ref.r, ref.g, ref.b);
    gl.uniform1f(loc('u_invert'), p.invert ? 1 : 0);
  },
};

// ─── Phase 5b: edge-detect mask (Sobel) ───────────────────────────

export const KIND_EDGE_MASK = 'edgeMask';

export interface EdgeMaskParams {
  /** 0..1 — gradient-magnitude threshold below which mask is 0. */
  threshold: number;
  /** 0..1 — feather above the threshold. */
  feather: number;
  /** If true, mask = 1 - mask. */
  invert?: boolean;
}

const edgeMaskShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
uniform vec2 u_resolution;
uniform float u_threshold;
uniform float u_feather;
uniform float u_invert;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

void main() {
  vec2 px = 1.0 / u_resolution;
  // Sobel 3×3 luma gradient.
  float tl = luma(texture(u_texture, v_texCoord + vec2(-px.x, -px.y)).rgb);
  float  t = luma(texture(u_texture, v_texCoord + vec2(   0.0, -px.y)).rgb);
  float tr = luma(texture(u_texture, v_texCoord + vec2( px.x, -px.y)).rgb);
  float  l = luma(texture(u_texture, v_texCoord + vec2(-px.x,   0.0)).rgb);
  float  r = luma(texture(u_texture, v_texCoord + vec2( px.x,   0.0)).rgb);
  float bl = luma(texture(u_texture, v_texCoord + vec2(-px.x,  px.y)).rgb);
  float  b = luma(texture(u_texture, v_texCoord + vec2(   0.0,  px.y)).rgb);
  float br = luma(texture(u_texture, v_texCoord + vec2( px.x,  px.y)).rgb);
  float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
  float gy = -tl - 2.0 *  t - tr + bl + 2.0 *  b + br;
  float mag = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);
  float m = smoothstep(u_threshold, u_threshold + u_feather, mag);
  if (u_invert > 0.5) m = 1.0 - m;
  fragColor = vec4(m, m, m, 1.0);
}`;

const edgeMaskKind: NodeKindSpec<EdgeMaskParams> = {
  kind: KIND_EDGE_MASK,
  category: 'mask',
  userPlaceable: true,
  inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
  outputPorts: [{ id: 'out', type: 'mask', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: {
      threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.1 },
      feather:   { type: 'number', minimum: 0, maximum: 1, default: 0.1 },
      invert:    { type: 'boolean', default: false },
    },
    required: ['threshold', 'feather'],
  },
  fragmentShader: edgeMaskShader,
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: true,
  // Threshold=0 + no invert ⇒ all edges pass — but never a pure passthrough,
  // so we report non-identity to keep the mask path exercised.
  isIdentity: () => false,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as EdgeMaskParams;
    gl.uniform1f(gl.getUniformLocation(program, 'u_threshold'), p.threshold);
    gl.uniform1f(gl.getUniformLocation(program, 'u_feather'), p.feather);
    gl.uniform1f(gl.getUniformLocation(program, 'u_invert'), p.invert ? 1 : 0);
  },
};

// ─── Phase 5b: mask combinator (add / subtract / intersect / invert) ───

export const KIND_MASK_COMBINATOR = 'maskCombinator';

export type MaskCombinatorOp = 'add' | 'subtract' | 'intersect' | 'difference';

export interface MaskCombinatorParams {
  /** add = max(a,b); subtract = a-b; intersect = min(a,b); difference = |a-b| */
  op: MaskCombinatorOp;
}

const maskCombinatorShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture; // mask A (in .r)
uniform sampler2D u_layer;   // mask B (in .r)
uniform float u_op;          // 0=add, 1=subtract, 2=intersect, 3=difference
void main() {
  float a = texture(u_texture, v_texCoord).r;
  float b = texture(u_layer,   v_texCoord).r;
  float m;
  if      (u_op < 0.5) m = clamp(max(a, b), 0.0, 1.0);
  else if (u_op < 1.5) m = clamp(a - b,     0.0, 1.0);
  else if (u_op < 2.5) m = min(a, b);
  else                 m = abs(a - b);
  fragColor = vec4(m, m, m, 1.0);
}`;

const OP_INDEX: Record<MaskCombinatorOp, number> = {
  add: 0, subtract: 1, intersect: 2, difference: 3,
};

const maskCombinatorKind: NodeKindSpec<MaskCombinatorParams> = {
  kind: KIND_MASK_COMBINATOR,
  category: 'mask',
  userPlaceable: true,
  // 'in' = mask A (primary, drives identity), 'layer' = mask B.
  // Reusing the 'layer' port id keeps the multi-input executor's sampler
  // convention (`u_layer`) consistent with the Compositor's secondary.
  inputPorts: [
    { id: 'in',    type: 'mask', space: 'either' },
    { id: 'layer', type: 'mask', space: 'either' },
  ],
  outputPorts: [{ id: 'out', type: 'mask', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: Object.keys(OP_INDEX), default: 'add' },
    },
    required: ['op'],
  },
  fragmentShader: maskCombinatorShader,
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: () => false,
  isAsync: false,
  bindUniforms: (gl, program, params) => {
    const p = params as MaskCombinatorParams;
    gl.uniform1f(gl.getUniformLocation(program, 'u_op'), OP_INDEX[p.op] ?? 0);
  },
};

export function registerBuiltinMaskKinds(registry: NodeRegistry): void {
  registry.replace(rangeMaskKind as NodeKindSpec);
  registry.replace(edgeMaskKind as NodeKindSpec);
  registry.replace(maskCombinatorKind as NodeKindSpec);
}
