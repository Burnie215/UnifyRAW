import { describe, expect, it, vi } from 'vitest';
import { FakeGl, asGl } from './__testHelpers';
import { GraphCompiler } from './GraphCompiler';
import { NodeRegistry } from './NodeRegistry';
import { registerBuiltinConverts } from './builtins';
import { ProgramCache } from './ProgramCache';
import { FboPool } from './FboPool';
import { PipelineExecutor, ExecuteError, __internals } from './PipelineExecutor';
import type {
  CompiledPlan,
  Edge,
  Geometry,
  JsonSchema,
  NodeKindSpec,
  RenderGraph,
  RenderNode,
} from './types';

const numberSchema: JsonSchema = { type: 'number', default: 0 };
const G_2x2: Geometry = { width: 2, height: 2, pixelRatio: 1 };

function srcKind(spec: Partial<NodeKindSpec> = {}): NodeKindSpec {
  return {
    kind: 'src',
    category: 'source',
    inputPorts: [],
    outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
    paramSchema: numberSchema,
    inputSpace: 'linear',
    outputSpace: 'linear',
    requiresFloat: false,
    samplesNeighbors: false,
    isIdentity: () => false,
    isAsync: false,
    outputGeometry: () => G_2x2,
    uploadSource: vi.fn(),
    ...spec,
  };
}

function adjKind(spec: Partial<NodeKindSpec> & Pick<NodeKindSpec, 'kind'>): NodeKindSpec {
  return {
    category: 'adjustment',
    inputPorts: [{ id: 'in', type: 'color', space: 'linear' }],
    outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
    paramSchema: numberSchema,
    fragmentShader: '#version 300 es\nprecision highp float; out vec4 c; void main() { c = vec4(1); }',
    inputSpace: 'linear',
    outputSpace: 'linear',
    requiresFloat: false,
    samplesNeighbors: false,
    isIdentity: () => false,
    isAsync: false,
    ...spec,
  };
}

function makeGraph(nodes: RenderNode[], edges: Edge[], output: string): RenderGraph {
  return {
    id: 'g',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges,
    output,
    metadata: { createdAt: 0, updatedAt: 0, revision: 1 },
  };
}

// ─── ProgramCache ────────────────────────────────────────────────

