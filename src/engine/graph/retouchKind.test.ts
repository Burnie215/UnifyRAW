/**
 * The retouch node's contract. The pixels it produces are measured in
 * `compat/retouch.browser.test.ts`; this file is about what the compiler and
 * the inspector read off the kind before a single pixel is drawn.
 */
import { describe, expect, it, vi } from 'vitest';
import { NodeRegistry } from './NodeRegistry';
import {
  registerBuiltinPassKinds,
  activeRetouchSpots,
  KIND_RETOUCH,
  MAX_RETOUCH_SPOTS,
  type RetouchSpot,
} from './passKinds';

const SPOT: RetouchSpot = {
  tx: 0.5, ty: 0.5, sx: 0.2, sy: 0.5, r: 0.1, feather: 0.5, opacity: 1, mode: 'heal',
};

function kind() {
  const registry = new NodeRegistry();
  registerBuiltinPassKinds(registry);
  return registry.require(KIND_RETOUCH);
}

describe('retouch node kind', () => {
  it('is registered with the built-in passes', () => {
    const registry = new NodeRegistry();
    registerBuiltinPassKinds(registry);
    expect(registry.has(KIND_RETOUCH)).toBe(true);
  });

  it('runs in linear light on both ports', () => {
    // A disc copied in gamma-encoded samples and one copied in linear light
    // are two different pictures, and the RAW path only has the latter.
    const spec = kind();
    expect(spec.inputSpace).toBe('linear');
    expect(spec.outputSpace).toBe('linear');
    expect(spec.inputPorts[0].space).toBe('linear');
    expect(spec.outputPorts[0].space).toBe('linear');
  });

  it('says it samples elsewhere in the frame', () => {
    // The source disc is somewhere else entirely, so the node must not be
    // folded into a neighbour's pass.
    expect(kind().samplesNeighbors).toBe(true);
  });

  it('caps the spot list at what the shader declares', () => {
    const schema = kind().paramSchema;
    expect(schema.type).toBe('object');
    const spots = schema.type === 'object' ? schema.properties.spots : undefined;
    expect(spots?.type).toBe('array');
    expect(spots?.type === 'array' ? spots.maxItems : 0).toBe(MAX_RETOUCH_SPOTS);
  });

  it('is identity without spots, and with spots that change nothing', () => {
    const spec = kind();
    expect(spec.isIdentity({ spots: [] })).toBe(true);
    expect(spec.isIdentity({ spots: [{ ...SPOT, r: 0 }] })).toBe(true);
    expect(spec.isIdentity({ spots: [{ ...SPOT, opacity: 0 }] })).toBe(true);
    expect(spec.isIdentity({ spots: [SPOT] })).toBe(false);
  });

  it('drops the spots past the declared maximum instead of rendering none', () => {
    const many = Array.from({ length: MAX_RETOUCH_SPOTS + 4 }, () => SPOT);
    expect(activeRetouchSpots(many)).toHaveLength(MAX_RETOUCH_SPOTS);
    expect(activeRetouchSpots(undefined)).toEqual([]);
  });

  it('does not carry the CPU falloff that divides by zero at feather 0', () => {
    // `smoothstep(r, r * (1 - feather), dist)` collapses both edges onto r at
    // feather 0, and every alpha comes out NaN (obs-retouch-feather-zero-nan).
    // The shader writes the ramp out and branches on the degenerate case; the
    // pixel proof is in the browser test.
    const shader = kind().fragmentShader ?? '';
    expect(shader).toContain('float spotAlpha(');
    expect(shader).not.toMatch(/smoothstep\s*\(/);
    expect(shader).toContain('if (ramp <= 0.0)');
  });

  it('binds feather 0 as zero instead of replacing the hard edge', () => {
    const uniform1f = vi.fn();
    const gl = {
      getUniformLocation: (_program: WebGLProgram, name: string) => name,
      uniform1f,
      uniform2f: vi.fn(),
    } as unknown as WebGL2RenderingContext;

    kind().bindUniforms!(gl, {} as WebGLProgram, {
      spots: [{ ...SPOT, feather: 0 }],
    });

    expect(uniform1f).toHaveBeenCalledWith('u_rt_0_feather', 0);
  });
});
