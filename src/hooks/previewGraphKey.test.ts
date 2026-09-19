/**
 * The preview hooks hang on this key, so it decides what re-renders a preview.
 * Moving a node mints a new graph object and a new revision; the picture the
 * preview shows cannot change from that.
 */
import { describe, expect, it } from 'vitest';
import { previewGraphKey } from './usePreviewTapRenderer';
import type { RenderGraph } from '../engine/graph';

function makeGraph(): RenderGraph {
  const nodes = new Map<string, { id: string; kind: string; params: unknown }>();
  nodes.set('default:source', { id: 'default:source', kind: '__source.imageBitmap', params: { width: 4000, height: 3000 } });
  nodes.set('default:tone', { id: 'default:tone', kind: 'tone', params: { exposure: 0 } });
  return {
    id: 'doc:1|4000x3000',
    nodes,
    edges: [{ id: 'e1', from: { node: 'default:source', port: 'out' }, to: { node: 'default:tone', port: 'in' } }],
    output: 'default:tone',
    metadata: { revision: 3, nodePositions: { 'default:tone': { x: 10, y: 20 } } },
  } as unknown as RenderGraph;
}

/** What useGraphEditor.mutate does: a fresh object with a fresh revision. */
function mutated(graph: RenderGraph, change: (g: RenderGraph) => void): RenderGraph {
  const next = {
    ...graph,
    nodes: new Map([...graph.nodes].map(([id, n]) => [id, { ...n }])),
    edges: graph.edges.map((e) => ({ ...e })),
    metadata: { ...graph.metadata, revision: graph.metadata.revision + 1 },
  } as unknown as RenderGraph;
  change(next);
  return next;
}

describe('previewGraphKey', () => {
  it('does not change when a node is moved', () => {
    const graph = makeGraph();
    const moved = mutated(graph, (g) => {
      g.metadata.nodePositions = { 'default:tone': { x: 400, y: 250 } };
    });
    expect(moved).not.toBe(graph);
    expect(moved.metadata.revision).not.toBe(graph.metadata.revision);
    expect(previewGraphKey(moved)).toBe(previewGraphKey(graph));
  });

  it('changes when a param, the wiring, the output or the graph changes', () => {
    const graph = makeGraph();
    const key = previewGraphKey(graph);

    const param = mutated(graph, (g) => {
      g.nodes.set('default:tone', { id: 'default:tone', kind: 'tone', params: { exposure: 0.5 } } as never);
    });
    expect(previewGraphKey(param)).not.toBe(key);

    const rewired = mutated(graph, (g) => { g.edges = []; });
    expect(previewGraphKey(rewired)).not.toBe(key);

    const reoutput = mutated(graph, (g) => { g.output = 'default:source'; });
    expect(previewGraphKey(reoutput)).not.toBe(key);

    // The builder puts the geometry into the id, and the geometry decides how
    // the picture is rendered.
    const resized = mutated(graph, (g) => { g.id = 'doc:1|2000x1500'; });
    expect(previewGraphKey(resized)).not.toBe(key);

    expect(previewGraphKey(null)).toBe('');
  });
});
