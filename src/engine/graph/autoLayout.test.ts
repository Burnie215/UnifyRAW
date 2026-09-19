import { describe, expect, it } from 'vitest';
import { autoLayout, LAYOUT_METRICS } from './autoLayout';
import { buildDefaultGraph } from './DefaultGraphBuilder';
import {
  registerBuiltinSources, registerBuiltinPassKinds, registerBuiltinConverts,
} from './index';
import { NodeRegistry } from './NodeRegistry';

const geometry = { width: 64, height: 32, pixelRatio: 1 };

describe('autoLayout', () => {
  it('places source at the top layer and chains successors downward', () => {
    const { graph } = buildDefaultGraph({}, { kind: 'imageBitmap', geometry });
    const positions = autoLayout(graph);
    // Every node gets a position.
    for (const id of graph.nodes.keys()) {
      expect(positions[id]).toBeDefined();
    }
    // Source is top-most (smallest y) — successors live at increasing depth.
    const sourceId = Array.from(graph.nodes.keys()).find((id) => id.startsWith('default:__source'))!;
    const sourcePos = positions[sourceId];
    for (const [, pos] of Object.entries(positions)) {
      expect(pos.y).toBeGreaterThanOrEqual(sourcePos.y);
    }
  });

  it('respects existing user-set positions', () => {
    const { graph } = buildDefaultGraph({}, { kind: 'imageBitmap', geometry });
    const firstId = Array.from(graph.nodes.keys())[0];
    graph.metadata.nodePositions = { [firstId]: { x: 999, y: 888 } };
    const positions = autoLayout(graph);
    expect(positions[firstId]).toEqual({ x: 999, y: 888 });
  });

  it('LAYOUT_METRICS exposes node dimensions for the renderer', () => {
    expect(LAYOUT_METRICS.NODE_WIDTH).toBeGreaterThan(0);
    expect(LAYOUT_METRICS.NODE_HEIGHT).toBeGreaterThan(0);
    expect(LAYOUT_METRICS.PORT_RADIUS).toBeGreaterThan(0);
  });

  it('handles disconnected nodes without crashing', () => {
    const r = new NodeRegistry();
    registerBuiltinConverts(r);
    registerBuiltinSources(r);
    registerBuiltinPassKinds(r);
    // Hand-roll a graph: two disconnected nodes, no edges.
    const graph = {
      id: 'disconnected',
      nodes: new Map([
        ['a', { id: 'a', kind: 'tone', params: {} }],
        ['b', { id: 'b', kind: 'tone', params: {} }],
      ]),
      edges: [],
      output: 'a',
      metadata: { createdAt: 0, updatedAt: 0, revision: 1 },
    };
    const positions = autoLayout(graph);
    expect(positions.a).toBeDefined();
    expect(positions.b).toBeDefined();
    // Both in layer 0 (no predecessors) → same y, spread sideways → different x.
    expect(positions.a.y).toBe(positions.b.y);
    expect(positions.a.x).not.toBe(positions.b.x);
  });
});
