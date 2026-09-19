import { describe, expect, it } from 'vitest';

import { buildDocumentGraph, builderLayersForDocument, isGraphLed, maskLayersForDocument, needsDocumentGraph, preCurveStopNodeFor } from './documentGraph';
import { buildDefaultGraph, buildLayeredGraph, adjustmentsToBuilderAdjustments, type BuilderSourceSpec } from './DefaultGraphBuilder';
import { serializeGraph } from './serialize';
import { GraphCompiler } from './GraphCompiler';
import { getMainThreadNodeRegistry } from './defaultPipelineService';
import { KIND_COMPOSITE } from './compositorKinds';
import { KIND_IMAGE_BITMAP_SOURCE, KIND_RAW16_SOURCE } from './sources';
import { KIND_CROP, KIND_TONE, KIND_TONE_CURVE, KIND_OUTPUT_COLOR_SPACE, KIND_RETOUCH, KIND_TRANSFORM, KIND_WHITE_BALANCE_RAW, KIND_COLOR_MATRIX, KIND_LENS_CORRECTION, type RetouchParams, type TransformParams } from './passKinds';
import { RETOUCH_NODE_ID } from './DefaultGraphBuilder';
import type { RenderGraph } from './types';
import { OUTPUT_COLOR_SPACES } from '../outputColorSpaces';
import { createDocument, createDocLayer, documentToAdjustments, type DocLayer, type PhotoDocument } from '../DocumentModel';
import { addMaskToDocument } from '../layerMasks';
import type { MaskDefinition, SpotRemoval } from '../Mask';
import { raw16Source } from './projection/projectionFixtures';

const SDR: BuilderSourceSpec = {
  kind: 'imageBitmap',
  geometry: { width: 16, height: 8, pixelRatio: 1 },
};
const BIGGER: BuilderSourceSpec = {
  kind: 'imageBitmap',
  geometry: { width: 400, height: 200, pixelRatio: 2 },
};

