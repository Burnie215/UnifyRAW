/**
 * Custom-LUT-Node tests: param-schema sanity + .cube file parser.
 *
 * Real-GL shader output is covered indirectly via the registry +
 * GraphCompiler suites (kind compiles, ports validate). The .cube parser
 * is pure-text and gets its own unit tests here.
 *
 * The identity cases are F074: a node dropped from the library carries
 * `samples: []` (that is what `defaultParamsForSchema` hands out), and a
 * shader sampling an empty LUT texture renders black. Until a `.cube` file has
 * fed it, the node is a placeholder and the compiler skips it.
 */
import { describe, expect, it } from 'vitest';
import {
  parseCubeFile, KIND_CUSTOM_LUT, registerBuiltinLutKinds,
  MAX_INLINE_LUT_SIZE, MIN_LUT_SAMPLES, lutSampleCount,
} from './lutKinds';
import { NodeRegistry } from './NodeRegistry';
import { graphContentHash } from './graphContentKey';
import { buildDefaultGraph } from './DefaultGraphBuilder';
import { insertAfter, SDR } from './projection/projectionFixtures';
import { hydrateGraph, serializeGraph } from './serialize';

describe('parseCubeFile', () => {
  it('parses a minimal 2×2×2 cube', () => {
    const text = `TITLE "Tiny"
LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;
    const lut = parseCubeFile(text);
    expect(lut.size).toBe(2);
    expect(lut.samples.length).toBe(8 * 3);
    expect(Array.from(lut.samples.slice(0, 6))).toEqual([0, 0, 0, 1, 0, 0]);
  });

  it('skips comments + DOMAIN headers', () => {
    const text = `# header comment
LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 1 1 1
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;
    expect(() => parseCubeFile(text)).not.toThrow();
  });

  it('throws on missing LUT_3D_SIZE', () => {
    expect(() => parseCubeFile('0 0 0\n1 1 1\n')).toThrow(/LUT_3D_SIZE/);
  });

  it('throws when sample count does not match size^3', () => {
    const text = `LUT_3D_SIZE 2
0 0 0
1 1 1
`;
    expect(() => parseCubeFile(text)).toThrow(/expected 8 samples, got 2/);
  });
});

describe('customLutKind registration', () => {
  it('registers under KIND_CUSTOM_LUT and survives re-registration', () => {
    const r = new NodeRegistry();
    registerBuiltinLutKinds(r);
    expect(r.has(KIND_CUSTOM_LUT)).toBe(true);
    // replace() is idempotent — Phase 1 contract for hot-reload safety.
    expect(() => registerBuiltinLutKinds(r)).not.toThrow();
  });

  it('isIdentity at amount=0', () => {
    const kind = lutKind();
    const identitySamples = new Float32Array(2 * 2 * 2 * 3);
    expect(kind.isIdentity({ size: 2, samples: identitySamples, amount: 0 })).toBe(true);
    expect(kind.isIdentity({ size: 2, samples: identitySamples, amount: 0.5 })).toBe(false);
  });
});

function lutKind() {
  const r = new NodeRegistry();
  registerBuiltinLutKinds(r);
  return r.require(KIND_CUSTOM_LUT);
}

const TINY_CUBE = `LUT_3D_SIZE 2
0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`;

describe('a custom LUT without a file', () => {
  it('is identity, so a freshly dropped node leaves the picture alone', () => {
    const kind = lutKind();
    // Exactly what `defaultParamsForSchema` produces from the schema.
    expect(kind.isIdentity({ size: 33, samples: [] as unknown as Float32Array, amount: 1 })).toBe(true);
    expect(kind.isIdentity({ size: 33, samples: undefined as unknown as Float32Array, amount: 1 })).toBe(true);
  });

  it('stops being identity the moment a parsed file is in', () => {
    const kind = lutKind();
    const { size, samples } = parseCubeFile(TINY_CUBE);
    expect(samples.length).toBe(MIN_LUT_SAMPLES);
    expect(kind.isIdentity({ size, samples, amount: 1 })).toBe(false);
    // And through the document's JSON, where the Float32Array becomes an array.
    expect(kind.isIdentity({
      size, samples: Array.from(samples) as unknown as Float32Array, amount: 1,
    })).toBe(false);
  });

  it('counts samples in either spelling', () => {
    expect(lutSampleCount(new Float32Array(24))).toBe(24);
    expect(lutSampleCount(new Array(24).fill(0))).toBe(24);
    expect(lutSampleCount([])).toBe(0);
    expect(lutSampleCount(undefined)).toBe(0);
  });

  it('caps what the inspector may bake into the edit', () => {
    // 33^3 x 3 numbers ride in every stored revision; 65^3 would be eight
    // times that. The inspector refuses above this.
    expect(MAX_INLINE_LUT_SIZE).toBe(33);
  });
});

