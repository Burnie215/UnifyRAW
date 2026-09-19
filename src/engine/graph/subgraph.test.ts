import { describe, expect, it } from 'vitest';
import { buildDefaultGraph, buildLayeredGraph } from './DefaultGraphBuilder';
import { GraphCompiler } from './GraphCompiler';
import { getMainThreadNodeRegistry } from './defaultPipelineService';
import type { RenderGraph } from './types';
import { previewSubgraph, pruneToOutput, subgraphBefore } from './subgraph';
import { KIND_TONE, KIND_TONE_CURVE, KIND_TRANSFORM, KIND_WHITE_BALANCE } from './passKinds';
import { KIND_CONVERT_LIN_TO_GAMMA } from './builtins';

const SRC = { kind: 'imageBitmap' as const, geometry: { width: 32, height: 24, pixelRatio: 1 } };

describe('subgraphBefore', () => {
  it('truncates at the stop node and appends a lin-to-gamma convert', () => {
    const { graph } = buildDefaultGraph({}, SRC);
    const sub = subgraphBefore(graph, `default:${KIND_TONE_CURVE}`, { appendLinToGamma: true });
    expect(sub).not.toBeNull();
    // Stop node + everything downstream is gone.
    expect(sub!.nodes.has(`default:${KIND_TONE_CURVE}`)).toBe(false);
    expect(sub!.nodes.has(`default:${KIND_TRANSFORM}`)).toBe(false);
    // Terminal is the appended convert fed by the stop node's producer.
    const outNode = sub!.nodes.get(sub!.output);
    expect(outNode?.kind).toBe(KIND_CONVERT_LIN_TO_GAMMA);
    const feed = sub!.edges.find((e) => e.to.node === sub!.output);
    expect(feed?.from.node).toBe(`default:${KIND_WHITE_BALANCE}`);
    // No dangling edges into dropped nodes.
    for (const e of sub!.edges) {
      expect(sub!.nodes.has(e.from.node)).toBe(true);
      expect(sub!.nodes.has(e.to.node)).toBe(true);
    }
    // Distinct plan-cache identity vs the parent graph.
    expect(sub!.id).not.toBe(graph.id);
  });

  it('returns null for unknown stop nodes', () => {
    const { graph } = buildDefaultGraph({}, SRC);
    expect(subgraphBefore(graph, 'default:doesNotExist')).toBeNull();
  });
});

describe('previewSubgraph plan-cache identity', () => {
  it('keeps the id stable across revisions (cache slot is REPLACED, not grown)', async () => {
    const { previewSubgraph } = await import('./subgraph');
    const { graph } = buildDefaultGraph({}, SRC);
    const a = previewSubgraph(graph, `default:${KIND_WHITE_BALANCE}`, { width: 8, height: 8 });
    graph.metadata.revision += 1;
    const b = previewSubgraph(graph, `default:${KIND_WHITE_BALANCE}`, { width: 8, height: 8 });
    expect(a.id).toBe(b.id);
    // Staleness is still detectable through the metadata revision.
    expect(a.metadata.revision).not.toBe(b.metadata.revision);
  });
});

describe('previewSubgraph display encoding', () => {
  it('re-encodes a preview cut inside the linear block', () => {
    const { graph } = buildDefaultGraph({}, SRC);
    const sub = previewSubgraph(graph, `default:${KIND_WHITE_BALANCE}`, { width: 8, height: 8 });

    // White balance runs in working-linear space, so the terminal has to be a
    // display encode - otherwise the thumbnail comes out far too dark.
    expect(sub.nodes.get(sub.output)?.kind).toBe(KIND_CONVERT_LIN_TO_GAMMA);
    const feed = sub.edges.find((e) => e.to.node === sub.output);
    expect(feed?.from.node).toBe(`default:${KIND_WHITE_BALANCE}`);
  });

  it('leaves an already display-encoded terminal alone', () => {
    const { graph } = buildDefaultGraph({}, SRC);
    const sub = previewSubgraph(graph, graph.output, { width: 8, height: 8 });

    expect(sub.output).toBe(graph.output);
    expect(sub.nodes.get(sub.output)?.kind).not.toBe(KIND_CONVERT_LIN_TO_GAMMA);
  });

  it('keeps the encoded and unencoded variants in separate cache slots', () => {
    const { graph } = buildDefaultGraph({}, SRC);
    const linear = previewSubgraph(graph, `default:${KIND_WHITE_BALANCE}`, { width: 8, height: 8 });
    const encoded = previewSubgraph(graph, graph.output, { width: 8, height: 8 });
    expect(linear.id).not.toBe(encoded.id);
  });
});


