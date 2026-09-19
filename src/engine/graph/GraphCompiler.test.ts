import { describe, expect, it } from 'vitest';
import { GraphCompiler, CompileError } from './GraphCompiler';
import { NodeRegistry } from './NodeRegistry';
import {
  registerBuiltinConverts,
  KIND_CONVERT_LIN_TO_GAMMA,
  KIND_CONVERT_GAMMA_TO_LIN,
} from './builtins';
import type {
  Edge,
  Geometry,
  JsonSchema,
  NodeKindSpec,
  RenderGraph,
  RenderNode,
} from './types';

// ─── Test fixtures ────────────────────────────────────────────────

const numberSchema: JsonSchema = { type: 'number', default: 0 };

function makeKind(spec: Partial<NodeKindSpec> & Pick<NodeKindSpec, 'kind' | 'category'>): NodeKindSpec {
  return {
    inputPorts: [],
    outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
    paramSchema: numberSchema,
    inputSpace: 'linear',
    outputSpace: 'linear',
    requiresFloat: false,
    samplesNeighbors: false,
    isIdentity: () => false,
    isAsync: false,
    ...spec,
  };
}

function makeNode(id: string, kind: string, params: unknown = {}): RenderNode {
  return { id, kind, params };
}

function makeEdge(id: string, fromNode: string, toNode: string, fromPort = 'out', toPort = 'in'): Edge {
  return { id, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } };
}

function makeGraph(nodes: RenderNode[], edges: Edge[], output: string): RenderGraph {
  return {
    id: 'test-graph',
    nodes: new Map(nodes.map((n) => [n.id, n])),
    edges,
    output,
    metadata: { createdAt: 0, updatedAt: 0, revision: 1 },
  };
}

function srcKindWithGeom(geom: Geometry): NodeKindSpec {
  return makeKind({
    kind: 'src',
    category: 'source',
    outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
    outputGeometry: () => geom,
  });
}

function adjKind(opts: { kind: string; samplesNeighbors?: boolean; identity?: boolean }): NodeKindSpec {
  return makeKind({
    kind: opts.kind,
    category: 'adjustment',
    inputPorts: [{ id: 'in', type: 'color', space: 'linear' }],
    outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
    samplesNeighbors: opts.samplesNeighbors ?? false,
    isIdentity: () => opts.identity ?? false,
  });
}

function makeRegistry(kinds: NodeKindSpec[]): NodeRegistry {
  const r = new NodeRegistry();
  for (const k of kinds) r.register(k);
  return r;
}

const G_1x1: Geometry = { width: 1, height: 1, pixelRatio: 1 };

// ─── Tests ────────────────────────────────────────────────────────