describe('a loaded LUT survives the document', () => {
  it('comes back out of the stored JSON as the same samples', () => {
    const { size, samples } = parseCubeFile(TINY_CUBE);
    const graph = insertAfter(
      buildDefaultGraph({}, SDR).graph,
      'default:tone',
      'user:customLut',
      KIND_CUSTOM_LUT,
      // What the inspector writes: a plain array, because this is the shape
      // that goes through JSON unchanged. A Float32Array comes back out as an
      // object with numeric keys and the node would render black again.
      { size, samples: Array.from(samples), amount: 1 },
    );
    const stored = JSON.parse(JSON.stringify(serializeGraph(graph)));
    const back = hydrateGraph(stored).nodes.get('user:customLut')!;
    const params = back.params as { size: number; samples: number[]; amount: number };
    expect(params.size).toBe(2);
    expect(params.samples).toEqual(Array.from(samples));
    expect(lutKind().isIdentity(params)).toBe(false);
  });
});

describe('the LUT samples are part of the graph identity', () => {
  // Third time this trap is set: `PipelineService.compile` caches plans by
  // `graph.id`, so anything baked into a node's params has to reach that id.
  // It did for the geometry, then for the output colour space, then for the
  // retouch spots - and a LUT is exactly that kind of baked-in payload.
  const withLut = (samples: number[] | Float32Array) => insertAfter(
    buildDefaultGraph({}, SDR).graph,
    'default:tone',
    'user:customLut',
    KIND_CUSTOM_LUT,
    { size: 2, samples, amount: 1 },
  );

  it('changes the content hash when the file changes', () => {
    const a = Array.from(parseCubeFile(TINY_CUBE).samples);
    const b = [...a];
    b[0] = 0.5;
    expect(graphContentHash(withLut(a))).not.toBe(graphContentHash(withLut(b)));
  });

  it('changes the content hash when the file arrives at all', () => {
    const loaded = Array.from(parseCubeFile(TINY_CUBE).samples);
    expect(graphContentHash(withLut([]))).not.toBe(graphContentHash(withLut(loaded)));
  });

  it('hashes a shared samples payload only once across rebuilt graphs', () => {
    let sampleReads = 0;
    const samples = new Proxy(Array.from(parseCubeFile(TINY_CUBE).samples), {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) sampleReads++;
        return Reflect.get(target, property, receiver);
      },
    });

    const first = graphContentHash(withLut(samples));
    expect(sampleReads).toBeGreaterThan(0);
    sampleReads = 0;

    // Hydrating a document rebuilds its graph wrappers but keeps authored
    // params, including this samples array, by reference.
    expect(graphContentHash(withLut(samples))).toBe(first);
    expect(sampleReads).toBe(0);
  });

  it('freezes a cached plain array so an in-place edit cannot stale its hash', () => {
    const samples = Array.from(parseCubeFile(TINY_CUBE).samples);
    const originalFirst = samples[0];
    const hash = graphContentHash(withLut(samples));

    expect(Object.isFrozen(samples)).toBe(true);
    expect(() => { samples[0] = 0.5; }).toThrow(TypeError);
    expect(samples[0]).toBe(originalFirst);
    expect(graphContentHash(withLut(samples))).toBe(hash);
  });

  it('does not cache a mutable typed array', () => {
    const samples = parseCubeFile(TINY_CUBE).samples;
    const before = graphContentHash(withLut(samples));

    expect(Object.isFrozen(samples)).toBe(false);
    samples[0] = 0.5;

    expect(graphContentHash(withLut(samples))).not.toBe(before);
  });

  it('does not collapse distinct LUTs that collide under the old inner FNV32', () => {
    const a = [
      0.97603764, 0, 0, 0, 0, 0, 0, 0.14169219, 0, 0, 0, 0,
      0, 0, 0, 0.76522374, 0, 0, 0, 0, 0, 0, 0, 0.79173933,
    ];
    const b = [
      0.42276044, 0, 0, 0, 0, 0, 0, 0.39797051, 0, 0, 0, 0,
      0, 0, 0, 0.84999646, 0, 0, 0, 0, 0, 0, 0, 0.20123301,
    ];

    expect(JSON.stringify(a)).toHaveLength(JSON.stringify(b).length);
    expect(graphContentHash(withLut(a))).not.toBe(graphContentHash(withLut(b)));
  });
});
