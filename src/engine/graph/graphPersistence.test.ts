import { describe, expect, it } from 'vitest';

import {
  documentAfterGraphChange,
  documentAfterGraphEdit,
  documentAfterReturnToClassic,
  withStoredLayout,
} from './graphPersistence';
import { buildDocumentGraph } from './documentGraph';
import { hydrateGraph, serializeGraph } from './serialize';
import { KIND_TONE } from './passKinds';
import { KIND_CUSTOM_LUT } from './lutKinds';
import { withDocumentCrop, type BuilderSourceSpec } from './DefaultGraphBuilder';
import { createDocument, createDocLayer, documentToAdjustments, type DocLayer, type PhotoDocument } from '../DocumentModel';
import type { RenderGraph } from './types';

const SOURCE: BuilderSourceSpec = {
  kind: 'imageBitmap',
  geometry: { width: 400, height: 200, pixelRatio: 1 },
};

function docWith(...layers: Partial<DocLayer>[]): PhotoDocument {
  const base = createDocument();
  return {
    ...base,
    layers: [
      ...base.layers,
      ...layers.map((over, i) => ({ ...createDocLayer('adjustment'), id: `L${i}`, ...over })),
    ],
  };
}

/** The graph the editor shows for this document, untouched. */
const graphOf = (doc: PhotoDocument): RenderGraph => buildDocumentGraph(doc, SOURCE).graph;

/** The same graph after the user dragged a node somewhere. */
function moved(graph: RenderGraph): RenderGraph {
  return {
    ...graph,
    metadata: { ...graph.metadata, nodePositions: { [`default:${KIND_TONE}`]: { x: 640, y: 120 } } },
  };
}

/** The same graph with a custom LUT spliced in front of the output — the
 *  plan's example of an edit the classic view cannot say. */
function withCustomLut(graph: RenderGraph, id = 'lut:1'): RenderGraph {
  const nodes = new Map(graph.nodes);
  nodes.set(id, { id, kind: KIND_CUSTOM_LUT, params: { size: 2, data: [] } });
  const edges = graph.edges.map((e) => (
    e.to.node === graph.output && e.to.port === 'in'
      ? { ...e, to: { node: id, port: 'in' } }
      : e
  ));
  edges.push({ id: `e:${id}->out`, from: { node: id, port: 'out' }, to: { node: graph.output, port: 'in' } });
  return { ...graph, nodes, edges };
}

/** The same graph with a param turned away from what the document says. */
function turned(graph: RenderGraph): RenderGraph {
  const nodes = new Map(graph.nodes);
  const tone = nodes.get(`default:${KIND_TONE}`)!;
  nodes.set(tone.id, { ...tone, params: { ...(tone.params as object), exposure: 0.42 } });
  return { ...graph, nodes };
}

describe('what a graph edit writes back', () => {
  it('projects a crop-node edit into the document without making it graph-led', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const cropped = withDocumentCrop(graphOf(doc), { x: 0.25, y: 0, width: 0.5, height: 1 });
    const after = documentAfterGraphEdit(doc, cropped, SOURCE);

    expect(after.blocked).toEqual([]);
    expect(after.document.transform.crop).toEqual({ x: 0.25, y: 0, width: 0.5, height: 1 });
    expect(after.document.pipelineMode).toBeUndefined();
    expect(after.document.pipelineGraph).toBeUndefined();
  });

  it('stores the layout alone when the graph says nothing new', () => {
    // The bug: every change stored the whole serialized graph, a node nudged
    // by two pixels included — and nothing ever removed it again.
    const doc = docWith({ adjustments: { exposure: 20 } });
    const after = documentAfterGraphChange(doc, moved(graphOf(doc)), SOURCE, false);

    expect(after.pipelineGraph).toBeUndefined();
    expect(after.graphLayout).toEqual({ [`default:${KIND_TONE}`]: { x: 640, y: 120 } });
    expect(after.pipelineMode).toBeUndefined();
  });

  it('stores the whole graph as soon as it deviates', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const after = documentAfterGraphChange(doc, turned(graphOf(doc)), SOURCE, false);

    expect(after.pipelineGraph).toBeDefined();
    expect(after.graphLayout).toBeUndefined();
    // Not graph-led — the gate did not block, the classic view still leads.
    expect(after.pipelineMode).toBeUndefined();
  });

  it('stores the whole graph and flips the flag when the gate blocks', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const after = documentAfterGraphChange(doc, moved(graphOf(doc)), SOURCE, true);

    expect(after.pipelineGraph).toBeDefined();
    expect(after.pipelineMode).toBe('graph');
  });

  it('keeps storing the graph of a photo that is already graph-led', () => {
    // Its truth IS the graph; dropping it would change the picture.
    const doc: PhotoDocument = { ...docWith({ adjustments: { exposure: 20 } }), pipelineMode: 'graph' };
    const after = documentAfterGraphChange(doc, moved(graphOf(doc)), SOURCE, false);

    expect(after.pipelineGraph).toBeDefined();
    expect(after.pipelineMode).toBe('graph');
  });

  it('drops the graph on the way back to the classic view, keeping the layout', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const led = documentAfterGraphChange(doc, moved(graphOf(doc)), SOURCE, true);
    expect(led.pipelineGraph).toBeDefined();

    // The blocking nodes are gone, the user picks classic again.
    const back = documentAfterReturnToClassic(led, moved(graphOf(doc)), SOURCE);
    expect(back.pipelineMode).toBe('classic');
    expect(back.pipelineGraph).toBeUndefined();
    expect(back.graphLayout).toEqual({ [`default:${KIND_TONE}`]: { x: 640, y: 120 } });
  });

  it('keeps a deviating graph even on the way back — nothing arranged is lost', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const back = documentAfterReturnToClassic(doc, turned(graphOf(doc)), SOURCE);
    expect(back.pipelineMode).toBe('classic');
    expect(back.pipelineGraph).toBeDefined();
  });

  it('hands the remembered layout to a freshly built graph', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const stored = documentAfterGraphChange(doc, moved(graphOf(doc)), SOURCE, false);

    const fresh = withStoredLayout(graphOf(doc), stored);
    expect(fresh.metadata.nodePositions).toMatchObject({
      [`default:${KIND_TONE}`]: { x: 640, y: 120 },
    });
  });

  it('is cheap: the layout weighs a fraction of the graph', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const graph = moved(graphOf(doc));
    const withGraph = JSON.stringify({ ...doc, pipelineGraph: serializeGraph(graph) }).length;
    const withLayout = JSON.stringify(documentAfterGraphChange(doc, graph, SOURCE, false)).length;
    expect(withLayout * 10).toBeLessThan(withGraph);
  });

  it('survives the round trip through storage', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const after = documentAfterGraphChange(doc, turned(graphOf(doc)), SOURCE, false);
    const reloaded: PhotoDocument = JSON.parse(JSON.stringify(after));
    expect(hydrateGraph(reloaded.pipelineGraph!).nodes.get(`default:${KIND_TONE}`)!.params)
      .toMatchObject({ exposure: 0.42 });
  });
});