describe('GraphCompiler', () => {
  describe('topological order', () => {
    it('linear chain: src -> a -> b -> out', async () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'a' }),
        adjKind({ kind: 'b' }),
      ]);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B')],
        'B',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.topologicalOrder).toEqual(['S', 'A', 'B']);
    });

    it('deterministic tie-break by id when multiple roots', async () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'merge' }), // doesn't really merge in phase-0 — but two roots exist
      ]);
      // Two source nodes both feeding into a multi-input adjustment. We don't
      // wire both since 'in' port has multiplicity 'one'; instead test two
      // *independent* roots with the output being one of them.
      const graph = makeGraph(
        [makeNode('Z', 'src'), makeNode('A', 'src')],
        [],
        'A',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      // Tie-break by id (alphabetic) puts 'A' first then 'Z'.
      expect(plan.topologicalOrder).toEqual(['A', 'Z']);
    });

    it('validate() reports CompileErrors synchronously instead of throwing', () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'a' }),
        adjKind({ kind: 'b' }),
      ]);
      const compiler = new GraphCompiler(registry);
      const cyclic = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B'), makeEdge('e3', 'B', 'A')],
        'B',
      );
      const err = compiler.validate(cyclic);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/cycle detected/);
      expect(err!.nodeIds).toContain('A');

      const valid = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a')],
        [makeEdge('e1', 'S', 'A')],
        'A',
      );
      expect(compiler.validate(valid)).toBeNull();
    });

    it('detects cycles with offending node ids', async () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'a' }),
        adjKind({ kind: 'b' }),
      ]);
      // S -> A -> B -> A (cycle)
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B'), makeEdge('e3', 'B', 'A')],
        'B',
      );
      await expect(new GraphCompiler(registry).compile(graph)).rejects.toThrow(/cycle detected/);
      try {
        await new GraphCompiler(registry).compile(graph);
      } catch (e) {
        const err = e as CompileError;
        expect(err.nodeIds).toContain('A');
        expect(err.nodeIds).toContain('B');
      }
    });
  });

  describe('edge resolution', () => {
    it('rejects dangling source node refs', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1), adjKind({ kind: 'a' })]);
      const graph = makeGraph(
        [makeNode('A', 'a')],
        [makeEdge('e1', 'GHOST', 'A')], // GHOST doesn't exist
        'A',
      );
      await expect(new GraphCompiler(registry).compile(graph))
        .rejects.toThrow(/missing source node 'GHOST'/);
    });

    it('rejects dangling target node refs', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1)]);
      const graph = makeGraph(
        [makeNode('S', 'src')],
        [makeEdge('e1', 'S', 'GHOST')],
        'S',
      );
      await expect(new GraphCompiler(registry).compile(graph))
        .rejects.toThrow(/missing.*node 'GHOST'/);
    });

    it('rejects missing output node', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1)]);
      const graph = makeGraph([makeNode('S', 'src')], [], 'NOT_HERE');
      await expect(new GraphCompiler(registry).compile(graph))
        .rejects.toThrow(/output node 'NOT_HERE'/);
    });
  });

  describe('edge type validation', () => {
    it('rejects mismatched port types', async () => {
      const srcMask = makeKind({
        kind: 'maskSrc',
        category: 'generator',
        outputPorts: [{ id: 'out', type: 'mask', space: 'linear' }],
        outputGeometry: () => G_1x1,
      });
      const registry = makeRegistry([srcMask, adjKind({ kind: 'a' })]);
      const graph = makeGraph(
        [makeNode('S', 'maskSrc'), makeNode('A', 'a')],
        [makeEdge('e1', 'S', 'A')], // mask -> color
        'A',
      );
      await expect(new GraphCompiler(registry).compile(graph))
        .rejects.toThrow(/type mismatch 'mask' -> 'color'/);
    });

    it('rejects unknown output port', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1), adjKind({ kind: 'a' })]);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a')],
        [makeEdge('e1', 'S', 'A', 'ghost-port', 'in')],
        'A',
      );
      await expect(new GraphCompiler(registry).compile(graph))
        .rejects.toThrow(/no output port 'ghost-port'/);
    });

    it('rejects unknown input port', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1), adjKind({ kind: 'a' })]);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a')],
        [makeEdge('e1', 'S', 'A', 'out', 'ghost-port')],
        'A',
      );
      await expect(new GraphCompiler(registry).compile(graph))
        .rejects.toThrow(/no input port 'ghost-port'/);
    });

    it('rejects multiplicity violation (port wanted exactly 1, got 0)', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1), adjKind({ kind: 'a' })]);
      const graph = makeGraph(
        [makeNode('A', 'a')],
        [],
        'A',
      );
      await expect(new GraphCompiler(registry).compile(graph))
        .rejects.toThrow(/expected exactly 1 incoming edge, got 0/);
    });
  });

  describe('color space compatibility', () => {
    it('allows either <-> linear', async () => {
      const eitherSrc = makeKind({
        kind: 'eitherSrc',
        category: 'source',
        outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
        outputGeometry: () => G_1x1,
      });
      const registry = makeRegistry([eitherSrc, adjKind({ kind: 'a' })]);
      const graph = makeGraph(
        [makeNode('S', 'eitherSrc'), makeNode('A', 'a')],
        [makeEdge('e1', 'S', 'A')],
        'A',
      );
      // Should not throw — 'either' is compatible with 'linear'.
      await expect(new GraphCompiler(registry).compile(graph)).resolves.toBeDefined();
    });

    it('rejects mixed-space graph if convert kinds are not registered', async () => {
      const gammaSink = makeKind({
        kind: 'gammaSink',
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'gamma' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
        inputSpace: 'gamma',
        outputSpace: 'gamma',
      });
      const registry = makeRegistry([srcKindWithGeom(G_1x1), gammaSink]);
      // No registerBuiltinConverts() call → compile must blow up loudly
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('G', 'gammaSink')],
        [makeEdge('e1', 'S', 'G')],
        'G',
      );
      await expect(new GraphCompiler(registry).compile(graph))
        .rejects.toThrow(/convert kinds are not registered/);
    });
  });

  describe('geometry propagation', () => {
    it('passes through input geometry to downstream nodes', async () => {
      const srcGeom: Geometry = { width: 800, height: 600, pixelRatio: 1 };
      const registry = makeRegistry([
        srcKindWithGeom(srcGeom),
        adjKind({ kind: 'a' }),
        adjKind({ kind: 'b' }),
      ]);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B')],
        'B',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.perNodeFbo.get('B')?.geometry).toEqual(srcGeom);
    });

    it('applies outputGeometry() hook for resizers', async () => {
      const srcGeom: Geometry = { width: 800, height: 600, pixelRatio: 1 };
      const halfRes = makeKind({
        kind: 'half',
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'linear' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
        outputGeometry: (geoms) => ({
          width: Math.floor(geoms[0].width / 2),
          height: Math.floor(geoms[0].height / 2),
          pixelRatio: geoms[0].pixelRatio,
        }),
      });
      const registry = makeRegistry([srcKindWithGeom(srcGeom), halfRes]);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('H', 'half')],
        [makeEdge('e1', 'S', 'H')],
        'H',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      // Different geometries split into two segments; H ends up in the second.
      expect(plan.perNodeFbo.get('H')?.geometry).toEqual({ width: 400, height: 300, pixelRatio: 1 });
    });
  });

  describe('identity skip', () => {
    it('records identity nodes for the executor to skip', async () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'a', identity: true }),
        adjKind({ kind: 'b', identity: false }),
      ]);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B')],
        'B',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.identitySkips.has('A')).toBe(true);
      expect(plan.identitySkips.has('B')).toBe(false);
      // Skip list does not affect topological order — that's a runtime decision.
      expect(plan.topologicalOrder).toEqual(['S', 'A', 'B']);
    });

    it('treats a throwing isIdentity() as non-identity', async () => {
      const grumpy = makeKind({
        kind: 'grumpy',
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'linear' }],
        isIdentity: () => { throw new Error('whoops'); },
      });
      const registry = makeRegistry([srcKindWithGeom(G_1x1), grumpy]);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('G', 'grumpy')],
        [makeEdge('e1', 'S', 'G')],
        'G',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.identitySkips.has('G')).toBe(false);
    });
  });

  describe('convert insertion', () => {
    function gammaKind(kind: string): NodeKindSpec {
      return makeKind({
        kind,
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'gamma' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
        inputSpace: 'gamma',
        outputSpace: 'gamma',
      });
    }

    it('inserts linToGamma when linear producer feeds gamma consumer', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1), gammaKind('g')]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('G', 'g')],
        [makeEdge('e1', 'S', 'G')],
        'G',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      // Synthetic convert node is in the topology now.
      expect(plan.topologicalOrder.length).toBe(3);
      const convertId = plan.topologicalOrder.find((id) => id.startsWith('__convert_'));
      expect(convertId).toBeDefined();
      // Original edge replaced by pre/post edges.
      expect(plan.insertedConverts).toHaveLength(2);
      expect(plan.insertedConverts[0].id).toMatch(/__pre$/);
      expect(plan.insertedConverts[1].id).toMatch(/__post$/);
    });

    it('inserts gammaToLin when gamma producer feeds linear consumer', async () => {
      const gammaSrc = makeKind({
        kind: 'gsrc',
        category: 'source',
        outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
        inputSpace: 'gamma',
        outputSpace: 'gamma',
        outputGeometry: () => G_1x1,
      });
      const registry = makeRegistry([gammaSrc, adjKind({ kind: 'a' })]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'gsrc'), makeNode('A', 'a')],
        [makeEdge('e1', 'S', 'A')],
        'A',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      const convertNodeIds = plan.topologicalOrder.filter((id) => id.startsWith('__convert_'));
      expect(convertNodeIds).toHaveLength(1);
      // The kind of the inserted convert should be gammaToLin
      // (peek via segments — convert node sits between S and A).
      const segIdx = plan.segments.findIndex((s) => s.nodes.includes(convertNodeIds[0]));
      expect(segIdx).toBeGreaterThanOrEqual(0);
    });

    it('does not insert when spaces already match', async () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'a' }),
        adjKind({ kind: 'b' }),
      ]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B')],
        'B',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.insertedConverts).toHaveLength(0);
      expect(plan.topologicalOrder).toEqual(['S', 'A', 'B']);
    });

    it("resolves 'either' against neighbours without inserting", async () => {
      const eitherKind = makeKind({
        kind: 'either',
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
        inputSpace: 'either',
        outputSpace: 'either',
      });
      const registry = makeRegistry([srcKindWithGeom(G_1x1), eitherKind, adjKind({ kind: 'a' })]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('E', 'either'), makeNode('A', 'a')],
        [makeEdge('e1', 'S', 'E'), makeEdge('e2', 'E', 'A')],
        'A',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.insertedConverts).toHaveLength(0);
    });
  });

  describe('segmentation + FBO format', () => {
    it('single segment for homogeneous linear pipeline', async () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'a' }),
        adjKind({ kind: 'b' }),
      ]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B')],
        'B',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.segments).toHaveLength(1);
      expect(plan.segments[0].fboFormat).toBe('rgba16f');
      expect(plan.segments[0].nodes).toEqual(['S', 'A', 'B']);
    });

    it('single RGBA8 segment for homogeneous gamma pipeline', async () => {
      const gammaSrc = makeKind({
        kind: 'gsrc',
        category: 'source',
        outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
        outputSpace: 'gamma',
        outputGeometry: () => G_1x1,
      });
      const gammaAdj = makeKind({
        kind: 'g',
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'gamma' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
        inputSpace: 'gamma',
        outputSpace: 'gamma',
      });
      const registry = makeRegistry([gammaSrc, gammaAdj]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'gsrc'), makeNode('G', 'g')],
        [makeEdge('e1', 'S', 'G')],
        'G',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.segments).toHaveLength(1);
      expect(plan.segments[0].fboFormat).toBe('rgba8');
    });

    it('keeps the RGBA8 default but can retain an RGBA16F terminal segment', async () => {
      const gammaSrc = makeKind({
        kind: 'gsrc-terminal',
        category: 'source',
        outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
        inputSpace: 'gamma',
        outputSpace: 'gamma',
        outputGeometry: () => G_1x1,
      });
      const gammaAdj = makeKind({
        kind: 'g-terminal',
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'gamma' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
        inputSpace: 'gamma',
        outputSpace: 'gamma',
      });
      const registry = makeRegistry([gammaSrc, gammaAdj]);
      const graph = makeGraph(
        [makeNode('S', 'gsrc-terminal'), makeNode('G', 'g-terminal')],
        [makeEdge('e1', 'S', 'G')],
        'G',
      );
      const compiler = new GraphCompiler(registry);

      const normal = await compiler.compile(graph);
      const highDepth = await compiler.compile(graph, { terminalFormat: 'rgba16f' });

      expect(normal.perNodeFbo.get('G')?.format).toBe('rgba8');
      expect(highDepth.perNodeFbo.get('G')?.format).toBe('rgba16f');
      expect(highDepth.segments.at(-1)?.fboFormat).toBe('rgba16f');
    });

    it('splits at color-space convert boundary', async () => {
      const gammaSink = makeKind({
        kind: 'gs',
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'gamma' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
        inputSpace: 'gamma',
        outputSpace: 'gamma',
      });
      const registry = makeRegistry([srcKindWithGeom(G_1x1), adjKind({ kind: 'a' }), gammaSink]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('G', 'gs')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'G')],
        'G',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      // S + A (linear/rgba16f), then convert (gamma/rgba8), then G (gamma/rgba8)
      expect(plan.segments).toHaveLength(2);
      expect(plan.segments[0].fboFormat).toBe('rgba16f');
      expect(plan.segments[0].nodes).toEqual(['S', 'A']);
      expect(plan.segments[1].fboFormat).toBe('rgba8');
      // Convert + G in second segment
      expect(plan.segments[1].nodes).toContain('G');
      expect(plan.segments[1].nodes.some((id) => id.startsWith('__convert_'))).toBe(true);
    });

    it('splits when geometry changes', async () => {
      const big: Geometry = { width: 800, height: 600, pixelRatio: 1 };
      const halfRes = makeKind({
        kind: 'half',
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'linear' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
        outputGeometry: (g) => ({ width: g[0].width / 2, height: g[0].height / 2, pixelRatio: 1 }),
      });
      const registry = makeRegistry([srcKindWithGeom(big), adjKind({ kind: 'a' }), halfRes]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('H', 'half')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'H')],
        'H',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.segments).toHaveLength(2);
      expect(plan.segments[0].geometry).toEqual(big);
      expect(plan.segments[1].geometry).toEqual({ width: 400, height: 300, pixelRatio: 1 });
    });
  });

  describe('FBO assignment (ping-pong)', () => {
    it('alternates poolIndex 0/1 within a segment', async () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'a' }),
        adjKind({ kind: 'b' }),
        adjKind({ kind: 'c' }),
      ]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b'), makeNode('C', 'c')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B'), makeEdge('e3', 'B', 'C')],
        'C',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.perNodeFbo.get('S')?.poolIndex).toBe(0);
      expect(plan.perNodeFbo.get('A')?.poolIndex).toBe(1);
      expect(plan.perNodeFbo.get('B')?.poolIndex).toBe(0);
      expect(plan.perNodeFbo.get('C')?.poolIndex).toBe(1);
    });
  });

  describe('tap insertion (captureAfter)', () => {
    it('synthesises a tap node and edge for each capture request', async () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'a' }),
        adjKind({ kind: 'b' }),
      ]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B')],
        'B',
      );
      const plan = await new GraphCompiler(registry).compile(graph, {
        captureAfter: [{ nodeId: 'A', label: 'preToneCurve' }],
      });
      expect(plan.taps.size).toBe(1);
      const tapId = plan.taps.get('preToneCurve');
      expect(tapId).toBeDefined();
      expect(plan.topologicalOrder).toContain(tapId);
      // Inline-tap creates two edges per capture: A->tap, tap->originalConsumer.
      expect(plan.insertedTaps).toHaveLength(2);
      const inEdge = plan.insertedTaps.find((e) => e.id.startsWith('__tapIn_'));
      const outEdge = plan.insertedTaps.find((e) => e.id.startsWith('__tapOut_'));
      expect(inEdge?.from.node).toBe('A');
      expect(inEdge?.to.node).toBe(tapId);
      expect(outEdge?.from.node).toBe(tapId);
      expect(outEdge?.to.node).toBe('B');
      // Tap appears between A and B in the topo order.
      const orderIdx = (id: string) => plan.topologicalOrder.indexOf(id);
      expect(orderIdx('A')).toBeLessThan(orderIdx(tapId!));
      expect(orderIdx(tapId!)).toBeLessThan(orderIdx('B'));
    });

    it('isolates tap into its own segment (FBO preserved)', async () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'a' }),
        adjKind({ kind: 'b' }),
      ]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B')],
        'B',
      );
      const plan = await new GraphCompiler(registry).compile(graph, {
        captureAfter: [{ nodeId: 'A', label: 'mid' }],
      });
      const tapId = plan.taps.get('mid')!;
      const tapSegmentIdx = plan.segments.findIndex((s) => s.nodes.includes(tapId));
      // Tap must be the only node in its segment.
      expect(plan.segments[tapSegmentIdx].nodes).toEqual([tapId]);
      // And B continues in a fresh segment after — not merged with tap.
      const bSegIdx = plan.segments.findIndex((s) => s.nodes.includes('B'));
      expect(bSegIdx).toBeGreaterThan(tapSegmentIdx);
    });

    it('multiple captures with distinct labels', async () => {
      const registry = makeRegistry([
        srcKindWithGeom(G_1x1),
        adjKind({ kind: 'a' }),
        adjKind({ kind: 'b' }),
      ]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a'), makeNode('B', 'b')],
        [makeEdge('e1', 'S', 'A'), makeEdge('e2', 'A', 'B')],
        'B',
      );
      const plan = await new GraphCompiler(registry).compile(graph, {
        captureAfter: [
          { nodeId: 'A', label: 'mid' },
          { nodeId: 'B', label: 'final' },
        ],
      });
      expect(plan.taps.size).toBe(2);
      expect(plan.taps.has('mid')).toBe(true);
      expect(plan.taps.has('final')).toBe(true);
    });

    it('rejects duplicate labels', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1), adjKind({ kind: 'a' })]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a')],
        [makeEdge('e1', 'S', 'A')],
        'A',
      );
      await expect(new GraphCompiler(registry).compile(graph, {
        captureAfter: [
          { nodeId: 'S', label: 'same' },
          { nodeId: 'A', label: 'same' },
        ],
      })).rejects.toThrow(/used more than once/);
    });

    it('rejects unknown source node', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1)]);
      registerBuiltinConverts(registry);
      const graph = makeGraph([makeNode('S', 'src')], [], 'S');
      await expect(new GraphCompiler(registry).compile(graph, {
        captureAfter: [{ nodeId: 'GHOST', label: 'x' }],
      })).rejects.toThrow(/target node 'GHOST'/);
    });

    it('rejects captureAfter when tap kind is not registered', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1)]);
      // Note: NOT calling registerBuiltinConverts
      const graph = makeGraph([makeNode('S', 'src')], [], 'S');
      await expect(new GraphCompiler(registry).compile(graph, {
        captureAfter: [{ nodeId: 'S', label: 'x' }],
      })).rejects.toThrow(/tap kind is not registered/);
    });
  });

  describe('async prepare()', () => {
    it('invokes prepare and stores promises keyed by node id', async () => {
      let prepareCalled = false;
      let receivedInputs: Geometry[] | null = null;
      const asyncAdj = makeKind({
        kind: 'asyncAdj',
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'linear' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
        isAsync: true,
        prepare: async (_params, ctx) => {
          prepareCalled = true;
          receivedInputs = [...ctx.inputGeometries];
        },
      });
      const registry = makeRegistry([
        srcKindWithGeom({ width: 100, height: 50, pixelRatio: 1 }),
        asyncAdj,
      ]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'asyncAdj')],
        [makeEdge('e1', 'S', 'A')],
        'A',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.asyncDependencies.has('A')).toBe(true);
      await plan.asyncDependencies.get('A');
      expect(prepareCalled).toBe(true);
      expect(receivedInputs).toEqual([{ width: 100, height: 50, pixelRatio: 1 }]);
    });

    it('wraps synchronous throws from prepare() into a rejected promise', async () => {
      const grumpy = makeKind({
        kind: 'grumpy',
        category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'linear' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
        isAsync: true,
        prepare: () => { throw new Error('boom'); },
      });
      const registry = makeRegistry([srcKindWithGeom(G_1x1), grumpy]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('G', 'grumpy')],
        [makeEdge('e1', 'S', 'G')],
        'G',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      await expect(plan.asyncDependencies.get('G')).rejects.toThrow(/boom/);
    });

    it('skips non-async nodes', async () => {
      const registry = makeRegistry([srcKindWithGeom(G_1x1), adjKind({ kind: 'a' })]);
      registerBuiltinConverts(registry);
      const graph = makeGraph(
        [makeNode('S', 'src'), makeNode('A', 'a')],
        [makeEdge('e1', 'S', 'A')],
        'A',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      expect(plan.asyncDependencies.size).toBe(0);
    });
  });

  describe('per-node color-space override (Phase 3)', () => {
    it('honours params._colorSpaceOverride.outputSpace on an either-tagged kind', async () => {
      const registry = new NodeRegistry();
      registerBuiltinConverts(registry);
      registry.register(makeKind({
        kind: 'srcGamma', category: 'source',
        inputPorts: [],
        outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
        inputSpace: 'gamma', outputSpace: 'gamma',
      }));
      registry.register(makeKind({
        kind: 'eitherAdj', category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
        inputSpace: 'either', outputSpace: 'either',
      }));
      registry.register(makeKind({
        kind: 'sinkLinear', category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'linear' }],
        inputSpace: 'linear', outputSpace: 'linear',
      }));

      // Override on `mid` forces output=linear → compiler must insert a
      // gamma→linear convert between `src` (gamma) and `mid` (override linear).
      const graph = makeGraph(
        [
          makeNode('src', 'srcGamma'),
          makeNode('mid', 'eitherAdj', { _colorSpaceOverride: { inputSpace: 'linear', outputSpace: 'linear' } }),
          makeNode('sink', 'sinkLinear'),
        ],
        [makeEdge('e1', 'src', 'mid'), makeEdge('e2', 'mid', 'sink')],
        'sink',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      // Convert inserted: one gamma→linear between src and mid.
      const hasG2L = plan.insertedConverts.some((edge) => {
        const node = plan.augmentedNodes.get(edge.to.node)?.kind === KIND_CONVERT_GAMMA_TO_LIN
          || plan.augmentedNodes.get(edge.from.node)?.kind === KIND_CONVERT_GAMMA_TO_LIN;
        return node;
      });
      expect(hasG2L).toBe(true);
    });

    it('ignores override with invalid space values', async () => {
      const registry = new NodeRegistry();
      registerBuiltinConverts(registry);
      registry.register(makeKind({
        kind: 'src', category: 'source',
        inputPorts: [],
        outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
        inputSpace: 'linear', outputSpace: 'linear',
      }));
      registry.register(makeKind({
        kind: 'adj', category: 'adjustment',
        inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
        outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
        inputSpace: 'either', outputSpace: 'either',
      }));

      const graph = makeGraph(
        [
          makeNode('src', 'src'),
          makeNode('adj', 'adj', { _colorSpaceOverride: { outputSpace: 'bogus' } }),
        ],
        [makeEdge('e1', 'src', 'adj')],
        'adj',
      );
      const plan = await new GraphCompiler(registry).compile(graph);
      // No convert inserted — override ignored, 'either' falls back to upstream.
      expect(plan.insertedConverts).toHaveLength(0);
    });
  });
});

