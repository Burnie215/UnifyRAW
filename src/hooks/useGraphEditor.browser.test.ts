/**
 * The hook's two promises about revisions, measured in a real React that
 * really does call an updater twice.
 *
 * `StrictMode` double-invokes state updaters in development, which is exactly
 * the condition F126 describes: a counter raised INSIDE the updater hands the
 * two calls two different revisions for one edit, and plan caches keyed on
 * (id, revision) then serve a plan that was never asked for. Only a browser
 * project gives us React with a DOM, so this lives here rather than next to
 * the pure-helper tests in `useGraphEditor.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useGraphEditor, type GraphEditorActions, type GraphEditorState } from './useGraphEditor';
import type { RenderGraph } from '../engine/graph';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function graphAt(revision: number, ids: string[] = ['a', 'b']): RenderGraph {
  return {
    id: 'g',
    nodes: new Map(ids.map((id) => [id, { id, kind: 'tone', params: { exposure: 0 } }])),
    edges: [],
    output: ids[ids.length - 1],
    metadata: { createdAt: 0, updatedAt: 0, revision },
  };
}

interface Harness {
  state: GraphEditorState;
  actions: GraphEditorActions;
  run(fn: (actions: GraphEditorActions) => void): void;
  unmount(): void;
}

function mount(initial: RenderGraph): Harness {
  // A box, not a bare variable: the lint rule against writing module state
  // during render is right in general, and here the write IS the measurement.
  const probe: { last: [GraphEditorState, GraphEditorActions] | null } = { last: null };
  function Probe() {
    probe.last = useGraphEditor(initial);
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root;
  act(() => {
    root = createRoot(host);
    root.render(createElement(StrictMode, null, createElement(Probe)));
  });
  const current = () => {
    if (!probe.last) throw new Error('probe never rendered');
    return probe.last;
  };
  return {
    get state() { return current()[0]; },
    get actions() { return current()[1]; },
    run(fn) { act(() => fn(current()[1])); },
    unmount() { act(() => root.unmount()); host.remove(); },
  };
}

describe('useGraphEditor revisions', () => {
  it('stamps one revision per edit, however often React calls the updater', () => {
    const harness = mount(graphAt(5));
    try {
      harness.run((a) => a.setNodeParams('a', { exposure: 0.4 }));
      expect(harness.state.graph.metadata.revision).toBe(6);

      harness.run((a) => a.setNodeParams('a', { exposure: 0.6 }));
      expect(harness.state.graph.metadata.revision).toBe(7);
    } finally {
      harness.unmount();
    }
  });

  it('stamps a graph played back from the document above everything seen', () => {
    // C6: a restored graph carries old CONTENT. Handing back a revision that
    // a plan cache has already seen for a different topology would serve the
    // undone plan.
    const harness = mount(graphAt(5));
    try {
      harness.run((a) => a.setNodeParams('a', { exposure: 0.4 }));
      harness.run((a) => a.setNodeParams('a', { exposure: 0.6 }));
      expect(harness.state.graph.metadata.revision).toBe(7);

      harness.run((a) => a.setGraph(graphAt(3)));
      expect(harness.state.graph.metadata.revision).toBeGreaterThan(7);

      harness.run((a) => a.setNodeParams('a', { exposure: 0.8 }));
      expect(harness.state.graph.metadata.revision).toBeGreaterThan(8);
    } finally {
      harness.unmount();
    }
  });

  it('keeps a selection whose nodes survive the play-back', () => {
    const harness = mount(graphAt(1, ['a', 'b', 'c']));
    try {
      harness.run((a) => { a.select('a'); a.selectAdd('b'); });
      expect([...harness.state.selection].sort()).toEqual(['a', 'b']);

      harness.run((a) => a.setGraph(graphAt(2, ['a', 'b', 'c'])));
      expect([...harness.state.selection].sort()).toEqual(['a', 'b']);

      harness.run((a) => a.setGraph(graphAt(3, ['a', 'c'])));
      expect([...harness.state.selection]).toEqual(['a']);
    } finally {
      harness.unmount();
    }
  });
});