// ─── Layered graphs (branch chains + compositors) ──────────────────

const LAYER = {
  id: 'L1',
  adjustments: { exposure: 0.5 },
  opacity: 0.5,
  blendMode: 'normal' as const,
};

function layered(useMask: boolean) {
  return buildLayeredGraph({}, [{ ...LAYER, useMask }], SRC).graph;
}

/** Every node in `sub` that the registry classes as a source. */
function sourceIds(sub: RenderGraph): string[] {
  const registry = getMainThreadNodeRegistry();
  return [...sub.nodes.values()]
    .filter((n) => registry.get(n.kind)?.category === 'source')
    .map((n) => n.id);
}

describe('previewSubgraph on a layered graph', () => {
  it('keeps the whole composite branch when previewing the compositor', () => {
    const graph = layered(true);
    const sub = previewSubgraph(graph, 'comp:L1', { width: 8, height: 8 });

    expect(sub.output).toBe('comp:L1');
    // Both compositor inputs plus the mask source have to survive.
    expect(sub.nodes.has(`default:${KIND_TRANSFORM}`)).toBe(true);
    expect(sub.nodes.has(`layer:L1:default:${KIND_TRANSFORM}`)).toBe(true);
    expect(sub.nodes.has('mask:L1')).toBe(true);
    for (const port of ['in', 'layer', 'mask']) {
      expect(sub.edges.some((e) => e.to.node === 'comp:L1' && e.to.port === port)).toBe(true);
    }
    // Already display-encoded: no extra gamma convert on top.
    expect(sub.nodes.get(sub.output)?.kind).not.toBe(KIND_CONVERT_LIN_TO_GAMMA);
  });

  it('reduces a branch preview to that branch alone', () => {
    const graph = layered(true);
    const sub = previewSubgraph(graph, `layer:L1:default:${KIND_WHITE_BALANCE}`, { width: 8, height: 8 });

    // The branch itself, up to the preview node.
    expect(sub.nodes.has(`layer:L1:default:${KIND_WHITE_BALANCE}`)).toBe(true);
    expect(sub.nodes.has(`layer:L1:default:${KIND_TONE_CURVE}`)).toBe(false);
    // The base chain and the mask do not feed this node - keeping them would
    // leave a second unbound source node in the plan (PipelineService refuses
    // those) and would render 17 passes nobody reads.
    expect(sub.nodes.has(`default:${KIND_WHITE_BALANCE}`)).toBe(false);
    expect(sub.nodes.has('mask:L1')).toBe(false);
    expect(sourceIds(sub)).toEqual(['default:__source.imageBitmap']);
    // Cut inside the linear block, so the terminal re-encodes for display.
    expect(sub.nodes.get(sub.output)?.kind).toBe(KIND_CONVERT_LIN_TO_GAMMA);
  });

  it('drops the layer branch when previewing a base-chain node', () => {
    const graph = layered(true);
    const sub = previewSubgraph(graph, `default:${KIND_WHITE_BALANCE}`, { width: 8, height: 8 });

    expect([...sub.nodes.keys()].some((id) => id.startsWith('layer:'))).toBe(false);
    expect(sourceIds(sub)).toEqual(['default:__source.imageBitmap']);
    expect(sub.nodes.get(sub.output)?.kind).toBe(KIND_CONVERT_LIN_TO_GAMMA);
  });

  it('does not re-encode a preview taken after a branch OutputColorSpace', () => {
    const graph = layered(false);
    // A gamma-block node of the BRANCH: the base chain (pruned away) still
    // carries its own OutputColorSpace, which must not be mistaken for a cut
    // through the linear block.
    const sub = previewSubgraph(graph, `layer:L1:default:${KIND_TRANSFORM}`, { width: 8, height: 8 });
    expect(sub.output).toBe(`layer:L1:default:${KIND_TRANSFORM}`);
    expect(sub.nodes.get(sub.output)?.kind).not.toBe(KIND_CONVERT_LIN_TO_GAMMA);
  });

  it('leaves no dangling edges and compiles', () => {
    const graph = layered(true);
    const registry = getMainThreadNodeRegistry();
    const compiler = new GraphCompiler(registry);
    for (const target of [
      'comp:L1',
      `layer:L1:default:${KIND_WHITE_BALANCE}`,
      `default:${KIND_WHITE_BALANCE}`,
      graph.output,
    ]) {
      const sub = previewSubgraph(graph, target, { width: 8, height: 8 });
      for (const e of sub.edges) {
        expect(sub.nodes.has(e.from.node)).toBe(true);
        expect(sub.nodes.has(e.to.node)).toBe(true);
      }
      expect(compiler.validate(sub)).toBeNull();
    }
  });
});

