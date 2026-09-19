import { describe, expect, it } from 'vitest';

import { scanGraphShape, SHAPE_REASONS } from './shapeScan';
import { buildDefaultGraph, buildLayeredGraph, maskNodeIdForLayer, type BuilderLayer } from '../DefaultGraphBuilder';
import { KIND_COMPOSITE } from '../compositorKinds';
import { KIND_IMAGE_BITMAP_SOURCE, KIND_RASTERIZED_MASK_SOURCE } from '../sources';
import { KIND_TONE } from '../passKinds';
import type { RenderGraph } from '../types';

const SOURCE = { kind: 'imageBitmap' as const, geometry: { width: 16, height: 8, pixelRatio: 1 } };
const SRC_ID = `default:${KIND_IMAGE_BITMAP_SOURCE}`;

const L1: BuilderLayer = { id: 'L1', adjustments: { contrast: 20 }, opacity: 0.8, blendMode: 'normal' };
const L2: BuilderLayer = { id: 'L2', adjustments: { exposure: 15 }, opacity: 0.5, blendMode: 'multiply' };

/** The shape scan is the only thing under test, so build the fixtures with the
 *  real builder — a hand-written graph would drift from what ships. */
const layered = (layers: BuilderLayer[]): RenderGraph =>
  buildLayeredGraph({ exposure: 10 }, layers, SOURCE).graph;

const ok = (r: ReturnType<typeof scanGraphShape>) => {
  if (!r.ok) throw new Error('expected a shape, got blocked: ' + JSON.stringify(r.blocked));
  return r.shape;
};
const blocked = (r: ReturnType<typeof scanGraphShape>) => {
  if (r.ok) throw new Error('expected blocked, got a shape');
  return r.blocked;
};

function withNode(graph: RenderGraph, id: string, kind: string, params: unknown = {}): RenderGraph {
  return { ...graph, nodes: new Map(graph.nodes).set(id, { id, kind, params }) };
}