describe('a graph edit with the document as the one truth', () => {
  it('projects a param turned at a default node into the document, graph-free', () => {
    // The bug (F003): this was stored as a deviating graph and dropped again
    // on the next entry, because `syncDefaultNodeParams` rewrites default:*
    // from the sliders. Projected, the slider IS the change.
    const doc = docWith({ adjustments: { exposure: 20 } });
    const { document: after, blocked } = documentAfterGraphEdit(doc, turned(graphOf(doc)), SOURCE);

    expect(blocked).toEqual([]);
    expect(documentToAdjustments(after).exposure).toBeCloseTo(42, 6);
    expect(after.pipelineGraph).toBeUndefined();
    expect(after.pipelineMode).toBeUndefined();
  });

  it('stores the graph and flips the flag when a node blocks the way back', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const { document: after, blocked } = documentAfterGraphEdit(doc, withCustomLut(graphOf(doc)), SOURCE);

    expect(blocked.map((b) => b.nodeId)).toContain('lut:1');
    expect(after.pipelineMode).toBe('graph');
    expect(after.pipelineGraph).toBeDefined();
    // The blocking edit is not projectable, so the sliders stay where they were.
    expect(after.layers).toEqual(doc.layers);
  });

  it('hands back the same document when the graph says nothing new', () => {
    // Identity, not equality: the document writer treats `prev` unchanged as
    // "no write", which is what keeps a mere selection out of the history.
    const doc = docWith({ adjustments: { exposure: 20 } });
    const { document: after } = documentAfterGraphEdit(doc, graphOf(doc), SOURCE);

    expect(after).toBe(doc);
  });

  it('writes a moved node as a layout change and nothing else', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const { document: after } = documentAfterGraphEdit(doc, moved(graphOf(doc)), SOURCE);

    expect(after).not.toBe(doc);
    expect(after.graphLayout).toEqual({ [`default:${KIND_TONE}`]: { x: 640, y: 120 } });
    expect({ ...after, graphLayout: undefined }).toEqual({ ...doc, graphLayout: undefined });
  });

  it('does not mistake a bumped revision for an edit', () => {
    // Every mutation stamps a fresh revision and timestamp; on a graph-led
    // photo that must not become 50 history entries of the same picture.
    const doc = docWith({ adjustments: { exposure: 20 } });
    const led = documentAfterGraphEdit(doc, withCustomLut(graphOf(doc)), SOURCE).document;
    const again = withCustomLut(graphOf(doc));
    again.metadata = { ...again.metadata, revision: again.metadata.revision + 7, updatedAt: Date.now() + 1000 };

    expect(documentAfterGraphEdit(led, again, SOURCE).document).toBe(led);
  });

  it('sees the wiring of a graph-led photo as the edit it is', () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    const led = documentAfterGraphEdit(doc, withCustomLut(graphOf(doc)), SOURCE).document;
    const rewired = withCustomLut(graphOf(doc), 'lut:2');

    expect(documentAfterGraphEdit(led, rewired, SOURCE).document).not.toBe(led);
  });
});
