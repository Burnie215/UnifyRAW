/**
 * Acceptance measurement for step 1 of the single-source-of-truth plan:
 * a document with a base plus two adjustment layers has to produce the same
 * pixels in both views.
 *
 * What actually differs between the views, now that both build their graph
 * with `buildLayeredGraph`, is HOW the parameters get in:
 *
 *  - The classic canvas (`useRenderPipeline.renderDoc`) builds the graph and
 *    hands `layeredParamsByNode` to the renderer as execute-time overrides.
 *  - The graph view owns a persisted graph whose node params are baked in and
 *    refreshed by `syncLayeredNodeParams` when the mode is entered.
 *
 * Those two have to land on identical pixels, on every branch and on the
 * compositors. They did not before: the sync only knew the base chain's node
 * ids, so a layer's own edits stayed at the value the graph was born with
 * (card fix-graph-stale for the flat chain, s1-layered-graph for the stack).
 * The stale-graph case below is that bug in test form.
 *
 * Equality alone is a weak assertion here — both paths run the same executor,
 * so both agree on a wrong picture just as readily as on a right one. Every
 * case therefore also asserts that the wedge is still a wedge. That is what
 * caught the mask leak at the bottom, which equality had waved through.
 *
 * Method matches graySweep.browser.test.ts — same wedge, same patch sampling,
 * so numbers from both files are directly comparable.
 *
 * Browser-mode-only — needs WebGL2, OffscreenCanvas, ImageBitmap.
 * Run with: npx vitest run --project browser layerStack
 */
import { describe, expect, it } from 'vitest';

import { NodeRegistry } from '../NodeRegistry';
import { GraphCompiler } from '../GraphCompiler';
import { PipelineExecutor } from '../PipelineExecutor';
import { registerBuiltinConverts } from '../builtins';
import { registerBuiltinSources } from '../sources';
import { registerBuiltinPassKinds } from '../passKinds';
import { registerBuiltinCompositors } from '../compositorKinds';
import {
  buildLayeredGraph,
  adjustmentsToBuilderAdjustments,
  layeredParamsByNode,
  syncLayeredNodeParams,
  maskNodeIdForLayer,
  type BuilderAdjustments,
  type BuilderLayer,
} from '../DefaultGraphBuilder';
import { readPixelsFromTexture, bitmapFromPixels } from './glReadout';
import { builderBaseForDocument, builderLayersForDocument } from '../documentGraph';
import { createDocument, type PhotoDocument } from '../../DocumentModel';
import { addMaskToDocument } from '../../layerMasks';
import { createMask } from '../../Mask';
import { defaultAdjustments } from '../../../types';

const WEDGE = [0, 64, 128, 192, 255];
const PATCH = 8;

function grayWedge(): { pixels: Uint8Array; width: number; height: number } {
  const width = WEDGE.length * PATCH;
  const height = PATCH;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = WEDGE[Math.floor(x / PATCH)];
      const i = (y * width + x) * 4;
      pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255;
    }
  }
  return { pixels, width, height };
}

/**
 * Mask covering the left half only. A mask constant over the image would pass
 * even when bound to the wrong node or sampled at the wrong scale; a
 * half-covering one turns both mistakes into a visible step in the middle —
 * and makes a mask that leaks into the output unmistakable.
 */
function halfMask(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x < width / 2 ? 255 : 0;
      const i = (y * width + x) * 4;
      pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function samplePatches(px: Uint8Array, width: number): number[] {
  const y = Math.floor(PATCH / 2);
  return WEDGE.map((_, p) => px[(y * width + p * PATCH + Math.floor(PATCH / 2)) * 4]);
}

function samplePatchesRgb(px: Uint8Array, width: number): number[] {
  const y = Math.floor(PATCH / 2);
  return WEDGE.flatMap((_, p) => {
    const i = (y * width + p * PATCH + Math.floor(PATCH / 2)) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  });
}

/** A wedge stays a wedge: never falling, and not collapsed to one value. */
function expectStillAWedge(px: number[]): void {
  for (let i = 1; i < px.length; i++) {
    expect(px[i], `patch ${i} of ${px} must not be darker than its neighbour`)
      .toBeGreaterThanOrEqual(px[i - 1]);
  }
  expect(px[px.length - 1] - px[0], `no contrast left in ${px}`).toBeGreaterThan(32);
}

function makeRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registerBuiltinConverts(registry);
  registerBuiltinSources(registry);
  registerBuiltinPassKinds(registry);
  registerBuiltinCompositors(registry);
  return registry;
}

