/**
 * The unorm16-to-linear-half bridge, which is where a linear DNG is won or
 * lost.
 *
 * Both ways of getting it wrong produce a file that opens. Passing the
 * readback through untouched reads 65535 as a half-float bit pattern, which is
 * 1.8e6; dividing by 65535 and stopping there leaves gamma-encoded numbers
 * under a header that promises linear light. Neither raises an error anywhere,
 * so the assertions below are on VALUES - literal half-float bit patterns
 * computed from the transfer functions by hand - rather than on the conversion
 * running to completion.
 */
import { describe, expect, it } from 'vitest';

import { halfToFloat } from './DngEncoder';
import { linearHalfSamples } from './dngSamples';
import { NodeRegistry } from './graph/NodeRegistry';
import { KIND_OUTPUT_COLOR_SPACE, registerBuiltinPassKinds } from './graph/passKinds';
import { decodeOutputTransfer, OUTPUT_COLOR_SPACES } from './outputColorSpaces';

const UNORM16_MAX = 65535;

/**
 * The shader's `encode()`, transcribed from `outputColorSpaceShader` rather
 * than imported: an inverse that is only tested against its own encoder proves
 * that a mistake is symmetric, not that it is absent.
 */
function shaderEncode(value: number, gammaType: number): number {
  const v = Math.min(1, Math.max(0, value));
  if (gammaType < 0.5) return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  if (gammaType < 1.5) return Math.pow(v, 1 / 2.2);
  if (gammaType < 2.5) return v <= 0.001953125 ? v * 16.0 : Math.pow(v, 1 / 1.8);
  const a = 1.09929682680944;
  const b = 0.018053968510807;
  return v < b ? 4.5 * v : a * Math.pow(v, 0.45) - (a - 1);
}

function rgba(...samples: number[]): Uint16Array {
  return Uint16Array.from(samples);
}

describe('decodeOutputTransfer', () => {
  it('inverts the shader over the whole range, for every gamma type', () => {
    for (const gammaType of [0, 1, 2, 3]) {
      for (let step = 0; step <= 1000; step++) {
        const linear = step / 1000;
        const back = decodeOutputTransfer(shaderEncode(linear, gammaType), gammaType);
        expect(Math.abs(back - linear)).toBeLessThan(1e-6);
      }
    }
  });

  it('meets the piecewise curves exactly at their knee, from both sides', () => {
    // The sRGB knee sits at 0.0031308 * 12.92 and not at the widely quoted
    // 0.04045; a decoder that uses the rounded constant has a discontinuity
    // there. Same for ProPhoto at 0.001953125 * 16.
    const knees: Array<[gammaType: number, linear: number, slope: number]> = [
      [0, 0.0031308, 12.92],
      [2, 0.001953125, 16],
      [3, 0.018053968510807, 4.5],
    ];
    for (const [gammaType, linear, slope] of knees) {
      const encoded = linear * slope;
      expect(decodeOutputTransfer(encoded, gammaType)).toBeCloseTo(linear, 12);
      // Continuity across the branch, relative to the value: an absolute
      // tolerance would be meaningless at 0.00195 and useless at 0.018.
      for (const side of [1 - 1e-9, 1 + 1e-9]) {
        const back = decodeOutputTransfer(encoded * side, gammaType);
        expect(Math.abs(back - linear) / linear).toBeLessThan(1e-5);
      }
    }
  });

  it('clamps outside [0,1] the way the shader does', () => {
    expect(decodeOutputTransfer(-0.5, 0)).toBe(0);
    expect(decodeOutputTransfer(4, 0)).toBe(1);
  });

  it('still matches the constants the live shader is built from', () => {
    // The inverse lives in outputColorSpaces.ts and the forward curve in a GLSL
    // string; nothing but this makes an edit to one show up as a failure of
    // the other.
    const registry = new NodeRegistry();
    registerBuiltinPassKinds(registry);
    const shader = registry.get(KIND_OUTPUT_COLOR_SPACE)?.fragmentShader ?? '';
    expect(shader).toContain('v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055');
    expect(shader).toContain('pow(clamp(v, 0.0, 1.0), 1.0 / 2.2)');
    expect(shader).toContain('v <= 0.001953125 ? v * 16.0 : pow(v, 1.0 / 1.8)');
    expect(shader).toContain('1.09929682680944');
    expect(shader).toContain('0.018053968510807');
    expect(shader).toContain('4.5 * v : a * pow(v, 0.45) - (a - 1.0)');
  });
});