const MASK: MaskDefinition = {
  id: 'm1', name: 'Radial', type: 'radial-gradient', visible: true,
  center: { x: 0.4, y: 0.6 }, radiusX: 0.3, radiusY: 0.25, feather: 0.5,
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

/** A document whose truth is a graph — built from itself, then stored. */
function graphLed(doc: PhotoDocument, source: BuilderSourceSpec = SDR): PhotoDocument {
  const graph = buildDocumentGraph(doc, source).graph;
  return { ...doc, pipelineMode: 'graph', pipelineGraph: serializeGraph(graph) };
}

const kindsOf = (g: { nodes: Map<string, { kind: string }> }) => [...g.nodes.values()].map((n) => n.kind);

describe('buildDocumentGraph', () => {
  it('is the plain single chain for a document without layers', () => {
    const doc = createDocument();
    const built = buildDocumentGraph(doc, SDR);
    const flat = buildDefaultGraph(adjustmentsToBuilderAdjustments(documentToAdjustments(doc)), SDR);
    expect([...built.graph.nodes.keys()]).toEqual([...flat.graph.nodes.keys()]);
    expect(built.fromStoredGraph).toBe(false);
    expect(built.maskLayers).toEqual([]);
  });

  it('is the layered graph as soon as a visible layer exists', () => {
    const built = buildDocumentGraph(docWith({ adjustments: { exposure: 20 } }), SDR);
    expect(kindsOf(built.graph)).toContain(KIND_COMPOSITE);
    expect(built.params.get('comp:L0')).toMatchObject({ opacity: 1 });
  });

  it('puts one document crop behind the completed layer stack and changes terminal geometry', async () => {
    const doc = docWith({ adjustments: { exposure: 20 } });
    doc.transform.crop = { x: 0.25, y: 0, width: 0.5, height: 0.75 };
    const built = buildDocumentGraph(doc, SDR);
    const crop = built.graph.nodes.get(built.graph.output)!;
    const incoming = built.graph.edges.find((edge) => edge.to.node === crop.id && edge.to.port === 'in')!;

    expect(needsDocumentGraph(doc)).toBe(true);
    expect(crop.kind).toBe(KIND_CROP);
    expect(built.graph.nodes.get(incoming.from.node)?.kind).toBe(KIND_COMPOSITE);

    const plan = await new GraphCompiler(getMainThreadNodeRegistry()).compile(built.graph);
    expect(plan.perNodeFbo.get(built.graph.output)?.geometry).toEqual({ width: 8, height: 6, pixelRatio: 1 });
  });

  it('gives each crop its own graph id because the plan cache bakes its params', () => {
    const first = createDocument();
    first.transform.crop = { x: 0, y: 0, width: 0.5, height: 1 };
    const moved: PhotoDocument = {
      ...first,
      transform: { ...first.transform, crop: { x: 0.25, y: 0, width: 0.5, height: 1 } },
    };

    const firstId = buildDocumentGraph(first, SDR).graph.id;
    const movedId = buildDocumentGraph(moved, SDR).graph.id;
    expect(firstId).not.toEqual(movedId);
    expect(buildDocumentGraph(first, SDR).graph.id).toEqual(firstId);
  });

  it('leaves out layers that do not render', () => {
    const doc = docWith(
      { id: 'hidden', visible: false },
      { id: 'muted', opacity: 0 },
      { id: 'text', type: 'text' },
      { id: 'real', adjustments: { exposure: 5 } },
    );
    expect(builderLayersForDocument(doc).map((l) => l.id)).toEqual(['real']);
  });

  it('names the mask node each masked layer needs', () => {
    const doc = docWith({ id: 'L0', mask: MASK });
    expect(maskLayersForDocument(doc)).toEqual([{ layerId: 'L0', mask: MASK, nodeId: 'mask:L0' }]);
  });

  // A mask drawn with the toolbar has to reach the engine, not just the
  // editor's own state: `addMaskToDocument` is the only way one is made, and
  // what it writes has to turn into a `mask:<layerId>` source node (F001).
  it('carries a mask added by the toolbar into the graph', () => {
    const doc = createDocument();
    const { document, layerId } = addMaskToDocument(doc, null, MASK);

    expect(maskLayersForDocument(document)).toEqual([{ layerId, mask: MASK, nodeId: `mask:${layerId}` }]);
    expect(builderLayersForDocument(document).map((l) => ({ id: l.id, useMask: l.useMask })))
      .toEqual([{ id: layerId, useMask: true }]);

    const built = buildDocumentGraph(document, SDR);
    expect(built.graph.nodes.has(`mask:${layerId}`)).toBe(true);
    expect(built.maskLayers.map((m) => m.nodeId)).toEqual([`mask:${layerId}`]);
  });
});

describe('preCurveStopNodeFor', () => {
  it('selects the base curve for a flat document and the active visible layer curve', () => {
    const flat = buildDocumentGraph(createDocument(), SDR);
    expect(preCurveStopNodeFor(flat, null)).toBe(`default:${KIND_TONE_CURVE}`);

    const layered = buildDocumentGraph(docWith(
      { id: 'visible', adjustments: { exposure: 20 } },
      { id: 'hidden', visible: false, adjustments: { exposure: 40 } },
    ), SDR);
    expect(preCurveStopNodeFor(layered, 'visible')).toBe(`layer:visible:default:${KIND_TONE_CURVE}`);
    expect(preCurveStopNodeFor(layered, 'hidden')).toBe(`default:${KIND_TONE_CURVE}`);
  });

  it('selects the first serial curve on a stored graph output path by topology, not id', () => {
    const doc = graphLed(createDocument());
    const stored = doc.pipelineGraph!;
    const originalId = `default:${KIND_TONE_CURVE}`;
    const original = stored.nodes.find((node) => node.id === originalId)!;
    const earlyId = 'arbitrary-early-curve';
    const laterId = 'arbitrary-later-curve';
    const renamedEdges = stored.edges.map((edge) => ({
      ...edge,
      from: { ...edge.from, node: edge.from.node === originalId ? earlyId : edge.from.node },
      to: { ...edge.to, node: edge.to.node === originalId ? earlyId : edge.to.node },
    }));
    const outgoing = renamedEdges.filter((edge) => edge.from.node === earlyId);
    const led: PhotoDocument = {
      ...doc,
      pipelineGraph: {
        ...stored,
        nodes: [
          ...stored.nodes.map((node) => node.id === originalId ? { ...node, id: earlyId } : node),
          { ...original, id: laterId },
        ],
        edges: [
          ...renamedEdges.filter((edge) => edge.from.node !== earlyId),
          ...outgoing.map((edge) => ({ ...edge, from: { ...edge.from, node: laterId } })),
          { id: 'early-to-later', from: { node: earlyId, port: 'out' }, to: { node: laterId, port: 'in' } },
        ],
      },
    };

    expect(preCurveStopNodeFor(buildDocumentGraph(led, SDR), null)).toBe(earlyId);
  });

  it('returns null rather than authorising a full render when no curve is on the stored output path', () => {
    const doc = graphLed(createDocument());
    const stored = doc.pipelineGraph!;
    const curveId = `default:${KIND_TONE_CURVE}`;
    const incoming = stored.edges.find((edge) => edge.to.node === curveId)!;
    const outgoing = stored.edges.find((edge) => edge.from.node === curveId)!;
    const led: PhotoDocument = {
      ...doc,
      pipelineGraph: {
        ...stored,
        nodes: stored.nodes.filter((node) => node.id !== curveId),
        edges: [
          ...stored.edges.filter((edge) => edge.to.node !== curveId && edge.from.node !== curveId),
          { id: 'curve-bypass', from: incoming.from, to: outgoing.to },
        ],
      },
    };

    expect(preCurveStopNodeFor(buildDocumentGraph(led, SDR), null)).toBeNull();
  });
});

describe('a graph-led document', () => {
  it('renders its stored graph, not one built from the adjustments', () => {
    const doc = graphLed(docWith({ adjustments: { exposure: 20 } }));
    // Turn the stored graph away from what the adjustments say. The built
    // graph would never produce this value.
    const stored = doc.pipelineGraph!;
    const patched = {
      ...stored,
      nodes: stored.nodes.map((n) => (n.kind === KIND_TONE && n.id === `default:${KIND_TONE}`
        ? { ...n, params: { ...(n.params as object), exposure: 0.99 } }
        : n)),
    };
    const led: PhotoDocument = { ...doc, pipelineGraph: patched };

    const built = buildDocumentGraph(led, SDR);
    expect(built.fromStoredGraph).toBe(true);
    expect(built.graph.nodes.get(`default:${KIND_TONE}`)!.params).toMatchObject({ exposure: 0.99 });
    // Nothing is handed in as an override: the stored nodes are the truth.
    expect([...built.params]).toEqual([]);
  });

  it('renders only what reaches the output, so a node not wired yet does not break it', () => {
    const doc = graphLed(docWith({ id: 'L0', mask: MASK, adjustments: { exposure: 10 } }));
    const stored = doc.pipelineGraph!;
    const led: PhotoDocument = {
      ...doc,
      pipelineGraph: { ...stored, nodes: [...stored.nodes, { id: 'stray', kind: KIND_TONE, params: {} }] },
    };

    const built = buildDocumentGraph(led, SDR);
    expect(built.graph.nodes.has('stray')).toBe(false);
    expect(built.maskLayers.map((m) => m.nodeId)).toEqual(['mask:L0']);
    expect(new GraphCompiler(getMainThreadNodeRegistry()).validate(built.graph)).toBeNull();
  });

  it('refreshes the source geometry from the spec it is rendered through', () => {
    // The same document renders at preview size, at full resolution and into
    // a thumbnail; the size the graph was stored at means nothing.
    const built = buildDocumentGraph(graphLed(createDocument(), SDR), BIGGER);
    const source = [...built.graph.nodes.values()].find((n) => n.kind === KIND_IMAGE_BITMAP_SOURCE)!;
    expect(source.params).toMatchObject({ width: 400, height: 200, pixelRatio: 2 });
  });

  it('binds only the masks the stored graph has an input for', () => {
    const doc = graphLed(docWith({ id: 'L0', mask: MASK, adjustments: { exposure: 10 } }));
    expect(buildDocumentGraph(doc, SDR).maskLayers.map((m) => m.nodeId)).toEqual(['mask:L0']);

    // A mask added after the graph was stored has no input to be bound to.
    const later: PhotoDocument = {
      ...doc,
      layers: doc.layers.map((l) => (l.type === 'adjustment' ? l : l)).concat([
        { ...createDocLayer('adjustment'), id: 'L9', mask: MASK },
      ]),
    };
    expect(buildDocumentGraph(later, SDR).maskLayers.map((m) => m.nodeId)).toEqual(['mask:L0']);
  });

  it('gives every geometry its own graph id, because the plan cache keys on it', () => {
    // PipelineService.compile caches by graph.id and says so: geometry
    // belongs in the id. A stored graph carries the id it was built with,
    // so without this the editor and the 300px thumbnail share one plan —
    // measured in the app as a 300x150 editor canvas and a tiled export.
    const doc = graphLed(docWith({ adjustments: { exposure: 20 } }), SDR);
    const small = buildDocumentGraph(doc, SDR).graph.id;
    const big = buildDocumentGraph(doc, BIGGER).graph.id;
    expect(small).not.toEqual(big);
    expect(big).toContain('400x200');
    // Same geometry, same id — otherwise nothing would ever be cached.
    expect(buildDocumentGraph(doc, BIGGER).graph.id).toEqual(big);
  });

  it('gives two stored graphs of one size and revision their own id when their params differ', () => {
    // A stored graph hands in no param map, so its baked params reach the
    // plan cache through the id or not at all.
    const doc = graphLed(docWith({ adjustments: { exposure: 20 } }), SDR);
    const stored = doc.pipelineGraph!;
    const other: PhotoDocument = {
      ...doc,
      pipelineGraph: {
        ...stored,
        nodes: stored.nodes.map((n) => (n.id === `default:${KIND_TONE}`
          ? { ...n, params: { ...(n.params as object), exposure: 0.55 } }
          : n)),
      },
    };
    expect(other.pipelineGraph!.id).toBe(stored.id);
    expect(other.pipelineGraph!.metadata.revision).toBe(stored.metadata.revision);
    expect(buildDocumentGraph(other, SDR).graph.id).not.toBe(buildDocumentGraph(doc, SDR).graph.id);
  });

  it('keeps the id when only node positions or the revision change', () => {
    const doc = graphLed(docWith({ adjustments: { exposure: 20 } }), SDR);
    const stored = doc.pipelineGraph!;
    const moved: PhotoDocument = {
      ...doc,
      pipelineGraph: {
        ...stored,
        metadata: {
          ...stored.metadata,
          revision: stored.metadata.revision + 6,
          nodePositions: { [`default:${KIND_TONE}`]: { x: 10, y: 20 } },
        },
      },
    };
    expect(buildDocumentGraph(moved, SDR).graph.id).toBe(buildDocumentGraph(doc, SDR).graph.id);
  });

  it('gives a stored RAW graph a new id when the camera profile under it changes', () => {
    // Stored without a base stage; the profile is spliced in per render.
    const doc = graphLed(docWith({ adjustments: { exposure: 20 } }), raw16Source());
    const withProfile = (exposure: number) => raw16Source({ baseAdjustments: { exposure } });
    expect(buildDocumentGraph(doc, withProfile(30)).graph.id)
      .not.toBe(buildDocumentGraph(doc, withProfile(-40)).graph.id);
  });

  it('is not graph-led without the flag — which is how old documents behave', () => {
    // Documents from the two-truths world carry a pipelineGraph and no flag.
    // The adjustments were leading back then, and they stay leading.
    const doc = docWith({ adjustments: { exposure: 20 } });
    const stale: PhotoDocument = {
      ...doc,
      pipelineGraph: serializeGraph(buildLayeredGraph({}, [], SDR).graph),
    };
    expect(isGraphLed(stale)).toBe(false);
    expect(buildDocumentGraph(stale, SDR).fromStoredGraph).toBe(false);
    expect(kindsOf(buildDocumentGraph(stale, SDR).graph)).toContain(KIND_COMPOSITE);
  });

  it('renders a stored graph in the space the CALLER asks for, not the stored one', () => {
    // A stored graph carries the output space that was set when it was saved.
    // Which space the pixels come out in is a property of the destination -
    // canvas, thumbnail, Adobe-RGB export file - so it gets rewritten per
    // caller exactly like the source geometry (F030).
    const wide: BuilderSourceSpec = { ...SDR, outputColorSpaceId: 'prophoto' };
    const led = graphLed(createDocument(), wide);
    const stored = led.pipelineGraph!.nodes.find((n) => n.kind === KIND_OUTPUT_COLOR_SPACE)!;
    expect(stored.params).toMatchObject({ matrix: OUTPUT_COLOR_SPACES['prophoto'].matrix });

    const built = buildDocumentGraph(led, { ...SDR, outputColorSpaceId: 'srgb' });
    const ocs = [...built.graph.nodes.values()].find((n) => n.kind === KIND_OUTPUT_COLOR_SPACE)!;
    expect(ocs.params).toMatchObject({
      matrix: OUTPUT_COLOR_SPACES['srgb'].matrix,
      gammaType: 0,
    });
    // …and the two do not share a plan-cache slot.
    expect(built.graph.id).not.toBe(buildDocumentGraph(led, wide).graph.id);
  });

  it('is not graph-led with a flag but no graph', () => {
    const doc: PhotoDocument = { ...createDocument(), pipelineMode: 'graph' };
    expect(isGraphLed(doc)).toBe(false);
    expect(buildDocumentGraph(doc, SDR).fromStoredGraph).toBe(false);
  });
});

/**
 * The retouch node (F009, AP06 variant A2). What matters here is WHERE it
 * lands and whether the plan cache can tell two sets of spots apart — the
 * pixels it produces are measured in `compat/retouch.browser.test.ts`.
 */
const SPOT: SpotRemoval = {
  id: 's1', mode: 'heal',
  target: { x: 0.5, y: 0.5, radius: 0.1 },
  source: { x: 0.2, y: 0.5 },
  feather: 0.5, opacity: 1,
};

/** Node ids in flow order along `in`, starting at `from`. Stops at a fork. */
function chainFrom(graph: RenderGraph, from: string): string[] {
  const out: string[] = [];
  let cursor = from;
  for (;;) {
    const next = graph.edges.filter((e) => e.from.node === cursor && e.to.port === 'in');
    if (next.length !== 1) return out;
    cursor = next[0].to.node;
    if (out.includes(cursor)) return out;
    out.push(cursor);
  }
}

const retouchNodes = (g: RenderGraph) =>
  [...g.nodes.values()].filter((n) => n.kind === KIND_RETOUCH).map((n) => n.id);

const SECOND_TRANSFORM: TransformParams = {
  rotation: Math.PI / 4,
  flipH: false,
  flipV: false,
  perspectiveH: 0,
  perspectiveV: 0,
  distortion: 0,
};

function appendTransform(graph: RenderGraph, id: string, params: TransformParams): RenderGraph {
  const nodes = new Map(graph.nodes);
  nodes.set(id, { id, kind: KIND_TRANSFORM, params });
  return {
    ...graph,
    nodes,
    edges: [...graph.edges, {
      id: `e:${graph.output}→${id}`,
      from: { node: graph.output, port: 'out' },
      to: { node: id, port: 'in' },
    }],
    output: id,
  };
}

describe('buildDocumentGraph: retouch', () => {
  it('adds no node at all when the document has no spots', () => {
    // An unretouched document has to build the graph it always built — same
    // nodes, same id — or every compile-cache slot and every export filename
    // moves for nothing.
    const plain = buildDocumentGraph(createDocument(), SDR).graph;
    const empty = buildDocumentGraph({ ...createDocument(), retouch: [] }, SDR).graph;
    expect(retouchNodes(plain)).toEqual([]);
    expect([...empty.nodes.keys()]).toEqual([...plain.nodes.keys()]);
    expect(empty.id).toEqual(plain.id);
  });

  it('puts exactly one node right behind the source on an SDR document', () => {
    const doc: PhotoDocument = { ...createDocument(), retouch: [SPOT] };
    const built = buildDocumentGraph(doc, SDR).graph;
    expect(retouchNodes(built)).toEqual([RETOUCH_NODE_ID]);
    // SDR has no base stage, so "behind the base stage" is the head of the
    // chain: before the first pass the user's sliders own.
    const sourceId = [...built.nodes.values()].find((n) => n.kind === KIND_IMAGE_BITMAP_SOURCE)!.id;
    expect(chainFrom(built, sourceId)[0]).toBe(RETOUCH_NODE_ID);
  });

  it('puts it behind the camera profile, not in front of it, on a RAW document', () => {
    const source = raw16Source({ baseAdjustments: { exposure: 30 } });
    const doc: PhotoDocument = { ...createDocument(), retouch: [SPOT] };
    const built = buildDocumentGraph(doc, source).graph;
    const sourceId = [...built.nodes.values()].find((n) => n.kind === KIND_RAW16_SOURCE)!.id;
    const chain = chainFrom(built, sourceId);
    const at = chain.indexOf(RETOUCH_NODE_ID);
    expect(at).toBeGreaterThan(0);
    // Nothing but the sensor's own prefix and the profile's linear nodes
    // ahead of it…
    expect(chain.slice(0, at).every((id) => id.startsWith('base:')
      || id === `default:${KIND_WHITE_BALANCE_RAW}` || id === `default:${KIND_COLOR_MATRIX}`)).toBe(true);
    // …and the user's first pass right behind it. (The profile's gamma
    // block sits further down, behind the output-space node, where the user's
    // own gamma passes are.)
    expect(chain[at - 1]).toMatch(/^base:/);
    expect(chain[at + 1]).toBe(`default:${KIND_LENS_CORRECTION}`);
  });

  it('gives every branch of a layered document its own node', () => {
    // One node feeding several chains would be a fan-out only the source is
    // allowed (shapeScan), and would lock the document in graph mode.
    const doc: PhotoDocument = { ...docWith({ adjustments: { exposure: 20 } }), retouch: [SPOT] };
    const built = buildDocumentGraph(doc, SDR).graph;
    expect(retouchNodes(built).sort()).toEqual([RETOUCH_NODE_ID, `layer:L0:${RETOUCH_NODE_ID}`].sort());
    for (const id of retouchNodes(built)) {
      expect(built.edges.filter((e) => e.from.node === id)).toHaveLength(1);
    }
  });

  it('carries the spots in the graph id', () => {
    // Plans are cached by `graph.id` alone and these params are baked into
    // the node, so without this a moved spot renders the previous plan.
    const doc: PhotoDocument = { ...createDocument(), retouch: [SPOT] };
    const moved: PhotoDocument = {
      ...doc,
      retouch: [{ ...SPOT, target: { ...SPOT.target, x: 0.9 } }],
    };
    const plain = buildDocumentGraph(createDocument(), SDR).graph.id;
    expect(buildDocumentGraph(doc, SDR).graph.id).not.toBe(plain);
    expect(buildDocumentGraph(moved, SDR).graph.id).not.toBe(buildDocumentGraph(doc, SDR).graph.id);
    // Same spots, same id — otherwise nothing would ever be cached.
    expect(buildDocumentGraph(doc, SDR).graph.id).toBe(buildDocumentGraph(doc, SDR).graph.id);
  });

  it('sends a retouched photo down the document path on the canvas', () => {
    // The canvas picks between the flat chain and the document graph, and the
    // flat chain is built from the adjustments alone - it cannot know about
    // spots. A retouched photo that answered "no" here would be the one
    // surface showing an unretouched picture.
    expect(needsDocumentGraph(createDocument())).toBe(false);
    expect(needsDocumentGraph({ ...createDocument(), retouch: [] })).toBe(false);
    expect(needsDocumentGraph({ ...createDocument(), retouch: [SPOT] })).toBe(true);
    expect(needsDocumentGraph(docWith({ adjustments: { exposure: 20 } }))).toBe(true);
    expect(needsDocumentGraph(graphLed(createDocument(), SDR))).toBe(true);
    expect(needsDocumentGraph(null)).toBe(false);
  });

  it('splices into a stored graph too, and the id follows the spots', () => {
    const led = graphLed(createDocument(), SDR);
    const withSpot: PhotoDocument = { ...led, retouch: [SPOT] };
    const built = buildDocumentGraph(withSpot, SDR).graph;
    expect(retouchNodes(built)).toEqual([RETOUCH_NODE_ID]);
    expect(built.id).not.toBe(buildDocumentGraph(led, SDR).graph.id);
  });

  it('keeps the standard transform singular and carries every custom-chain transform in flow order', () => {
    const base = createDocument();
    base.transform.flipH = true;

    const standard = buildDocumentGraph({ ...base, retouch: [SPOT] }, SDR).graph;
    const standardParams = standard.nodes.get(RETOUCH_NODE_ID)!.params as RetouchParams;
    expect(standardParams.displayTransform).toMatchObject({ flipH: true });
    expect(standardParams.displayTransforms).toBeUndefined();

    const firstGraph = buildDocumentGraph(base, SDR).graph;
    const custom = appendTransform(firstGraph, 'custom:transform:2', SECOND_TRANSFORM);
    const led: PhotoDocument = {
      ...base,
      retouch: [SPOT],
      pipelineMode: 'graph',
      pipelineGraph: serializeGraph(custom),
    };
    const params = buildDocumentGraph(led, SDR).graph.nodes.get(RETOUCH_NODE_ID)!.params as RetouchParams;

    expect(params.displayTransform).toBeUndefined();
    expect(params.displayTransforms).toEqual([
      firstGraph.nodes.get(firstGraph.output)!.params,
      SECOND_TRANSFORM,
    ]);
  });
});
