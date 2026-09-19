import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  compileThumbnailPlan,
  thumbnailColorSpace,
  thumbnailGraph,
  type ThumbJob,
} from './ThumbnailRenderer';
import {
  buildDefaultGraph,
  adjustmentsToBuilderAdjustments,
  type BuilderSourceSpec,
} from './graph';
import { KIND_COMPOSITE } from './graph/compositorKinds';
import { KIND_IMAGE_BITMAP_SOURCE } from './graph/sources';
import { KIND_CROP, KIND_HSL_DETAIL, KIND_OUTPUT_COLOR_SPACE, KIND_RETOUCH, KIND_TONE } from './graph/passKinds';
import { serializeGraph } from './graph/serialize';
import { buildDocumentGraph } from './graph/documentGraph';
import {
  createDocument,
  createDocLayer,
  documentToAdjustments,
  type DocLayer,
  type PhotoDocument,
} from './DocumentModel';
import type { Adjustments } from '../types';
import type { MaskDefinition, SpotRemoval } from './Mask';
import type { DocumentGraph } from './graph';
import { OUTPUT_COLOR_SPACES, getOutputColorSpace } from './outputColorSpaces';
import { STORAGE_KEYS } from '../platform/storageKeys';

/** A thumbnail is small, and never the size the graph was stored at. */
const THUMB: BuilderSourceSpec = {
  kind: 'imageBitmap',
  geometry: { width: 300, height: 200, pixelRatio: 1 },
};
const EDITOR: BuilderSourceSpec = {
  kind: 'imageBitmap',
  geometry: { width: 1600, height: 1067, pixelRatio: 2 },
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

/** Graph-led, stored while the editor was set to a wider space than sRGB. */
function graphLedInDisplayP3(): PhotoDocument {
  const doc = docWith({ adjustments: { exposure: 20 } });
  const stored = serializeGraph(
    buildDocumentGraph(doc, { ...EDITOR, outputColorSpaceId: 'display-p3' }).graph,
  );
  return { ...doc, pipelineMode: 'graph', pipelineGraph: stored };
}

function jobFor(document?: PhotoDocument, adjustments?: Adjustments): ThumbJob {
  return {
    contentHash: 'hash',
    adjustments: adjustments ?? (document ? documentToAdjustments(document) : ({} as Adjustments)),
    document,
  };
}

/** Graph-led: the document's truth is its stored graph, turned away from
 *  what the adjustments say so the two can be told apart. */
function graphLedWithExposure(exposure: number): PhotoDocument {
  const doc = docWith({ adjustments: { exposure: 20 } });
  const stored = serializeGraph(buildDocumentGraph(doc, EDITOR).graph);
  return {
    ...doc,
    pipelineMode: 'graph',
    pipelineGraph: {
      ...stored,
      nodes: stored.nodes.map((n) => (n.id === `default:${KIND_TONE}`
        ? { ...n, params: { ...(n.params as object), exposure } }
        : n)),
    },
  };
}

describe('thumbnailGraph', () => {
  it('carries persisted skin-tone uniformity even when another color-editor tab is selected', () => {
    const doc = createDocument();
    doc.layers[0].adjustments = {
      colorEditorMode: 'basic',
      skinToneUniformity: { hue: 40, saturation: 0, luminance: 0 },
    };
    const spec = thumbnailGraph(jobFor(doc), THUMB);
    const params = spec.params.get(`default:${KIND_HSL_DETAIL}`) as {
      skinTone?: { uniHue: number };
    };

    expect(params.skinTone?.uniHue).toBe(0.4);
  });

  it('renders the stored graph for a graph-led photo, not the adjustments', () => {
    // The library used to show the layered graph built from the adjustments
    // while the editor showed the stored one — two pictures for one photo.
    const spec = thumbnailGraph(jobFor(graphLedWithExposure(0.99)), THUMB);
    expect(spec.fromStoredGraph).toBe(true);
    expect(spec.graph.nodes.get(`default:${KIND_TONE}`)!.params)
      .toMatchObject({ exposure: 0.99 });
    expect([...spec.params]).toEqual([]);
  });

  it('renders a stored graph at thumbnail geometry, not at the size it was stored at', () => {
    const spec = thumbnailGraph(jobFor(graphLedWithExposure(0.5)), THUMB);
    const source = [...spec.graph.nodes.values()]
      .find((n) => n.kind === KIND_IMAGE_BITMAP_SOURCE)!;
    expect(source.params).toMatchObject({ width: 300, height: 200, pixelRatio: 1 });
    // …and it really is the stored graph that got resized, not a fresh one
    // built at thumbnail size.
    expect(spec.graph.nodes.get(`default:${KIND_TONE}`)!.params)
      .toMatchObject({ exposure: 0.5 });
  });

  it('carries the document retouch into the thumbnail, at thumbnail size', () => {
    // The gallery tile has to show the retouched picture the editor shows.
    // It gets it for free by asking `buildDocumentGraph` - the point of
    // having one mapping - and this is what proves it still does.
    const spot: SpotRemoval = {
      id: 's1', mode: 'clone',
      target: { x: 0.5, y: 0.5, radius: 0.1 },
      source: { x: 0.2, y: 0.5 },
      feather: 0.5, opacity: 1,
    };
    const doc: PhotoDocument = { ...createDocument(), retouch: [spot] };
    const spec = thumbnailGraph(jobFor(doc), THUMB);
    const node = [...spec.graph.nodes.values()].find((n) => n.kind === KIND_RETOUCH);
    expect(node).toBeDefined();
    // Fractions, so the same spot covers the same part of a 300px tile as of
    // a 1600px canvas - the radius is not a pixel count any more.
    expect(node!.params).toMatchObject({ spots: [{ tx: 0.5, ty: 0.5, r: 0.1, mode: 'clone' }] });
    expect(thumbnailGraph(jobFor(doc), EDITOR).graph.nodes.get(node!.id)!.params)
      .toEqual(node!.params);
  });

  it('carries the saved document crop into the thumbnail at thumbnail geometry', () => {
    const doc = createDocument();
    doc.transform.crop = { x: 0.1, y: 0.2, width: 0.5, height: 0.75 };

    const spec = thumbnailGraph(jobFor(doc), THUMB);
    const crop = spec.graph.nodes.get(spec.graph.output)!;

    expect(crop).toMatchObject({
      kind: KIND_CROP,
      params: { x: 0.1, y: 0.2, width: 0.5, height: 0.75 },
    });
  });

  it('keeps the layer stack for a classic document', () => {
    const spec = thumbnailGraph(jobFor(docWith({ adjustments: { exposure: 20 } })), THUMB);
    expect([...spec.graph.nodes.values()].map((n) => n.kind)).toContain(KIND_COMPOSITE);
    expect(spec.fromStoredGraph).toBe(false);
  });

  it('hands the masks out to be bound instead of dropping them', () => {
    // The old renderSpec forced useMask: false, so a masked layer rendered
    // over the whole frame. Now the mask node exists and its bitmap is bound.
    const spec = thumbnailGraph(jobFor(docWith({ id: 'L0', mask: MASK })), THUMB);
    expect(spec.maskLayers.map((m) => m.nodeId)).toEqual(['mask:L0']);
    expect(spec.graph.nodes.has('mask:L0')).toBe(true);
  });

  it('is the plain single chain for a job that carries only adjustments', () => {
    // Sync rows written before documents existed still arrive this way.
    const adjustments = { exposure: 0.4 } as Adjustments;
    const spec = thumbnailGraph(jobFor(undefined, adjustments), THUMB);
    const flat = buildDefaultGraph(adjustmentsToBuilderAdjustments(adjustments), THUMB);
    expect([...spec.graph.nodes.keys()]).toEqual([...flat.graph.nodes.keys()]);
    expect(spec.maskLayers).toEqual([]);
    expect(spec.fromStoredGraph).toBe(false);
  });
});

describe('stored thumbnail graph compilation', () => {
  function brokenSpec(fromStoredGraph: boolean): DocumentGraph {
    const spec = thumbnailGraph(jobFor(graphLedWithExposure(0.5)), THUMB);
    return {
      ...spec,
      fromStoredGraph,
      graph: {
        ...spec.graph,
        edges: spec.graph.edges.filter((edge) => edge.to.node !== spec.graph.output),
      },
    };
  }

  it('quietly skips an incomplete stored graph and keeps the prior thumbnail', async () => {
    const compile = vi.fn(async () => ({ planId: 'unexpected' }));

    await expect(compileThumbnailPlan(brokenSpec(true), compile)).resolves.toBeNull();
    expect(compile).not.toHaveBeenCalled();
  });

  it('does not hide the same invalid shape when our own builder claims it', async () => {
    const failure = new Error('builder graph compile failed');
    const compile = vi.fn(async () => { throw failure; });

    await expect(compileThumbnailPlan(brokenSpec(false), compile)).rejects.toBe(failure);
    expect(compile).toHaveBeenCalledOnce();
  });
});

/** The source spec the renderer really builds, at both of its call sites. */
function thumbSource(): BuilderSourceSpec {
  return { ...THUMB, outputColorSpaceId: thumbnailColorSpace() };
}

function outputColorSpaceParams(spec: DocumentGraph): Record<string, unknown> {
  const node = [...spec.graph.nodes.values()].find((n) => n.kind === KIND_OUTPUT_COLOR_SPACE);
  return (node?.params ?? {}) as Record<string, unknown>;
}

function storeSetting(value: string): void {
  const values = new Map<string, string>([[STORAGE_KEYS.outputColorSpace, value]]);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
    clear: () => values.clear(),
    key: (i: number) => [...values.keys()][i] ?? null,
    get length() { return values.size; },
  } satisfies Storage);
}