describe('multi-input nodes (Phase 1.C Compositor foundation)', () => {
  it('augmentedEdges preserves all incoming edges across multiple ports', async () => {
    const registry = new NodeRegistry();
    registerBuiltinConverts(registry);
    registry.register(makeKind({
      kind: 'srcA', category: 'source',
      inputPorts: [],
      outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
      inputSpace: 'linear', outputSpace: 'linear',
    }));
    registry.register(makeKind({
      kind: 'srcB', category: 'source',
      inputPorts: [],
      outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
      inputSpace: 'linear', outputSpace: 'linear',
    }));
    registry.register(makeKind({
      kind: 'comp', category: 'compositor',
      inputPorts: [
        { id: 'in',    type: 'color', space: 'linear' },
        { id: 'layer', type: 'color', space: 'linear' },
      ],
      outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
      inputSpace: 'linear', outputSpace: 'linear',
    }));

    const graph = makeGraph(
      [
        makeNode('a', 'srcA'),
        makeNode('b', 'srcB'),
        makeNode('c', 'comp'),
      ],
      [
        makeEdge('e1', 'a', 'c', 'out', 'in'),
        makeEdge('e2', 'b', 'c', 'out', 'layer'),
      ],
      'c',
    );
    const plan = await new GraphCompiler(registry).compile(graph);

    // Both edges survive into augmentedEdges (no Phase-0 single-input drop).
    const toC = plan.augmentedEdges.filter((e) => e.to.node === 'c');
    expect(toC).toHaveLength(2);
    const ports = new Set(toC.map((e) => e.to.port));
    expect(ports).toEqual(new Set(['in', 'layer']));
  });
});

