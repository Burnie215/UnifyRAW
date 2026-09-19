/**
 * Pure-helper tests for useGraphEditor: the data utilities that need no
 * renderer. The stateful hook itself is measured in a real React with a real
 * DOM next door, in [useGraphEditor.browser.test.ts](./useGraphEditor.browser.test.ts)
 * — "covered by manual editor smoke tests" is what this header used to say,
 * and a manual smoke test is what let the 100x slider regression through.
 */
import { describe, expect, it } from 'vitest';
import type { RenderGraph } from '../engine/graph';
import { defaultParamsForSchema, removeNodesFromGraph } from './useGraphEditor';

describe('defaultParamsForSchema', () => {
  it('honours explicit defaults', () => {
    const schema = {
      type: 'object',
      properties: {
        opacity: { type: 'number', default: 0.5 },
        blendMode: { type: 'string', default: 'normal' },
        useMask: { type: 'boolean', default: false },
      },
    };
    expect(defaultParamsForSchema(schema)).toEqual({ opacity: 0.5, blendMode: 'normal', useMask: false });
  });

  it('synthesises type-appropriate defaults when none specified', () => {
    const schema = {
      type: 'object',
      properties: {
        n: { type: 'number' },
        s: { type: 'string' },
        b: { type: 'boolean' },
      },
    };
    expect(defaultParamsForSchema(schema)).toEqual({ n: 0, s: '', b: false });
  });

  it('recurses into nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { x: { type: 'number', default: 7 } },
        },
      },
    };
    expect(defaultParamsForSchema(schema)).toEqual({ nested: { x: 7 } });
  });

  it('returns {} for non-object schemas', () => {
    expect(defaultParamsForSchema(null)).toEqual({});
    expect(defaultParamsForSchema(undefined)).toEqual({});
    expect(defaultParamsForSchema({ type: 'string' })).toEqual({});
  });

  it('defaults integer types like numbers (0 fallback)', () => {
    const schema = {
      type: 'object',
      properties: { size: { type: 'integer' } },
    };
    expect(defaultParamsForSchema(schema)).toEqual({ size: 0 });
  });

  it('returns [] for array defaults', () => {
    const schema = {
      type: 'object',
      properties: { samples: { type: 'array', items: { type: 'number' } } },
    };
    expect(defaultParamsForSchema(schema)).toEqual({ samples: [] });
  });
});

// ─── Deletion healing ─────────────────────────────────────────────

function chain(...ids: string[]): RenderGraph {
  const nodes = new Map(ids.map((id) => [id, { id, kind: `kind:${id}`, params: {} }]));
  const edges = ids.slice(0, -1).map((from, i) => ({
    id: `e:${from}→${ids[i + 1]}`,
    from: { node: from, port: 'out' },
    to: { node: ids[i + 1], port: 'in' },
  }));
  return {
    id: 'g', nodes, edges, output: ids[ids.length - 1],
    metadata: { createdAt: 0, updatedAt: 0, revision: 1 },
  };
}

const wiring = (g: RenderGraph) =>
  g.edges.map((e) => `${e.from.node}.${e.from.port}→${e.to.node}.${e.to.port}`).sort();

describe('removeNodesFromGraph', () => {
  it('closes the chain when a middle node is deleted', () => {
    const g = removeNodesFromGraph(chain('a', 'b', 'c'), new Set(['b']));
    expect([...g.nodes.keys()]).toEqual(['a', 'c']);
    expect(wiring(g)).toEqual(['a.out→c.in']);
  });

  it('bridges a whole run of deleted neighbours', () => {
    const g = removeNodesFromGraph(chain('a', 'b', 'c', 'd'), new Set(['b', 'c']));
    expect(wiring(g)).toEqual(['a.out→d.in']);
  });

  it('hands the output role to the deleted terminal\'s producer', () => {
    const g = removeNodesFromGraph(chain('a', 'b', 'c'), new Set(['c']));
    expect(g.output).toBe('b');
    expect(wiring(g)).toEqual(['a.out→b.in']);
  });

  it('leaves the head dangling when the source itself goes', () => {
    // Nothing fed 'a', so there is nothing to reconnect 'b' to.
    const g = removeNodesFromGraph(chain('a', 'b', 'c'), new Set(['a']));
    expect(wiring(g)).toEqual(['b.out→c.in']);
  });

  it('reconnects into the consumer\'s original port, not always "in"', () => {
    const g = chain('a', 'b');
    g.nodes.set('comp', { id: 'comp', kind: 'composite', params: {} });
    g.edges.push({ id: 'e:b→comp', from: { node: 'b', port: 'out' }, to: { node: 'comp', port: 'layer' } });
    const out = removeNodesFromGraph(g, new Set(['b']));
    expect(wiring(out)).toEqual(['a.out→comp.layer']);
  });

  it('does not duplicate an edge that already exists', () => {
    const g = chain('a', 'b', 'c');
    // 'a' already feeds 'c' directly alongside the a→b→c path.
    g.edges.push({ id: 'e:a→c', from: { node: 'a', port: 'out' }, to: { node: 'c', port: 'in' } });
    const out = removeNodesFromGraph(g, new Set(['b']));
    expect(wiring(out)).toEqual(['a.out→c.in']);
  });

  it('drops the positions of removed nodes', () => {
    const g = chain('a', 'b', 'c');
    g.metadata.nodePositions = { a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, c: { x: 2, y: 2 } };
    const out = removeNodesFromGraph(g, new Set(['b']));
    expect(out.metadata.nodePositions).toEqual({ a: { x: 0, y: 0 }, c: { x: 2, y: 2 } });
  });
});