describe('linearHalfSamples', () => {
  /**
   * Literal binary16 patterns for four unorm16 code points, worked out from
   * the transfer functions off-machine. sRGB's half-scale code decodes to
   * 0.21405, not to 0.5 - that gap IS the conversion, and 0x3800 (half of 0.5)
   * appearing in a colour channel would mean it never happened.
   */
  it('writes the exact half-float pattern of the linearised sample', () => {
    const codes = rgba(0, 16384, 32768, 65535, 49152, 1, 0, 0);
    const half = linearHalfSamples(codes, 'srgb');
    expect([...half.subarray(0, 3)]).toEqual([0x0000, 0x2a83, 0x32d9]);
    expect([...half.subarray(4, 7)]).toEqual([0x382e, 0x0014, 0x0000]);
  });

  it('reads back as light, not as the encoded value', () => {
    const half = linearHalfSamples(rgba(32768, 49152, 16384, 65535), 'srgb');
    expect(halfToFloat(half[0])).toBeCloseTo(0.21399, 5);
    expect(halfToFloat(half[1])).toBeCloseTo(0.52246, 5);
    expect(halfToFloat(half[2])).toBeCloseTo(0.05087, 5);
    // The mistake this guards: 32768/65535 is 0.50001, and a bridge that only
    // normalised would land there.
    expect(halfToFloat(half[0])).toBeLessThan(0.3);
  });

  it('follows the chosen space, because each one has its own curve', () => {
    const codes = rgba(32768, 32768, 32768, 65535);
    expect([...linearHalfSamples(codes, 'srgb').subarray(0, 3)])
      .toEqual([0x32d9, 0x32d9, 0x32d9]);
    // Adobe RGB is a plain power 2.2 (gammaType 1), so the same code lands on
    // a different number - 0.21765 against sRGB's 0.21399.
    expect([...linearHalfSamples(codes, 'adobe-rgb').subarray(0, 3)])
      .toEqual([0x32f7, 0x32f7, 0x32f7]);
    expect(OUTPUT_COLOR_SPACES.srgb.gammaType).toBe(0);
    expect(OUTPUT_COLOR_SPACES['adobe-rgb'].gammaType).toBe(1);
  });

  it('normalises alpha without linearising it', () => {
    // The shader passes src.a through untouched, so a transfer curve applied
    // here would invent a value. Half of 0.5000076 is exactly 0x3800.
    const half = linearHalfSamples(rgba(32768, 32768, 32768, 32768), 'srgb');
    expect(half[3]).toBe(0x3800);
    expect(halfToFloat(half[3])).toBe(0.5);
    expect(half[3]).not.toBe(half[0]);
  });

  it('keeps the anchors of the range exact', () => {
    const half = linearHalfSamples(rgba(0, 0, 0, 0, UNORM16_MAX, UNORM16_MAX, UNORM16_MAX, UNORM16_MAX), 'srgb');
    expect([...half.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    // 0x3C00 is 1.0. White has to survive as white in every space.
    expect([...half.subarray(4)]).toEqual([0x3c00, 0x3c00, 0x3c00, 0x3c00]);
    for (const id of ['adobe-rgb', 'prophoto', 'rec2020'] as const) {
      expect(linearHalfSamples(rgba(UNORM16_MAX, 0, UNORM16_MAX, UNORM16_MAX), id)[0]).toBe(0x3c00);
    }
  });

  it('agrees with the decoder for every one of the 65536 code points', () => {
    // The implementation memoises a table; this is the check that the table is
    // the function and not an interpolation of it.
    const codes = new Uint16Array((UNORM16_MAX + 1) * 4);
    for (let code = 0; code <= UNORM16_MAX; code++) codes[code * 4] = code;
    const half = linearHalfSamples(codes, 'prophoto');
    let mismatch = -1;
    for (let code = 0; code <= UNORM16_MAX; code++) {
      const expected = decodeOutputTransfer(code / UNORM16_MAX, 2);
      if (Math.abs(halfToFloat(half[code * 4]) - expected) > expected * 5e-4 + 1e-7) {
        mismatch = code;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  });

  it('refuses a buffer that is not RGBA', () => {
    expect(() => linearHalfSamples(rgba(1, 2, 3), 'srgb')).toThrow(/RGBA/);
  });
});