const SOURCE = (width: number, height: number) => ({
  kind: 'imageBitmap' as const,
  geometry: { width, height, pixelRatio: 1 },
});

/**
 * Render a layered graph and sample its patches. `params` mirrors the classic
 * canvas (execute-time overrides); omitting it mirrors the graph view (params
 * baked into the nodes). `graph` lets a case supply a graph built from other
 * adjustments than the ones being rendered with.
 */
async function renderLayered(
  bitmap: ImageBitmap,
  maskBitmap: ImageBitmap | null,
  baseAdj: BuilderAdjustments,
  layers: BuilderLayer[],
  opts: {
    params?: Map<string, unknown>;
    graph?: ReturnType<typeof buildLayeredGraph>['graph'];
    sample?: (pixels: Uint8Array, width: number) => number[];
  } = {},
): Promise<number[]> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 not available');
  gl.getExtension('EXT_color_buffer_half_float');

  const registry = makeRegistry();
  const built = buildLayeredGraph(baseAdj, layers, SOURCE(bitmap.width, bitmap.height));
  const graph = opts.graph ?? built.graph;
  const plan = await new GraphCompiler(registry).compile(graph);

  const executor = new PipelineExecutor(gl, registry);
  executor.bindExternalData(built.sourceNodeId, bitmap);
  for (const layer of layers) {
    if (!layer.useMask) continue;
    if (!maskBitmap) throw new Error('masked layer without a mask bitmap');
    executor.bindExternalData(maskNodeIdForLayer(layer.id), maskBitmap);
  }
  const result = await executor.execute(plan, opts.params);
  const pixels = readPixelsFromTexture(gl, result.outputTexture, bitmap.width, bitmap.height);
  executor.release();
  return opts.sample ? opts.sample(pixels, bitmap.width) : samplePatches(pixels, bitmap.width);
}

const BASE_ADJ: BuilderAdjustments = { exposure: 10 };
/** L1 adjusts contrast on `normal`, L2 brightens on `multiply`. */
const L1: BuilderLayer = { id: 'L1', adjustments: { contrast: 25 }, opacity: 0.8, blendMode: 'normal' };
const L2: BuilderLayer = { id: 'L2', adjustments: { exposure: 15 }, opacity: 0.6, blendMode: 'multiply' };

async function withWedge<T>(
  fn: (bitmap: ImageBitmap, mask: ImageBitmap, width: number) => Promise<T>,
): Promise<T> {
  const w = grayWedge();
  const bitmap = await bitmapFromPixels(w.pixels, w.width, w.height);
  const mask = await bitmapFromPixels(halfMask(w.width, w.height), w.width, w.height);
  try {
    return await fn(bitmap, mask, w.width);
  } finally {
    bitmap.close(); mask.close();
  }
}

async function withWarmWedge<T>(fn: (bitmap: ImageBitmap, width: number) => Promise<T>): Promise<T> {
  const colors = [
    [210, 60, 45], [220, 90, 45], [220, 120, 45], [220, 150, 45], [210, 180, 60],
  ];
  const width = colors.length * PATCH;
  const pixels = new Uint8Array(width * PATCH * 4);
  for (let y = 0; y < PATCH; y++) {
    for (let x = 0; x < width; x++) {
      const color = colors[Math.floor(x / PATCH)];
      const i = (y * width + x) * 4;
      pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255;
    }
  }
  const bitmap = await bitmapFromPixels(pixels, width, PATCH);
  try {
    return await fn(bitmap, width);
  } finally {
    bitmap.close();
  }
}

function maxAbs(a: number[], b: number[]): number {
  return Math.max(...a.map((value, i) => Math.abs(value - b[i])));
}

