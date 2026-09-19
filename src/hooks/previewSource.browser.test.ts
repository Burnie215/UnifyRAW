/**
 * The graph editor's preview source against a RAW document's graph, on real
 * WebGL2.
 *
 * A RAW document's graph carries a `raw16Source` node. Binding the 8-bit
 * display JPEG to it throws in the worker ("bound external data must be a
 * Raw16SourceData") and every preview surface stays empty - the bug this
 * file guards. The preview has to bind the same source kind the document's
 * graph expects, downscaled to preview size.
 */
import { describe, expect, it } from 'vitest';
import { PipelineService } from '../engine/graph/PipelineService';
import {
  buildDefaultGraph, previewSubgraph, KIND_PREVIEW, KIND_RAW16_SOURCE,
} from '../engine/graph';
import { spliceBaseStage } from '../engine/graph/DefaultGraphBuilder';
import type { RenderGraph } from '../engine/graph';
import { raw16Source } from '../engine/graph/projection/projectionFixtures';
import { bitmapFromPixels } from '../engine/graph/compat/glReadout';
import type { RawPixelData } from '../engine/raw/RawDecoderStrategy';
import {
  PREVIEW_SOURCE_MAX_DIM, downscaleRaw16, previewSourceSpecFor,
} from './previewSource';

async function makeService(): Promise<PipelineService> {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 unavailable');
  gl.getExtension('EXT_color_buffer_half_float');
  return new PipelineService(gl);
}

/** A RAW photo as the editor holds it: 16-bit linear, camera calibration. */
function rawPixels(width = 640, height = 480): RawPixelData {
  const data = new Uint16Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      data[i] = 10_000 + Math.round((x / width) * 40_000);
      data[i + 1] = 20_000;
      data[i + 2] = 30_000;
    }
  }
  return {
    data, width, height, channels: 3, bits: 16,
    asShotNeutral: [2.1, 1, 1.5],
    colorMatrix: null,
  };
}

/** The graph a RAW document shows in the editor: raw16 chain, base stage
 *  spliced in, params baked into the nodes (a stored graph hands in none). */
function rawDocumentGraph(px: RawPixelData): RenderGraph {
  const source = raw16Source({
    geometry: { width: px.width, height: px.height, pixelRatio: 1 },
    channels: px.channels,
    calibration: { asShotNeutral: px.asShotNeutral ?? null, colorMatrix: px.colorMatrix ?? null },
    baseAdjustments: { exposure: 20, contrast: 10 },
  });
  return spliceBaseStage(buildDefaultGraph({ exposure: 15 }, source).graph, source).graph;
}

/** Adds a preview tap behind the graph's terminal node. */
function withPreviewTap(graph: RenderGraph): { graph: RenderGraph; tapId: string } {
  const tapId = 'preview:probe';
  const nodes = new Map(graph.nodes);
  nodes.set(tapId, { id: tapId, kind: KIND_PREVIEW, params: {} });
  return {
    tapId,
    graph: {
      ...graph,
      id: `${graph.id}::tap-test`,
      nodes,
      edges: [...graph.edges, {
        id: 'e:tap', from: { node: graph.output, port: 'out' }, to: { node: tapId, port: 'in' },
      }],
      output: tapId,
    },
  };
}

describe('preview source for a RAW document (real GL)', () => {
  it('renders the preview tap of a raw16 graph instead of failing on the source kind', async () => {
    const svc = await makeService();
    const px = rawPixels();
    const { graph, tapId } = withPreviewTap(rawDocumentGraph(px));

    const spec = previewSourceSpecFor(graph, 'blob:display-jpeg', px);
    expect(spec?.kind).toBe('raw16');

    const data = downscaleRaw16(px, PREVIEW_SOURCE_MAX_DIM);
    const dims = { width: data.width, height: data.height };
    const plan = await svc.compile(previewSubgraph(graph, tapId, dims));
    // No param map: the editor's graph carries its params baked into the nodes.
    const out = await svc.renderToPixels(plan, data);

    expect(out.width).toBe(dims.width);
    expect(out.height).toBe(dims.height);
    expect(out.pixels.some((v) => v > 0)).toBe(true);
    svc.release();
  });

  it('keeps the preview buffer small instead of a full-resolution copy', () => {
    const px = rawPixels(6000, 4000);
    const data = downscaleRaw16(px, PREVIEW_SOURCE_MAX_DIM);

    expect(Math.max(data.width, data.height)).toBe(PREVIEW_SOURCE_MAX_DIM);
    expect(data.pixels.length).toBe(data.width * data.height * 3);
    // A full-resolution 16-bit copy would be 144 MB; the preview is ~1 MB.
    expect(data.pixels.byteLength).toBeLessThan(2 * 1024 * 1024);
    // The editor's own buffer must survive: the worker transfers what it binds.
    expect(px.data.length).toBe(6000 * 4000 * 3);
  });

  it('binds the display bitmap for a non-RAW document', async () => {
    const { graph } = buildDefaultGraph({}, {
      kind: 'imageBitmap', geometry: { width: 64, height: 48, pixelRatio: 1 },
    });
    const spec = previewSourceSpecFor(graph, 'blob:display-jpeg', null);
    expect(spec).toEqual({ kind: 'imageBitmap', key: 'blob:display-jpeg', url: 'blob:display-jpeg' });
  });

  it('waits rather than binding the bitmap while the RAW pixels are still decoding', () => {
    const px = rawPixels(64, 48);
    const graph = rawDocumentGraph(px);
    expect([...graph.nodes.values()].some((n) => n.kind === KIND_RAW16_SOURCE)).toBe(true);
    expect(previewSourceSpecFor(graph, 'blob:display-jpeg', null)).toBeNull();
  });

  it('rejects an 8-bit bitmap bound into a raw16 graph (why the preview was dead)', async () => {
    const svc = await makeService();
    const px = rawPixels(64, 48);
    const { graph, tapId } = withPreviewTap(rawDocumentGraph(px));
    const bitmap = await bitmapFromPixels(new Uint8Array(64 * 48 * 4).fill(200), 64, 48);

    const plan = await svc.compile(previewSubgraph(graph, tapId, { width: 64, height: 48 }));
    await expect(svc.renderToPixels(plan, bitmap as never)).rejects.toThrow(/Raw16SourceData/);

    bitmap.close();
    svc.release();
  });
});
