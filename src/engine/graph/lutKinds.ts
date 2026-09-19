/**
 * Custom-LUT node (Phase 5c). Single-input, single-output pass that applies
 * a 3D look-up table sampled from a Float32 grid.
 *
 * Param shape: `{ size: number; samples: Float32Array }` where `samples`
 * is a flat Nx N x N x RGB grid in row-major (R fastest), grid coordinate
 * = sRGB-encoded source pixel × (N-1).
 *
 * The LUT itself is uploaded as a **2D texture** of `size × size*size` pixels
 * (slices laid out vertically). 3D sampling math runs in the fragment shader.
 * WebGL2 has native 3D textures (`TEXTURE_3D` + `sampler3D`) which would be
 * cleaner — Phase 5c keeps the 2D-slice variant for portability with code
 * that still works on WebGL1 fallbacks (unused today but cheap to keep).
 *
 * `.cube` file parsing belongs in the UI layer; this kind just consumes the
 * resulting `samples` array. Validation (size in 2..64, samples length
 * matches) happens at param-set time via the JSON-schema.
 *
 * A node without a file is a placeholder, not a black frame: `isIdentity`
 * answers true while there are no samples, so a freshly dropped node leaves
 * the picture alone until the inspector's `.cube` field has fed it (F074).
 */
import type { NodeKindSpec, JsonSchema, DerivedTextureSpec } from './types';
import type { NodeRegistry } from './NodeRegistry';

export const KIND_CUSTOM_LUT = 'customLut';

export interface CustomLutParams {
  /** Cube edge length, typically 17 / 33 / 65. */
  size: number;
  /** Flat Nx N x N x 3 RGB grid (Float32, [0..1]). length = size^3 * 3. */
  samples: Float32Array;
  /** 0..1 — blend the LUT result back over the input. 1 = full LUT,
   *  0 = bypass. Identity-skip kicks in at 0. */
  amount: number;
}

const customLutShader = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;     // input
uniform sampler2D u_lut;         // LUT texture (size × size*size)
uniform float u_lut_size;        // edge length N
uniform float u_amount;          // 0..1 mix

vec3 sampleLut(vec3 rgb) {
  float N = u_lut_size;
  vec3 grid = clamp(rgb, 0.0, 1.0) * (N - 1.0);
  float bLo = floor(grid.b);
  float bHi = min(bLo + 1.0, N - 1.0);
  float bT  = grid.b - bLo;
  // For each slice in B, look up (R, G) within a single N×N tile, stacked
  // vertically — tile y0 is slice 0, y1 is slice 1, … so the LUT-2D
  // texture has dimensions (N, N*N).
  float texW = N;
  float texH = N * N;
  vec2 inv = vec2(1.0 / texW, 1.0 / texH);
  vec2 baseLo = vec2(grid.r + 0.5, bLo * N + grid.g + 0.5) * inv;
  vec2 baseHi = vec2(grid.r + 0.5, bHi * N + grid.g + 0.5) * inv;
  vec3 sliceLo = texture(u_lut, baseLo).rgb;
  vec3 sliceHi = texture(u_lut, baseHi).rgb;
  return mix(sliceLo, sliceHi, bT);
}