describe('scanGraphShape', () => {
  it('recognises a flat graph as base only', () => {
    const shape = ok(scanGraphShape(buildDefaultGraph({ exposure: 10 }, SOURCE).graph));
    expect(shape.sourceNodeId).toBe(SRC_ID);
    expect(shape.layers).toEqual([]);
    // 17 chain steps for an SDR source, source excluded.
    expect(shape.base.nodeIds).toHaveLength(17);
    expect(shape.base.nodeIds[0]).toBe(`default:${'lensCorrection'}`);
    expect(shape.base.terminalId).toBe(shape.base.nodeIds[16]);
  });

  it('recognises base + two layers, and keeps the cascade order', () => {
    const shape = ok(scanGraphShape(layered([L1, L2])));
    expect(shape.layers.map((l) => l.compositorId)).toEqual(['comp:L1', 'comp:L2']);
    expect(shape.base.nodeIds).toHaveLength(17);
    for (const layer of shape.layers) {
      expect(layer.chain.nodeIds).toHaveLength(17);
      expect(layer.maskNodeId).toBeNull();
    }
    // Each branch is its own chain, not a shared one.
    expect(shape.layers[0].chain.nodeIds[0]).toBe('layer:L1:default:lensCorrection');
    expect(shape.layers[1].chain.nodeIds[0]).toBe('layer:L2:default:lensCorrection');
  });

  it('picks up the mask source of a masked layer', () => {
    const shape = ok(scanGraphShape(layered([{ ...L1, useMask: true }, L2])));
    expect(shape.layers[0].maskNodeId).toBe(maskNodeIdForLayer('L1'));
    expect(shape.layers[1].maskNodeId).toBeNull();
  });

  it('reads the order from the cascade, not from node ids', () => {
    // Same two layers, but the compositors are renamed so ids carry no order.
    const graph = layered([L1, L2]);
    const rename = new Map([['comp:L1', 'zz-first'], ['comp:L2', 'aa-second']]);
    const nodes = new Map<string, RenderGraph['nodes'] extends Map<string, infer N> ? N : never>();
    for (const [id, node] of graph.nodes) {
      const newId = rename.get(id) ?? id;
      nodes.set(newId, { ...node, id: newId });
    }
    const edges = graph.edges.map((e) => ({
      ...e,
      from: { ...e.from, node: rename.get(e.from.node) ?? e.from.node },
      to: { ...e.to, node: rename.get(e.to.node) ?? e.to.node },
    }));
    const shape = ok(scanGraphShape({ ...graph, nodes, edges, output: 'aa-second' }));
    expect(shape.layers.map((l) => l.compositorId)).toEqual(['zz-first', 'aa-second']);
  });

  it('tolerates a node the user inserted inside a branch', () => {
    const graph = layered([L1]);
    // Splice an extra tone node between the branch head and its successor.
    const head = 'layer:L1:default:lensCorrection';
    const next = 'layer:L1:default:tone';
    const withExtra = withNode(graph, 'user:extra', KIND_TONE);
    const edges = withExtra.edges
      .filter((e) => !(e.from.node === head && e.to.node === next))
      .concat([
        { id: 'e:head->extra', from: { node: head, port: 'out' }, to: { node: 'user:extra', port: 'in' } },
        { id: 'e:extra->next', from: { node: 'user:extra', port: 'out' }, to: { node: next, port: 'in' } },
      ]);
    const shape = ok(scanGraphShape({ ...withExtra, edges }));
    expect(shape.layers[0].chain.nodeIds).toContain('user:extra');
    expect(shape.layers[0].chain.nodeIds).toHaveLength(18);
  });

  it('blocks a branch that starts at an intermediate result', () => {
    // Rewire L2's branch to start at the first compositor instead of the source.
    const graph = layered([L1, L2]);
    const branchHead = 'layer:L2:default:lensCorrection';
    const edges = graph.edges
      .filter((e) => !(e.to.node === branchHead && e.to.port === 'in'))
      .concat([{ id: 'e:comp->branch', from: { node: 'comp:L1', port: 'out' }, to: { node: branchHead, port: 'in' } }]);
    const reasons = blocked(scanGraphShape({ ...graph, edges })).map((b) => b.reason);
    expect(reasons).toContain(SHAPE_REASONS.branchOffIntermediate);
  });

  it('blocks a compositor feeding another compositor layer port', () => {
    const graph = layered([L1, L2]);
    const edges = graph.edges
      .filter((e) => !(e.to.node === 'comp:L2' && e.to.port === 'layer'))
      .concat([{ id: 'e:comp1->comp2.layer', from: { node: 'comp:L1', port: 'out' }, to: { node: 'comp:L2', port: 'layer' } }]);
    const found = blocked(scanGraphShape({ ...graph, edges }));
    expect(found).toEqual(expect.arrayContaining([
      { nodeId: 'comp:L1', reason: SHAPE_REASONS.notAStack },
    ]));
  });

  it('blocks a chain node with two consumers', () => {
    const graph = layered([L1]);
    const edges = graph.edges.concat([{
      id: 'e:extra-consumer',
      from: { node: 'default:tone', port: 'out' },
      to: { node: 'comp:L1', port: 'mask' },
    }]);
    const found = blocked(scanGraphShape({ ...graph, edges }));
    expect(found.map((b) => b.reason)).toContain(SHAPE_REASONS.notAStack);
    // The same wiring also fails the mask rule, and both are worth telling.
    expect(found.map((b) => b.reason)).toContain(SHAPE_REASONS.maskNotASource);
  });

  it('blocks a mask input that is not a mask source', () => {
    const graph = layered([{ ...L1, useMask: true }]);
    const nodes = new Map(graph.nodes);
    nodes.set(maskNodeIdForLayer('L1'), {
      id: maskNodeIdForLayer('L1'), kind: 'maskCombinator', params: {},
    });
    const found = blocked(scanGraphShape({ ...graph, nodes }));
    expect(found).toEqual(expect.arrayContaining([
      { nodeId: maskNodeIdForLayer('L1'), reason: SHAPE_REASONS.maskNotASource },
    ]));
  });

  it('blocks a graph without an image source, and one with several', () => {
    const graph = layered([L1]);
    const withoutSource = { ...graph, nodes: new Map(graph.nodes) };
    withoutSource.nodes.delete(SRC_ID);
    expect(blocked(scanGraphShape(withoutSource)).map((b) => b.reason))
      .toEqual([SHAPE_REASONS.noImageSource]);

    const twoSources = withNode(graph, 'user:second-source', KIND_IMAGE_BITMAP_SOURCE);
    const found = blocked(scanGraphShape(twoSources));
    expect(found).toHaveLength(2);
    expect(found.every((b) => b.reason === SHAPE_REASONS.severalImageSources)).toBe(true);
  });

  it('blocks a broken chain and a cycle instead of looping forever', () => {
    const graph = layered([L1]);
    const cut = { ...graph, edges: graph.edges.filter((e) => e.to.node !== 'default:tone') };
    expect(blocked(scanGraphShape(cut)).map((b) => b.reason)).toContain(SHAPE_REASONS.missingInput);

    const cyclic = {
      ...graph,
      edges: graph.edges
        .filter((e) => !(e.to.node === 'default:lensCorrection' && e.to.port === 'in'))
        .concat([{
          id: 'e:cycle',
          from: { node: 'default:transform', port: 'out' },
          to: { node: 'default:lensCorrection', port: 'in' },
        }]),
    };
    expect(blocked(scanGraphShape(cyclic)).map((b) => b.reason)).toContain(SHAPE_REASONS.cycle);
  });

  it('a deleted chain node does not block — it is an identity parameter', () => {
    const graph = layered([L1]);
    // Drop a node and heal the chain across it, the way the editor's delete does.
    const dropped = 'default:levels';
    const before = graph.edges.find((e) => e.to.node === dropped)!.from.node;
    const after = graph.edges.find((e) => e.from.node === dropped)!.to.node;
    const nodes = new Map(graph.nodes);
    nodes.delete(dropped);
    const edges = graph.edges
      .filter((e) => e.from.node !== dropped && e.to.node !== dropped)
      .concat([{ id: 'e:healed', from: { node: before, port: 'out' }, to: { node: after, port: 'in' } }]);
    const shape = ok(scanGraphShape({ ...graph, nodes, edges }));
    expect(shape.base.nodeIds).toHaveLength(16);
    expect(shape.base.nodeIds).not.toContain(dropped);
  });

  it('a mask source nobody uses is ignored rather than blocking', () => {
    const graph = withNode(layered([L1]), 'mask:orphan', KIND_RASTERIZED_MASK_SOURCE);
    const shape = ok(scanGraphShape(graph));
    expect(shape.layers[0].maskNodeId).toBeNull();
  });

  it('reports the compositor when its stack input is missing', () => {
    const graph = layered([L1]);
    const edges = graph.edges.filter((e) => !(e.to.node === 'comp:L1' && e.to.port === 'in'));
    const found = blocked(scanGraphShape({ ...graph, edges }));
    expect(found).toEqual(expect.arrayContaining([
      { nodeId: 'comp:L1', reason: SHAPE_REASONS.missingInput },
    ]));
    expect(graph.nodes.get('comp:L1')!.kind).toBe(KIND_COMPOSITE);
  });
});
