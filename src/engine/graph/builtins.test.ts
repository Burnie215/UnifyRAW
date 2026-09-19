/**
 * Built-in convert + tap kinds.
 *
 * Phase 2 regression: convert kinds (`linToGamma`, `gammaToLin`) shipped
 * as no-op stubs (no fragmentShader) in Phase 0/1 because no Plan-time
 * adjustment kind actually needed them — everything was 'either'-tagged.
 * Phase 2 flipped the SDR adjustments to concrete linear/gamma and
 * activated the compiler's convert-insertion, which silently passed
 * garbage through the chain until real shaders were wired in. This test
 * locks down the shape going forward.
 */
import { describe, expect, it } from 'vitest';
import { NodeRegistry } from './NodeRegistry';
import {
  registerBuiltinConverts, KIND_CONVERT_LIN_TO_GAMMA, KIND_CONVERT_GAMMA_TO_LIN, KIND_TAP,
} from './builtins';

describe('builtin convert + tap kinds', () => {
  it('registerBuiltinConverts installs both convert kinds + tap', () => {
    const r = new NodeRegistry();
    registerBuiltinConverts(r);
    expect(r.has(KIND_CONVERT_LIN_TO_GAMMA)).toBe(true);
    expect(r.has(KIND_CONVERT_GAMMA_TO_LIN)).toBe(true);
    expect(r.has(KIND_TAP)).toBe(true);
  });

  it('convert kinds carry real fragment shaders (Phase 2 regression guard)', () => {
    const r = new NodeRegistry();
    registerBuiltinConverts(r);
    const l2g = r.require(KIND_CONVERT_LIN_TO_GAMMA);
    const g2l = r.require(KIND_CONVERT_GAMMA_TO_LIN);
    expect(l2g.fragmentShader).toBeTruthy();
    expect(l2g.fragmentShader).toContain('main()');
    expect(g2l.fragmentShader).toBeTruthy();
    expect(g2l.fragmentShader).toContain('main()');
    // Sanity: shaders implement the sRGB piecewise transfer (Phase 2 spec).
    expect(l2g.fragmentShader).toMatch(/0\.0031308/);
    expect(g2l.fragmentShader).toMatch(/0\.04045/);
  });

  it('convert kinds declare opposite in/out spaces', () => {
    const r = new NodeRegistry();
    registerBuiltinConverts(r);
    const l2g = r.require(KIND_CONVERT_LIN_TO_GAMMA);
    const g2l = r.require(KIND_CONVERT_GAMMA_TO_LIN);
    expect(l2g.inputSpace).toBe('linear');
    expect(l2g.outputSpace).toBe('gamma');
    expect(g2l.inputSpace).toBe('gamma');
    expect(g2l.outputSpace).toBe('linear');
  });

  it('gamma→linear convert requires float (RGBA16F headroom)', () => {
    const r = new NodeRegistry();
    registerBuiltinConverts(r);
    const g2l = r.require(KIND_CONVERT_GAMMA_TO_LIN);
    expect(g2l.requiresFloat).toBe(true);
  });
});