describe('subgraphBefore on a layered graph', () => {
  it('keeps only what feeds the new terminal', () => {
    const graph = layered(true);
    const sub = subgraphBefore(graph, `default:${KIND_TONE_CURVE}`, { appendLinToGamma: true });
    expect(sub).not.toBeNull();
    expect([...sub!.nodes.keys()].some((id) => id.startsWith('layer:'))).toBe(false);
    expect(sub!.nodes.has('mask:L1')).toBe(false);
    expect(sub!.nodes.has('comp:L1')).toBe(false);
  });
});

// ─── The graph as it renders ───────────────────────────────────────

describe('pruneToOutput', () => {
  const stray = (id: string) => ({ id, kind: KIND_TONE, params: {} });

  it('drops a node without edges and leaves id, output and geometry alone', () => {
    const { graph } = buildDefaultGraph({}, SRC);
    const withStray: RenderGraph = { ...graph, nodes: new Map([...graph.nodes, ['stray', stray('stray')]]) };

    const { graph: pruned, dropped } = pruneToOutput(withStray);
    expect(dropped).toEqual(['stray']);
    expect([...pruned.nodes.keys()]).toEqual([...graph.nodes.keys()]);
    expect(pruned.id).toBe(graph.id);
    expect(pruned.output).toBe(graph.output);
    const [source] = sourceIds(pruned);
    expect(pruned.nodes.get(source)).toBe(graph.nodes.get(source));
  });

  it('drops a side branch that ends nowhere, together with its edges', () => {
    const { graph } = buildDefaultGraph({}, SRC);
    const from = `default:${KIND_WHITE_BALANCE}`;
    const branched: RenderGraph = {
      ...graph,
      nodes: new Map([...graph.nodes, ['side1', stray('side1')], ['side2', stray('side2')]]),
      edges: [
        ...graph.edges,
        { id: 'e:side1', from: { node: from, port: 'out' }, to: { node: 'side1', port: 'in' } },
        { id: 'e:side2', from: { node: 'side1', port: 'out' }, to: { node: 'side2', port: 'in' } },
      ],
    };

    const { graph: pruned, dropped } = pruneToOutput(branched);
    expect(dropped).toEqual(['side1', 'side2']);
    expect(pruned.edges).toEqual(graph.edges);
  });

  it('keeps the mask source that feeds a compositor, and what is left compiles', () => {
    const graph = layered(true);
    const withStray: RenderGraph = { ...graph, nodes: new Map([...graph.nodes, ['stray', stray('stray')]]) };
    const compiler = new GraphCompiler(getMainThreadNodeRegistry());
    // The compiler stays strict: left in, the one stray node fails it all.
    expect(compiler.validate(withStray)).not.toBeNull();

    const { graph: pruned, dropped } = pruneToOutput(withStray);
    expect(dropped).toEqual(['stray']);
    expect(pruned.nodes.has('mask:L1')).toBe(true);
    expect(compiler.validate(pruned)).toBeNull();
  });

  it('hands back the graph itself when every node reaches the output', () => {
    const { graph } = buildDefaultGraph({}, SRC);
    const result = pruneToOutput(graph);
    expect(result.graph).toBe(graph);
    expect(result.dropped).toEqual([]);
  });
});
