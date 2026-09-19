import type { NodeKindSpec } from './types';
import type { NodeRegistry } from './NodeRegistry';

/**
 * Compiler-emitted color-space conversion nodes. The user never adds these
 * directly — the compiler inserts them at segment boundaries where a
 * producer's output space differs from the consumer's input space.
 *
 * Phase 2 wires real fragment shaders here so the converts actually
 * transform values. Prior to Phase 2 every adjustment kind was 'either',
 * so the compiler never emitted these in practice and the no-op stubs
 * were sufficient.
 */

export const KIND_CONVERT_LIN_TO_GAMMA = '__convert.linToGamma';
export const KIND_CONVERT_GAMMA_TO_LIN = '__convert.gammaToLin';
export const KIND_TAP = '__tap';

// sRGB transfer functions (piecewise linear/exponential per IEC 61966-2-1).
const linToGammaShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
float encode(float v) {
  v = clamp(v, 0.0, 1.0);
  return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}
void main() {
  vec4 c = texture(u_texture, v_texCoord);
  fragColor = vec4(encode(c.r), encode(c.g), encode(c.b), c.a);
}`;

const gammaToLinShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
float decode(float v) {
  v = clamp(v, 0.0, 1.0);
  return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4);
}
void main() {
  vec4 c = texture(u_texture, v_texCoord);
  fragColor = vec4(decode(c.r), decode(c.g), decode(c.b), c.a);
}`;

const linToGamma: NodeKindSpec = {
  kind: KIND_CONVERT_LIN_TO_GAMMA,
  category: 'convert',
  inputPorts: [{ id: 'in', type: 'color', space: 'linear' }],
  outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
  paramSchema: { type: 'object', properties: {} },
  fragmentShader: linToGammaShader,
  inputSpace: 'linear',
  outputSpace: 'gamma',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: () => false,
  isAsync: false,
};

const gammaToLin: NodeKindSpec = {
  kind: KIND_CONVERT_GAMMA_TO_LIN,
  category: 'convert',
  inputPorts: [{ id: 'in', type: 'color', space: 'gamma' }],
  outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
  paramSchema: { type: 'object', properties: {} },
  fragmentShader: gammaToLinShader,
  inputSpace: 'gamma',
  outputSpace: 'linear',
  requiresFloat: true, // linear output ⇒ needs float headroom
  samplesNeighbors: false,
  isIdentity: () => false,
  isAsync: false,
};

/**
 * Tap node: captures the upstream texture into its own dedicated FBO so
 * external code can read it (Histogram source, preCurveCanvas snapshot,
 * user-placed compare-taps in Phase 4 graph editor).
 *
 * The compiler always puts a tap into its own single-node segment so the
 * captured FBO is not recycled by downstream ping-pong. The `'either'`
 * spaces let the tap sit anywhere in the chain without forcing a convert.
 */
const tap: NodeKindSpec = {
  kind: KIND_TAP,
  category: 'tap',
  inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
  // Passthrough output so the tap can be inlined into the chain — downstream
  // consumers read from the tap's dedicated FBO, which guarantees the
  // captured texture survives the rest of the segment's ping-pong cycle.
  outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: {
      label: { type: 'string' },
    },
    required: ['label'],
  },
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: () => false,
  isAsync: false,
};

/**
 * Register the compiler-emitted convert + tap kinds on a registry. Must be
 * called before compiling any graph whose nodes mix color spaces or use
 * compile-time captureAfter taps; throws on compile otherwise.
 *
 * Safe to call multiple times — uses `replace` so re-registration during
 * hot-reload or test setup doesn't blow up.
 */
export function registerBuiltinConverts(registry: NodeRegistry): void {
  registry.replace(linToGamma);
  registry.replace(gammaToLin);
  registry.replace(tap);
}

export function pickConvertKind(fromSpace: 'linear' | 'gamma', toSpace: 'linear' | 'gamma'): string {
  if (fromSpace === 'linear' && toSpace === 'gamma') return KIND_CONVERT_LIN_TO_GAMMA;
  if (fromSpace === 'gamma' && toSpace === 'linear') return KIND_CONVERT_GAMMA_TO_LIN;
  throw new Error(`pickConvertKind: no convert needed for ${fromSpace} -> ${toSpace}`);
}
