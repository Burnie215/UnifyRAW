/**
 * The ±100-to-±1 factor the graph inspectors apply, measured on ABSOLUTE
 * numbers.
 *
 * A round trip alone cannot see a wrong factor: `toUi` and `toParam` read the
 * same constant, so a mutation moves both and `toUi(toParam(x)) === x` stays
 * green. That is precisely how the 100x regression survived — the inspectors
 * wrote the raw slider value into a param that the shader reads as ±1. So
 * every assertion here names the number on the wire, and the seam to the two
 * other spellings of the same factor (`DefaultGraphBuilder.div100` writing the
 * param, `paramsToAdjustments.mul100` reading it back) is measured with the
 * real builder, not with a mirror of it (F139).
 */
import { describe, expect, it } from 'vitest';

import { toParam, toUi } from './inspectorScale';
import { paramsByNodeFromAdjustments } from '../engine/graph/DefaultGraphBuilder';
import { SDR } from '../engine/graph/projection/projectionFixtures';
import { getMainThreadNodeRegistry, KIND_TONE, type JsonSchema } from '../engine/graph';

function toneParams(adjustments: Record<string, number>): Record<string, number> {
  const params = paramsByNodeFromAdjustments(adjustments, SDR).get(`default:${KIND_TONE}`);
  return params as Record<string, number>;
}

describe('inspector scale', () => {
  it('maps the tone schema bounds to the editor bounds', () => {
    const schema = getMainThreadNodeRegistry().require(KIND_TONE).paramSchema as Extract<
      JsonSchema,
      { type: 'object' }
    >;
    const exposure = schema.properties.exposure as Extract<JsonSchema, { type: 'number' }>;

    expect([exposure.minimum, exposure.maximum]).toEqual([-1, 1]);
    expect([toUi(exposure.minimum), toUi(exposure.maximum)]).toEqual([-100, 100]);
    expect([toParam(-100), toParam(100)]).toEqual([exposure.minimum, exposure.maximum]);
  });

  it('turns an editor value into the param the shader reads', () => {
    expect(toParam(37)).toBe(0.37);
    expect(toParam(-100)).toBe(-1);
    expect(toParam(0)).toBe(0);
  });

  it('turns a param back into the editor value', () => {
    expect(toUi(0.37)).toBe(37);
    expect(toUi(-1)).toBe(-100);
    expect(toUi(undefined)).toBe(0);
  });

  it('rounds the editor value, because the slider steps in whole numbers', () => {
    expect(toUi(0.375)).toBe(38);
    expect(toUi(0.3749)).toBe(37);
  });

  it('reads back what the builder wrote, on the number itself', () => {
    // The builder's div100 and the inspector's toUi are two spellings of one
    // factor. Asserting 0.37 and 37 by name is what makes a one-sided
    // mutation visible; equality of the two ends would not.
    expect(toneParams({ exposure: 37 }).exposure).toBe(0.37);
    expect(toUi(toneParams({ exposure: 37 }).exposure)).toBe(37);
    expect(toneParams({ exposure: toUi(0.52) }).exposure).toBe(0.52);
  });

  it('writes what the builder would have written', () => {
    expect(toParam(37)).toBe(toneParams({ exposure: 37 }).exposure);
    expect(toParam(-18)).toBe(toneParams({ contrast: -18 }).contrast);
  });
});