describe('layer stack: classic params vs graph-owned params', () => {
  it('renders persisted skin-tone uniformity in both pixel paths regardless of the selected tab', async () => {
    await withWarmWedge(async (bitmap, width) => {
      const sector = {
        ...defaultAdjustments.skinToneSector,
        hueCenter: 25,
        hueHalfWidth: 60,
        satMin: 20,
        satMax: 80,
        pickRelHue: 0.5,
        pickRelSat: 0.5,
      };
      const mapped = (mode: 'basic' | 'advanced' | 'skin-tone', hue: number) => adjustmentsToBuilderAdjustments({
        ...defaultAdjustments,
        colorEditorMode: mode,
        skinToneSector: sector,
        skinToneUniformity: { hue, saturation: 0, luminance: 0 },
      });
      const source = SOURCE(width, PATCH);
      const basic = mapped('basic', 40);
      const advanced = mapped('advanced', 40);
      const skinTab = mapped('skin-tone', 40);
      const off = mapped('basic', 0);

      const canvas = await renderLayered(bitmap, null, basic, [], {
        params: layeredParamsByNode(basic, [], source),
        sample: samplePatchesRgb,
      });
      const baked = await renderLayered(bitmap, null, basic, [], { sample: samplePatchesRgb });
      const advancedTab = await renderLayered(bitmap, null, advanced, [], { sample: samplePatchesRgb });
      const otherTab = await renderLayered(bitmap, null, skinTab, [], { sample: samplePatchesRgb });
      const withoutUniformity = await renderLayered(bitmap, null, off, [], { sample: samplePatchesRgb });

      expect(maxAbs(canvas, baked)).toBeLessThanOrEqual(2);
      expect(maxAbs(advancedTab, baked)).toBeLessThanOrEqual(2);
      expect(maxAbs(otherTab, baked)).toBeLessThanOrEqual(2);
      expect(maxAbs(withoutUniformity, baked)).toBeGreaterThan(2);
    });
  });

  it('renders nonzero uniformity when the skin reference wraps to exactly zero degrees', async () => {
    await withWarmWedge(async (bitmap) => {
      const skinToneSector = {
        ...defaultAdjustments.skinToneSector,
        hueCenter: 330,
        hueHalfWidth: 60,
        satMin: 20,
        satMax: 80,
        pickRelHue: 0.75,
        pickRelSat: 0.5,
        selLightness: 0,
      };
      const mapped = (uniformity: number) => adjustmentsToBuilderAdjustments({
        ...defaultAdjustments,
        skinToneSector,
        skinToneUniformity: {
          hue: uniformity,
          saturation: uniformity,
          luminance: uniformity,
        },
      });
      const active = mapped(100);
      const off = mapped(0);
      const activePixels = await renderLayered(bitmap, null, active, [], {
        sample: samplePatchesRgb,
      });
      const offPixels = await renderLayered(bitmap, null, off, [], {
        sample: samplePatchesRgb,
      });

      expect((active.hslSkinTone as { refHue: number }).refHue).toBe(0);
      expect(maxAbs(activePixels, offPixels)).toBeGreaterThan(2);
    });
  });

  it('base + 2 layers (multiply, second one masked) render identically both ways', async () => {
    await withWedge(async (bitmap, mask, width) => {
      const layers: BuilderLayer[] = [L1, { ...L2, useMask: true }];
      const params = layeredParamsByNode(BASE_ADJ, layers, SOURCE(width, PATCH));

      const classic = await renderLayered(bitmap, mask, BASE_ADJ, layers, { params });
      const graph = await renderLayered(bitmap, mask, BASE_ADJ, layers);

      expect(graph).toEqual(classic);
      expectStillAWedge(graph);
      // The stack has to actually do something — base alone is [0,69,136,204,255].
      expect(graph).not.toEqual(await renderLayered(bitmap, null, BASE_ADJ, []));
    });
  });

  it('base + 2 unmasked layers render identically both ways', async () => {
    await withWedge(async (bitmap, _mask, width) => {
      const layers = [L1, L2];
      const params = layeredParamsByNode(BASE_ADJ, layers, SOURCE(width, PATCH));

      const classic = await renderLayered(bitmap, null, BASE_ADJ, layers, { params });
      const graph = await renderLayered(bitmap, null, BASE_ADJ, layers);

      expect(graph).toEqual(classic);
      expectStillAWedge(graph);
    });
  });

  it('the mask gates its layer — covered patches change, uncovered ones do not', async () => {
    await withWedge(async (bitmap, mask, width) => {
      const masked = [{ ...L1, useMask: true }];
      const unmasked = [L1];
      const withMask = await renderLayered(bitmap, mask, BASE_ADJ, masked, {
        params: layeredParamsByNode(BASE_ADJ, masked, SOURCE(width, PATCH)),
      });
      const noLayer = await renderLayered(bitmap, null, BASE_ADJ, []);
      const fullLayer = await renderLayered(bitmap, null, BASE_ADJ, unmasked, {
        params: layeredParamsByNode(BASE_ADJ, unmasked, SOURCE(width, PATCH)),
      });

      // The mask covers x < width/2, i.e. patches 0 and 1; patch 2 sits exactly
      // on the boundary and counts as uncovered.
      expect(withMask[1]).toBe(fullLayer[1]);
      expect(withMask[3]).toBe(noLayer[3]);
      expect(withMask[4]).toBe(noLayer[4]);
    });
  });

  it('a graph built from older adjustments matches the canvas after syncLayeredNodeParams', async () => {
    await withWedge(async (bitmap, _mask, width) => {
      const source = SOURCE(width, PATCH);
      const layers = [L1, L2];

      // The graph view's graph is older than the sliders: built while the base
      // sat at exposure 0 and both layers at identity.
      const staleLayers: BuilderLayer[] = layers.map((l) => ({ ...l, adjustments: {} }));
      const stale = buildLayeredGraph({}, staleLayers, source).graph;
      const synced = syncLayeredNodeParams(stale, BASE_ADJ, layers, source);

      const classic = await renderLayered(bitmap, null, BASE_ADJ, layers, {
        params: layeredParamsByNode(BASE_ADJ, layers, source),
      });
      const fromSynced = await renderLayered(bitmap, null, BASE_ADJ, layers, { graph: synced });
      const fromStale = await renderLayered(bitmap, null, BASE_ADJ, layers, { graph: stale });

      expect(fromSynced).toEqual(classic);
      // Without the sync the graph renders the state it was born with — the
      // failure this card series is about. If this ever stops differing, the
      // stale fixture has lost its bite.
      expect(fromStale).not.toEqual(classic);
    });
  });

  // A mask drawn with the toolbar is a document operation now: it makes an
  // adjustment layer and the layer's adjustments ARE its effect (F001). What
  // that produces has to be a real, mask-gated render, not the CSS overlay the
  // editor used to paint over the canvas.
  it('a layer from addMaskToDocument gates its exposure with the mask', async () => {
    await withWedge(async (bitmap, mask, width) => {
      const added = addMaskToDocument(createDocument(), null, createMask('brush'));
      const doc: PhotoDocument = {
        ...added.document,
        layers: added.document.layers.map((l) => (
          l.id === added.layerId ? { ...l, adjustments: { exposure: 40 } } : l
        )),
      };

      const base = builderBaseForDocument(doc);
      const layers = builderLayersForDocument(doc);
      expect(layers).toHaveLength(1);
      expect(layers[0].useMask).toBe(true);

      const px = await renderLayered(bitmap, mask, base, layers, {
        params: layeredParamsByNode(base, layers, SOURCE(width, PATCH)),
      });
      const noLayer = await renderLayered(bitmap, null, base, []);

      // The mask covers x < width/2, i.e. patches 0 and 1; patch 2 sits on the
      // boundary and counts as uncovered.
      expect(px[1]).toBeGreaterThan(noLayer[1]);
      expect(px[3]).toBe(noLayer[3]);
      expect(px[4]).toBe(noLayer[4]);
      expectStillAWedge(px);
    });
  });

  // Regression for bug-mask-leaks-second-compositor: a masked adjustment
  // layer under an unmasked one used to render as the mask itself
  // ([255,255,0,0,0] = exactly halfMask), on the editor canvas as much as
  // here. Cause was slot recycling in the executor — the mask source's FBO
  // slot got handed to the second compositor; source slots are pinned now.
  it('masked layer followed by an unmasked one keeps the mask out of the output', async () => {
    await withWedge(async (bitmap, mask, width) => {
      const layers: BuilderLayer[] = [{ ...L1, useMask: true }, L2];
      const px = await renderLayered(bitmap, mask, BASE_ADJ, layers, {
        params: layeredParamsByNode(BASE_ADJ, layers, SOURCE(width, PATCH)),
      });
      expectStillAWedge(px);
    });
  });
});