describe('thumbnail colour space', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('stays sRGB while the editor setting says Display-P3', () => {
    // A thumbnail is an untagged JPEG in an <img>, which the browser reads as
    // sRGB whatever it was rendered in - so following the setting only ever
    // moved the numbers, never the picture on screen (F124).
    storeSetting('display-p3');
    expect(getOutputColorSpace()).toBe('display-p3');

    const spec = thumbnailGraph(jobFor(undefined, { exposure: 0.4 } as Adjustments), thumbSource());
    expect(outputColorSpaceParams(spec)).toMatchObject({
      matrix: OUTPUT_COLOR_SPACES['srgb'].matrix,
      gammaType: OUTPUT_COLOR_SPACES['srgb'].gammaType,
    });
  });

  it('overrides the space a graph-led photo was stored with', () => {
    // The stored graph carries the space that was set when it was saved; the
    // thumbnail renders through the same rewrite the export uses (F030), so
    // the tile follows the thumbnail's space and not the frozen one.
    storeSetting('display-p3');
    const doc = graphLedInDisplayP3();
    expect(outputColorSpaceParams(thumbnailGraph(jobFor(doc), {
      ...THUMB, outputColorSpaceId: 'display-p3',
    }))).toMatchObject({ matrix: OUTPUT_COLOR_SPACES['display-p3'].matrix });

    expect(outputColorSpaceParams(thumbnailGraph(jobFor(doc), thumbSource()))).toMatchObject({
      matrix: OUTPUT_COLOR_SPACES['srgb'].matrix,
      gammaType: OUTPUT_COLOR_SPACES['srgb'].gammaType,
    });
  });
});