void main() {
  vec4 src = texture(u_texture, v_texCoord);
  vec3 lut = sampleLut(src.rgb);
  fragColor = vec4(mix(src.rgb, lut, u_amount), src.a);
}`;

/** Below this a `samples` array cannot describe even a 2³ cube. */
export const MIN_LUT_SAMPLES = 24;

/**
 * Largest cube the inspector writes into a node's params.
 *
 * The samples live inline in the edit, so they are copied into every stored
 * revision and pushed on every sync: 33³ is ~108k numbers, 65³ would be
 * ~824k. An asset table with a reference is the way past this and is its own
 * card; until then the inspector says no rather than quietly making documents
 * that no longer sync.
 */
export const MAX_INLINE_LUT_SIZE = 33;

/**
 * How many samples these params carry. `samples` is a `Float32Array` while the
 * node is live and a plain array once it has been through the document's JSON,
 * so neither `Array.isArray` nor `.length` alone answers this.
 */
export function lutSampleCount(samples: unknown): number {
  if (Array.isArray(samples)) return samples.length;
  if (ArrayBuffer.isView(samples)) return (samples as Float32Array).length;
  return 0;
}

const samplesSchema: JsonSchema = {
  type: 'array',
  items: { type: 'number' },
  // Real validation (length = size^3 × 3) is `parseCubeFile`, behind the
  // inspector's `.cube` field (NodeInspectorPanel's CustomLutFileField);
  // schema-level only catches "empty / wrong type" mistakes. `minItems` is
  // also what the library reads to mark the node as needing a file.
  minItems: MIN_LUT_SAMPLES,  // 2^3 × 3 — smallest meaningful cube
  maxItems: 786_432,          // 64^3 × 3 — Phase-5c hard limit
};


const customLutKind: NodeKindSpec<CustomLutParams> = {
  kind: KIND_CUSTOM_LUT,
  category: 'adjustment',
  userPlaceable: true,
  inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
  outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: {
      size: { type: 'integer', minimum: 2, maximum: 64, default: 33 },
      samples: samplesSchema,
      amount: { type: 'number', minimum: 0, maximum: 1, default: 1 },
    },
    required: ['size', 'samples', 'amount'],
  },
  fragmentShader: customLutShader,
  // LUTs are space-agnostic at the math level — they map input RGB to
  // output RGB by table lookup. The user-supplied LUT carries its own
  // implicit space; `_colorSpaceOverride` lets the user pin it.
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  // Without a file there is nothing to look up, and sampling an empty texture
  // renders black. A node the user just dropped is a placeholder.
  isIdentity: (p) => p.amount === 0 || lutSampleCount(p.samples) < MIN_LUT_SAMPLES,
  isAsync: false,
  derivedTextures: (params): DerivedTextureSpec[] => {
    // Pack the flat samples into an N × N*N RGBA grid (alpha = 1).
    const N = params.size;
    const w = N, h = N * N;
    const out = new Float32Array(w * h * 4);
    for (let b = 0; b < N; b++) {
      for (let g = 0; g < N; g++) {
        for (let r = 0; r < N; r++) {
          const srcIdx = (b * N * N + g * N + r) * 3;
          const dstIdx = ((b * N + g) * w + r) * 4;
          out[dstIdx + 0] = params.samples[srcIdx + 0];
          out[dstIdx + 1] = params.samples[srcIdx + 1];
          out[dstIdx + 2] = params.samples[srcIdx + 2];
          out[dstIdx + 3] = 1;
        }
      }
    }
    return [{ name: 'u_lut', data: { width: w, height: h, pixels: out } }];
  },
  bindUniforms: (gl, program, params) => {
    const p = params as CustomLutParams;
    const loc = (n: string) => gl.getUniformLocation(program, n);
    gl.uniform1f(loc('u_lut_size'), p.size);
    gl.uniform1f(loc('u_amount'), p.amount);
  },
};

export function registerBuiltinLutKinds(registry: NodeRegistry): void {
  registry.replace(customLutKind as NodeKindSpec);
}

// ─── .cube file parser (UI helper) ───────────────────────────────────

/**
 * Parse an Adobe `.cube` 3D LUT file into `CustomLutParams`. Throws on
 * malformed input — caller wraps and surfaces a UI error.
 *
 * Adobe spec: text file with optional `TITLE`, optional `DOMAIN_MIN/MAX`,
 * `LUT_3D_SIZE N` header, then `N^3` lines of `R G B` floats. Blue varies
 * slowest, then green, then red.
 */
export function parseCubeFile(text: string): { size: number; samples: Float32Array } {
  const lines = text.split(/\r?\n/);
  let size = 0;
  const samples: number[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('TITLE') || line.startsWith('DOMAIN_')) continue;
    const sizeMatch = /^LUT_3D_SIZE\s+(\d+)/i.exec(line);
    if (sizeMatch) { size = parseInt(sizeMatch[1], 10); continue; }
    const triple = line.split(/\s+/).map(Number);
    if (triple.length === 3 && triple.every((n) => Number.isFinite(n))) {
      samples.push(triple[0], triple[1], triple[2]);
    }
  }
  if (size < 2) throw new Error('parseCubeFile: missing or invalid LUT_3D_SIZE');
  const expected = size * size * size * 3;
  if (samples.length !== expected) {
    throw new Error(`parseCubeFile: expected ${expected / 3} samples, got ${samples.length / 3}`);
  }
  return { size, samples: new Float32Array(samples) };
}
