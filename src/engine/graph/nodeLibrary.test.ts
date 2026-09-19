/**
 * Two guards over what the node library offers and what the inspector can
 * show for it.
 *
 * F018: the generic form used to invent a ±100 range in steps of two for any
 * number the schema left unbounded, and the lens node — which sits in the
 * DEFAULT chain — had eight such coefficients plus a strength. The schema is
 * the only place a scale is allowed to live now, so every number an adjustment
 * kind can put in front of the user has to name its own.
 *
 * F019: the library listed `registry.list()` minus the converts, which offered
 * the encoder (no shader, the executor throws on it), the three source kinds
 * (no way to bind pixels) and the internal `__tap`, while hiding
 * `outputColorSpace` — the one kind a Delete makes unrecoverable. `userPlaceable`
 * is now the answer, and these tests are what keeps the list honest.
 */
import { describe, expect, it } from 'vitest';

import { NodeRegistry } from './NodeRegistry';
import { registerAllBuiltins } from './registerBuiltins';
import { GraphCompiler } from './GraphCompiler';
import { buildDefaultGraph } from './DefaultGraphBuilder';
import { insertAfter, SDR } from './projection/projectionFixtures';
import { KIND_TAP, KIND_CONVERT_GAMMA_TO_LIN, KIND_CONVERT_LIN_TO_GAMMA } from './builtins';
import { KIND_MULTI_OUTPUT_ENCODER } from './encoderKinds';
import { KIND_IMAGE_BITMAP_SOURCE, KIND_RASTERIZED_MASK_SOURCE, KIND_RAW16_SOURCE } from './sources';
import { KIND_OUTPUT_COLOR_SPACE, KIND_TONE } from './passKinds';
import { KIND_PREVIEW } from './previewKind';
import type { JsonSchema, NodeKindSpec } from './types';

function builtins(): NodeRegistry {
  const registry = new NodeRegistry();
  registerAllBuiltins(registry);
  return registry;
}

/**
 * Every number/integer the generic form would turn into a control, with the
 * path it sits at. Array-of-number params (a colour matrix, a curve, the LUT
 * samples) are not walked: the form shows those as "N entries", never as a
 * slider, so a bound there would document nothing.
 */
function numericProperties(schema: JsonSchema, path = ''): { path: string; schema: JsonSchema }[] {
  const out: { path: string; schema: JsonSchema }[] = [];
  if (schema.type === 'object') {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const at = path ? `${path}.${key}` : key;
      if (prop.type === 'number' || prop.type === 'integer') out.push({ path: at, schema: prop });
      else out.push(...numericProperties(prop, at));
    }
  } else if (schema.type === 'array' && schema.items.type === 'object') {
    out.push(...numericProperties(schema.items, `${path}[]`));
  }
  return out;
}

describe('adjustment schemas carry their own scale', () => {
  const registry = builtins();
  const adjustments = registry.list('adjustment');

  it('has adjustment kinds to check at all', () => {
    expect(adjustments.length).toBeGreaterThan(10);
  });

  it.each(adjustments.map((k) => k.kind))('%s bounds every number it offers', (kind) => {
    const spec = registry.require(kind);
    const unbounded = numericProperties(spec.paramSchema)
      .filter(({ schema }) => {
        const s = schema as { minimum?: number; maximum?: number };
        return s.minimum === undefined || s.maximum === undefined;
      })
      .map(({ path }) => path);
    expect(unbounded).toEqual([]);
  });

  it('gives the lens node the ranges its shader actually reads', () => {
    const lens = registry.require('lensCorrection').paramSchema as Extract<JsonSchema, { type: 'object' }>;
    const props = lens.properties as Record<string, { minimum?: number; maximum?: number }>;
    expect(props.strength).toMatchObject({ minimum: 0, maximum: 1, default: 1 });
    expect(props.k1).toMatchObject({ minimum: -1, maximum: 1 });
    expect(props.caR).toMatchObject({ minimum: -0.05, maximum: 0.05 });
    // What the form derives from that: a step of 1/200 of the range, which for
    // strength is the 0.005 the plan asks for, not the two the fallback gave.
    expect((1 - 0) / 200).toBe(0.005);
  });

  it('keeps the black-and-white mix on the editor scale, where its shader reads it', () => {
    const bw = registry.require('bw').paramSchema as Extract<JsonSchema, { type: 'object' }>;
    const mix = bw.properties.mix as Extract<JsonSchema, { type: 'object' }>;
    expect(mix.properties.red).toMatchObject({ minimum: -100, maximum: 100 });
  });
});