describe('ProgramCache', () => {
  it('compiles and caches per-kind', () => {
    const gl = new FakeGl();
    const cache = new ProgramCache(asGl(gl));
    const k = adjKind({ kind: 'k1' });
    const p1 = cache.getOrCompile(k);
    const p2 = cache.getOrCompile(k);
    expect(p1).toBe(p2);
    expect(cache.size()).toBe(1);
    expect(gl.findCalls('createProgram')).toHaveLength(1);
  });

  it('returns undefined for kinds without fragment shader', () => {
    const gl = new FakeGl();
    const cache = new ProgramCache(asGl(gl));
    const k = srcKind(); // no fragmentShader
    expect(cache.getOrCompile(k)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('throws ProgramCompileError on link failure', () => {
    const gl = new FakeGl({ linkSuccess: false });
    const cache = new ProgramCache(asGl(gl));
    const k = adjKind({ kind: 'broken' });
    expect(() => cache.getOrCompile(k)).toThrow(/Program compile failed.*broken.*link/);
  });

  it('caches uniform locations', () => {
    const gl = new FakeGl();
    const cache = new ProgramCache(asGl(gl));
    const k = adjKind({ kind: 'k1' });
    cache.getUniformLocation(k, 'u_x');
    cache.getUniformLocation(k, 'u_x');
    expect(gl.findCalls('getUniformLocation').filter((c) => c.args[1] === 'u_x')).toHaveLength(1);
  });

  it('release deletes all programs', () => {
    const gl = new FakeGl();
    const cache = new ProgramCache(asGl(gl));
    cache.getOrCompile(adjKind({ kind: 'k1' }));
    cache.getOrCompile(adjKind({ kind: 'k2' }));
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(gl.findCalls('deleteProgram')).toHaveLength(2);
  });
});

// ─── FboPool ──────────────────────────────────────────────────────

describe('FboPool', () => {
  function tinyPlan(): CompiledPlan {
    return {
      graphId: 'g',
      graphRevision: 1,
      augmentedNodes: new Map(),
      augmentedEdges: [],
      output: 'S',
      topologicalOrder: ['S'],
      perNodeFbo: new Map([['S', { poolIndex: 0, format: 'rgba8', geometry: G_2x2 }]]),
      insertedConverts: [],
      insertedTaps: [],
      taps: new Map(),
      identitySkips: new Set(),
      segments: [{ nodes: ['S'], fboFormat: 'rgba8', geometry: G_2x2 }],
      asyncDependencies: new Map(),
    };
  }

  it('allocates the requested slot count per segment', () => {
    const gl = new FakeGl();
    const pool = new FboPool(asGl(gl));
    const plan: CompiledPlan = {
      ...tinyPlan(),
      segments: [
        { nodes: ['A', 'B'], fboFormat: 'rgba8', geometry: G_2x2 },
        { nodes: ['C'], fboFormat: 'rgba16f', geometry: G_2x2 },
      ],
    };
    pool.build(plan, [3, 1]);
    expect(gl.findCalls('createFramebuffer')).toHaveLength(4);
    expect(gl.findCalls('createTexture')).toHaveLength(4);
  });

  it('allocates nothing for fully-skipped segments (e.g. taps)', () => {
    const gl = new FakeGl();
    const pool = new FboPool(asGl(gl));
    const plan: CompiledPlan = {
      ...tinyPlan(),
      segments: [
        { nodes: ['A'], fboFormat: 'rgba8', geometry: G_2x2 },
        { nodes: ['__tap_1'], fboFormat: 'rgba8', geometry: G_2x2 },
      ],
    };
    pool.build(plan, [2, 0]);
    expect(gl.findCalls('createFramebuffer')).toHaveLength(2);
    expect(() => pool.fboForNode('__tap_1', 0)).toThrow(/no slot/);
  });

  it('release deletes all allocated resources', () => {
    const gl = new FakeGl();
    const pool = new FboPool(asGl(gl));
    pool.build(tinyPlan(), [1]);
    pool.release();
    expect(gl.findCalls('deleteFramebuffer').length).toBeGreaterThan(0);
    expect(gl.findCalls('deleteTexture').length).toBeGreaterThan(0);
  });

  it('reuses GL objects across builds with unchanged segment structure', () => {
    const gl = new FakeGl();
    const pool = new FboPool(asGl(gl));
    const plan = tinyPlan();
    pool.build(plan, [2]);
    const created = gl.findCalls('createFramebuffer').length;
    pool.build(plan, [2]);
    expect(gl.findCalls('createFramebuffer')).toHaveLength(created);
    expect(gl.findCalls('deleteFramebuffer')).toHaveLength(0);
    // Structure change (format) → full realloc.
    const changed: CompiledPlan = {
      ...plan,
      segments: [{ nodes: ['S'], fboFormat: 'rgba16f', geometry: G_2x2 }],
    };
    pool.build(changed, [2]);
    expect(gl.findCalls('createFramebuffer').length).toBeGreaterThan(created);
    expect(gl.findCalls('deleteFramebuffer').length).toBeGreaterThan(0);
  });

  it('throws when looking up an unknown node', () => {
    const gl = new FakeGl();
    const pool = new FboPool(asGl(gl));
    pool.build(tinyPlan(), [2]);
    expect(() => pool.fboForNode('ghost', 0)).toThrow(/no segment/);
  });

  it('fails closed when an RGBA16F framebuffer is incomplete', () => {
    const gl = new FakeGl({ framebufferStatus: 0x8CD6 });
    const pool = new FboPool(asGl(gl));
    const plan: CompiledPlan = {
      ...tinyPlan(),
      segments: [{ nodes: ['S'], fboFormat: 'rgba16f', geometry: G_2x2 }],
    };
    expect(() => pool.build(plan, [1])).toThrow(/RGBA16F framebuffer incomplete.*8cd6/);
    expect(gl.findCalls('deleteFramebuffer')).toHaveLength(1);
    expect(gl.findCalls('deleteTexture')).toHaveLength(1);
  });
});

// ─── PipelineExecutor ────────────────────────────────────────────

describe('PipelineExecutor', () => {
  async function compile(graph: RenderGraph, registry: NodeRegistry) {
    return new GraphCompiler(registry).compile(graph);
  }

  it('executes an identity terminal shader when a 16F terminal was requested', async () => {
    const source = srcKind();
    const identity = adjKind({ kind: 'identity-terminal', isIdentity: () => true });
    const registry = new NodeRegistry();
    registry.register(source);
    registry.register(identity);
    registerBuiltinConverts(registry);
    const graph = makeGraph(
      [{ id: 'S', kind: 'src', params: {} }, { id: 'I', kind: 'identity-terminal', params: {} }],
      [{ id: 'e', from: { node: 'S', port: 'out' }, to: { node: 'I', port: 'in' } }],
      'I',
    );
    const plan = await new GraphCompiler(registry).compile(graph, { terminalFormat: 'rgba16f' });
    expect(plan.identitySkips.has('I')).toBe(true);

    const gl = new FakeGl();
    const exec = new PipelineExecutor(asGl(gl), registry);
    exec.bindExternalData('S', { dummy: true });
    await exec.execute(plan);
    expect(gl.findCalls('drawArrays')).toHaveLength(1);
  });

  it('awaits async dependencies before running nodes', async () => {
    let prepareResolved = false;
    const asyncSrc = srcKind({
      kind: 'asyncSrc',
      isAsync: true,
      prepare: () => new Promise<void>((r) => setTimeout(() => { prepareResolved = true; r(); }, 5)),
    });
    const registry = new NodeRegistry();
    registry.register(asyncSrc);
    registerBuiltinConverts(registry);
    const graph = makeGraph([{ id: 'S', kind: 'asyncSrc', params: {} }], [], 'S');
    const plan = await compile(graph, registry);

    const gl = new FakeGl();
    const exec = new PipelineExecutor(asGl(gl), registry);
    exec.bindExternalData('S', { dummy: true });
    await exec.execute(plan);
    expect(prepareResolved).toBe(true);
  });

  it('throws ExecuteError when async prepare fails', async () => {
    const asyncSrc = srcKind({
      kind: 'asyncBoom',
      isAsync: true,
      prepare: () => Promise.reject(new Error('nope')),
    });
    const registry = new NodeRegistry();
    registry.register(asyncSrc);
    registerBuiltinConverts(registry);
    const graph = makeGraph([{ id: 'S', kind: 'asyncBoom', params: {} }], [], 'S');
    const plan = await compile(graph, registry);

    const gl = new FakeGl();
    const exec = new PipelineExecutor(asGl(gl), registry);
    exec.bindExternalData('S', { dummy: true });
    await expect(exec.execute(plan)).rejects.toThrow(/async prepare.*'S'.*nope/);
  });

  it('calls uploadSource for source nodes with bound external data', async () => {
    const upload = vi.fn();
    const src = srcKind({ kind: 'src', uploadSource: upload });
    const registry = new NodeRegistry();
    registry.register(src);
    registerBuiltinConverts(registry);
    const graph = makeGraph([{ id: 'S', kind: 'src', params: {} }], [], 'S');
    const plan = await compile(graph, registry);

    const gl = new FakeGl();
    const exec = new PipelineExecutor(asGl(gl), registry);
    exec.bindExternalData('S', { mark: 'data' });
    await exec.execute(plan);
    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0][3]).toEqual({ mark: 'data' });
  });

  it('throws when source has no bound external data', async () => {
    const src = srcKind({ kind: 'src' });
    const registry = new NodeRegistry();
    registry.register(src);
    registerBuiltinConverts(registry);
    const graph = makeGraph([{ id: 'S', kind: 'src', params: {} }], [], 'S');
    const plan = await compile(graph, registry);

    const gl = new FakeGl();
    const exec = new PipelineExecutor(asGl(gl), registry);
    await expect(exec.execute(plan)).rejects.toThrow(/no bound external data/);
  });

  it('runs shader pass + bindUniforms in topo order', async () => {
    const bindS = vi.fn();
    const bindA = vi.fn();
    const bindB = vi.fn();
    const src = srcKind({ kind: 'src', uploadSource: vi.fn() });
    void bindS; // src is a source — uses uploadSource, not bindUniforms
    const a = adjKind({ kind: 'a', bindUniforms: bindA });
    const b = adjKind({ kind: 'b', bindUniforms: bindB });
    const registry = new NodeRegistry();
    [src, a, b].forEach((k) => registry.register(k));
    registerBuiltinConverts(registry);
    const graph = makeGraph(
      [
        { id: 'S', kind: 'src', params: {} },
        { id: 'A', kind: 'a', params: { exposure: 0.5 } },
        { id: 'B', kind: 'b', params: {} },
      ],
      [
        { id: 'e1', from: { node: 'S', port: 'out' }, to: { node: 'A', port: 'in' } },
        { id: 'e2', from: { node: 'A', port: 'out' }, to: { node: 'B', port: 'in' } },
      ],
      'B',
    );
    const plan = await compile(graph, registry);

    const gl = new FakeGl();
    const exec = new PipelineExecutor(asGl(gl), registry);
    exec.bindExternalData('S', {});
    await exec.execute(plan);

    expect(bindA).toHaveBeenCalledOnce();
    expect(bindA.mock.calls[0][2]).toEqual({ exposure: 0.5 });
    expect(bindB).toHaveBeenCalledOnce();
    // Order: A bound before B (topo)
    expect(bindA.mock.invocationCallOrder[0]).toBeLessThan(bindB.mock.invocationCallOrder[0]);
    // Two shader passes -> two drawArrays
    expect(gl.findCalls('drawArrays')).toHaveLength(2);
  });

  it('uses paramsByNode override when provided', async () => {
    const bindA = vi.fn();
    const src = srcKind({ kind: 'src', uploadSource: vi.fn() });
    const a = adjKind({ kind: 'a', bindUniforms: bindA });
    const registry = new NodeRegistry();
    [src, a].forEach((k) => registry.register(k));
    registerBuiltinConverts(registry);
    const graph = makeGraph(
      [
        { id: 'S', kind: 'src', params: {} },
        { id: 'A', kind: 'a', params: { value: 'stale' } },
      ],
      [{ id: 'e1', from: { node: 'S', port: 'out' }, to: { node: 'A', port: 'in' } }],
      'A',
    );
    const plan = await compile(graph, registry);

    const gl = new FakeGl();
    const exec = new PipelineExecutor(asGl(gl), registry);
    exec.bindExternalData('S', {});
    const overrides = new Map<string, unknown>([['A', { value: 'live' }]]);
    await exec.execute(plan, overrides);
    expect(bindA.mock.calls[0][2]).toEqual({ value: 'live' });
  });

  it('skips identity nodes (no drawArrays issued for them)', async () => {
    const bindA = vi.fn();
    const bindB = vi.fn();
    const src = srcKind({ kind: 'src', uploadSource: vi.fn() });
    const a = adjKind({ kind: 'a', bindUniforms: bindA, isIdentity: () => true });
    const b = adjKind({ kind: 'b', bindUniforms: bindB });
    const registry = new NodeRegistry();
    [src, a, b].forEach((k) => registry.register(k));
    registerBuiltinConverts(registry);
    const graph = makeGraph(
      [
        { id: 'S', kind: 'src', params: {} },
        { id: 'A', kind: 'a', params: {} },
        { id: 'B', kind: 'b', params: {} },
      ],
      [
        { id: 'e1', from: { node: 'S', port: 'out' }, to: { node: 'A', port: 'in' } },
        { id: 'e2', from: { node: 'A', port: 'out' }, to: { node: 'B', port: 'in' } },
      ],
      'B',
    );
    const plan = await compile(graph, registry);

    const gl = new FakeGl();
    const exec = new PipelineExecutor(asGl(gl), registry);
    exec.bindExternalData('S', {});
    await exec.execute(plan);

    expect(bindA).not.toHaveBeenCalled();
    expect(bindB).toHaveBeenCalledOnce();
    // Only B's shader actually draws.
    expect(gl.findCalls('drawArrays')).toHaveLength(1);
  });

  it('exposes tap textures by label', async () => {
    const src = srcKind({ kind: 'src', uploadSource: vi.fn() });
    const a = adjKind({ kind: 'a' });
    const registry = new NodeRegistry();
    [src, a].forEach((k) => registry.register(k));
    registerBuiltinConverts(registry);
    const graph = makeGraph(
      [
        { id: 'S', kind: 'src', params: {} },
        { id: 'A', kind: 'a', params: {} },
      ],
      [{ id: 'e1', from: { node: 'S', port: 'out' }, to: { node: 'A', port: 'in' } }],
      'A',
    );
    const plan = await new GraphCompiler(registry).compile(graph, {
      captureAfter: [{ nodeId: 'A', label: 'final-snapshot' }],
    });

    const gl = new FakeGl();
    const exec = new PipelineExecutor(asGl(gl), registry);
    exec.bindExternalData('S', {});
    const result = await exec.execute(plan);
    expect(result.taps.has('final-snapshot')).toBe(true);
  });
});

// ─── Internal helpers ─────────────────────────────────────────────

describe('PipelineExecutor internals', () => {
  it('resolveUpstream walks through identity nodes', () => {
    const skips = new Set(['A', 'B']);
    const preds = new Map([['A', 'S'], ['B', 'A'], ['C', 'B']]);
    expect(__internals.resolveUpstream('C', skips, preds)).toBe('S');
  });

  it('buildPredecessorIndex collects single-input predecessors', () => {
    const plan: CompiledPlan = {
      graphId: 'g', graphRevision: 1,
      augmentedNodes: new Map(),
      augmentedEdges: [
        { id: 'e1', from: { node: 'A', port: 'out' }, to: { node: 'B', port: 'in' } },
        { id: 'e2', from: { node: 'B', port: 'out' }, to: { node: 'C', port: 'in' } },
      ],
      output: 'C',
      topologicalOrder: [],
      perNodeFbo: new Map(),
      insertedConverts: [], insertedTaps: [],
      taps: new Map(),
      identitySkips: new Set(),
      segments: [],
      asyncDependencies: new Map(),
    };
    const preds = __internals.buildPredecessorIndex(plan);
    expect(preds.get('B')).toBe('A');
    expect(preds.get('C')).toBe('B');
  });
});

// ─── Runtime FBO liveness (fan-out) ───────────────────────────────

describe('computeRuntimeFboMap liveness', () => {
  async function compileLayered() {
    const { buildLayeredGraph } = await import('./DefaultGraphBuilder');
    const { registerBuiltinSources } = await import('./sources');
    const { registerBuiltinPassKinds } = await import('./passKinds');
    const { registerBuiltinCompositors } = await import('./compositorKinds');
    const { registerBuiltinMaskKinds } = await import('./maskKinds');
    const { registerBuiltinLutKinds } = await import('./lutKinds');
    const registry = new NodeRegistry();
    registerBuiltinConverts(registry);
    registerBuiltinSources(registry);
    registerBuiltinPassKinds(registry);
    registerBuiltinCompositors(registry);
    registerBuiltinMaskKinds(registry);
    registerBuiltinLutKinds(registry);

    const { graph } = buildLayeredGraph(
      { exposure: 50, clarity: 20 },
      [{ id: 'L1', adjustments: { shadows: 30 }, opacity: 1, blendMode: 'normal' }],
      { kind: 'imageBitmap', geometry: { width: 64, height: 48, pixelRatio: 1 } },
    );
    const plan = await new GraphCompiler(registry).compile(graph);
    return { plan, registry };
  }

  it('never recycles a producer FBO before its last consumer ran, never assigns read==write', async () => {
    const { plan, registry } = await compileLayered();
    const preds = __internals.buildPredecessorIndex(plan);
    const secs = __internals.buildSecondaryPredecessorIndex(plan);
    const skips = __internals.computeEffectiveSkips(plan, undefined, registry);
    const { bindings, slotCounts } = __internals.computeRuntimeFboMap(
      plan, skips, registry, preds, secs,
    );

    const segOfNode = new Map<string, number>();
    plan.segments.forEach((seg, i) => seg.nodes.forEach((n) => segOfNode.set(n, i)));
    const isActive = (id: string) => {
      const kind = registry.get(plan.augmentedNodes.get(id)!.kind);
      return kind?.category === 'source' || kind?.category === 'decoder' || !skips.has(id);
    };
    const inputsOf = (id: string): string[] => {
      const set = new Set<string>();
      const p = __internals.resolveUpstream(id, skips, preds);
      if (p) set.add(p);
      const sec = secs.get(id);
      if (sec) {
        for (const prod of sec.values()) {
          set.add(__internals.resolveEffectiveProducer(prod, skips, preds));
        }
      }
      return [...set];
    };
    const slotKey = (id: string) => {
      const b = bindings.get(id);
      expect(b, `binding for ${id}`).toBeDefined();
      return `${segOfNode.get(id)}:${b!.poolIndex}`;
    };

    // Simulate the execution walk: every input's slot must still be owned
    // by that input when a node runs, and a node never writes a slot it reads.
    const owner = new Map<string, string>();
    let sawFanOut = false;
    for (const id of plan.topologicalOrder) {
      if (!isActive(id)) continue;
      const inputs = inputsOf(id);
      if (inputs.length > 1) sawFanOut = true;
      for (const input of inputs) {
        expect(owner.get(slotKey(input)), `node ${id} reads ${input}`).toBe(input);
        expect(slotKey(input), `node ${id} must not write its input slot`).not.toBe(slotKey(id));
      }
      owner.set(slotKey(id), id);
    }
    // The layered graph really exercises multi-input nodes (compositor).
    expect(sawFanOut).toBe(true);

    // Terminal output survives to the end of the walk.
    const effOut = __internals.resolveEffectiveProducer(plan.output, skips, preds);
    expect(owner.get(slotKey(effOut))).toBe(effOut);

    // Every assigned slot index is covered by the reported slot counts.
    for (const [id, b] of bindings) {
      expect(b.poolIndex).toBeLessThan(slotCounts[segOfNode.get(id)!]);
    }
  });

  it('identity-skipped secondary producers resolve to a bound ancestor', async () => {
    const { plan, registry } = await compileLayered();
    const preds = __internals.buildPredecessorIndex(plan);
    const secs = __internals.buildSecondaryPredecessorIndex(plan);
    const skips = __internals.computeEffectiveSkips(plan, undefined, registry);
    const { bindings } = __internals.computeRuntimeFboMap(plan, skips, registry, preds, secs);

    for (const [nodeId, ports] of secs) {
      if (skips.has(nodeId)) continue;
      for (const producerId of ports.values()) {
        const eff = __internals.resolveEffectiveProducer(producerId, skips, preds);
        expect(bindings.has(eff), `effective producer ${eff} for ${nodeId}`).toBe(true);
      }
    }
  });
});

// Silence unused-import linter for ExecuteError; it's part of the public surface.
void ExecuteError;