describe('builtin convert kinds', () => {
  it('registerBuiltinConverts adds both kinds', () => {
    const r = new NodeRegistry();
    registerBuiltinConverts(r);
    expect(r.has(KIND_CONVERT_LIN_TO_GAMMA)).toBe(true);
    expect(r.has(KIND_CONVERT_GAMMA_TO_LIN)).toBe(true);
  });

  it('is idempotent (replace, not register)', () => {
    const r = new NodeRegistry();
    registerBuiltinConverts(r);
    expect(() => registerBuiltinConverts(r)).not.toThrow();
  });
});

describe('NodeRegistry', () => {
  it('register + get + has + list', () => {
    const r = new NodeRegistry();
    const k = makeKind({ kind: 'foo', category: 'adjustment' });
    r.register(k);
    expect(r.has('foo')).toBe(true);
    expect(r.get('foo')).toBe(k);
    expect(r.list()).toEqual([k]);
    expect(r.list('adjustment')).toEqual([k]);
    expect(r.list('source')).toEqual([]);
  });

  it('rejects duplicate registration', () => {
    const r = new NodeRegistry();
    r.register(makeKind({ kind: 'foo', category: 'adjustment' }));
    expect(() => r.register(makeKind({ kind: 'foo', category: 'adjustment' })))
      .toThrow(/already registered/);
  });

  it('replace overrides without throwing', () => {
    const r = new NodeRegistry();
    r.register(makeKind({ kind: 'foo', category: 'adjustment' }));
    const v2 = makeKind({ kind: 'foo', category: 'adjustment', requiresFloat: true });
    expect(() => r.replace(v2)).not.toThrow();
    expect(r.get('foo')?.requiresFloat).toBe(true);
  });

  it('require() throws on missing kind', () => {
    const r = new NodeRegistry();
    expect(() => r.require('nothing')).toThrow(/not registered/);
  });

  it('rejects duplicate port ids on a kind', () => {
    const r = new NodeRegistry();
    expect(() => r.register(makeKind({
      kind: 'dup',
      category: 'adjustment',
      inputPorts: [{ id: 'p', type: 'color', space: 'linear' }],
      outputPorts: [{ id: 'p', type: 'color', space: 'linear' }],
    }))).toThrow(/duplicate port id 'p'/);
  });

  it('rejects async kind without prepare hook', () => {
    const r = new NodeRegistry();
    expect(() => r.register(makeKind({
      kind: 'a', category: 'adjustment',
      isAsync: true,
      // prepare missing
    }))).toThrow(/isAsync=true but provides no prepare/);
  });

  it('rejects kinds with zero output ports unless encoder', () => {
    const r = new NodeRegistry();
    expect(() => r.register(makeKind({
      kind: 'broken', category: 'adjustment', outputPorts: [],
    }))).toThrow(/needs at least one output port/);
    // Encoder is the one category allowed to have no outputs (it terminates).
    expect(() => r.register(makeKind({
      kind: 'enc', category: 'encoder', outputPorts: [],
    }))).not.toThrow();
  });
});