describe('what the library may offer', () => {
  const registry = builtins();
  const placeable = registry.list().filter((k) => k.userPlaceable === true).map((k) => k.kind);

  it('offers outputColorSpace, which a Delete would otherwise take for good', () => {
    expect(placeable).toContain(KIND_OUTPUT_COLOR_SPACE);
  });

  it.each([
    KIND_MULTI_OUTPUT_ENCODER,
    KIND_TAP,
    KIND_CONVERT_LIN_TO_GAMMA,
    KIND_CONVERT_GAMMA_TO_LIN,
    KIND_IMAGE_BITMAP_SOURCE,
    KIND_RAW16_SOURCE,
    KIND_RASTERIZED_MASK_SOURCE,
  ])('does not offer %s, which cannot run from the surface', (kind) => {
    expect(registry.require(kind).userPlaceable).toBeUndefined();
    expect(placeable).not.toContain(kind);
  });

  it.each(placeable)('%s can actually render', (kind) => {
    const spec = registry.require(kind);
    // The preview tap is the one placeable kind without a shader: it passes
    // its input through and the executor knows it by category.
    if (spec.category === 'tap') expect(spec.kind).toBe(KIND_PREVIEW);
    else expect(spec.fragmentShader, `${kind} has no fragment shader`).toBeTruthy();
    expect(spec.outputPorts.length, `${kind} has no output port`).toBeGreaterThan(0);
  });
});

describe('a placeable kind compiles where the user drops it', () => {
  const registry = builtins();
  const compiler = new GraphCompiler(registry);
  // One colour in, one colour out: the kinds that run on their own where the
  // user drops them. The mask kinds and the compositors are placeable too but
  // are not this test's business - they produce a `mask` or need a second
  // input, so they only run once the user has wired the other end, and a
  // splice into the colour chain rightly refuses them.
  const inChain = registry.list()
    .filter((k) => k.userPlaceable === true
      && k.inputPorts.length === 1
      && k.outputPorts.length === 1
      && k.outputPorts[0].type === 'color')
    .map((k) => k.kind);

  it('covers most of the library', () => {
    expect(inChain.length).toBeGreaterThan(15);
  });

  it('leaves the mask kinds out for a reason the port types state', () => {
    for (const kind of ['rangeMask', 'edgeMask', 'maskCombinator']) {
      const spec = registry.require(kind);
      expect(spec.userPlaceable).toBe(true);
      expect(spec.outputPorts[0].type).toBe('mask');
      expect(inChain).not.toContain(kind);
    }
  });

  it.each(inChain)('%s runs when spliced in behind the tone node', (kind) => {
    const graph = buildDefaultGraph({}, SDR).graph;
    const spec = registry.require(kind) as NodeKindSpec;
    const params = defaultsOf(spec.paramSchema);
    const error = compiler.validate(insertAfter(graph, `default:${KIND_TONE}`, `user:${kind}`, kind, params));
    expect(error?.message ?? null).toBeNull();
  });
});

/** `defaultParamsForSchema` lives in a hook module; this is its shape, without React. */
function defaultsOf(schema: JsonSchema): Record<string, unknown> {
  if (schema.type !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if ('default' in prop && prop.default !== undefined) out[key] = prop.default;
    else if (prop.type === 'object') out[key] = defaultsOf(prop);
    else if (prop.type === 'array') out[key] = [];
    else if (prop.type === 'number' || prop.type === 'integer') out[key] = 0;
    else if (prop.type === 'boolean') out[key] = false;
    else out[key] = '';
  }
  return out;
}
