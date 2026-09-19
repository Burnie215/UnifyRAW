/**
 * Gray-wedge measurement of the graph engine (`buildDefaultGraph` +
 * `PipelineExecutor`).
 *
 * Why this exists: "the graph output is darker than the classic editor" was
 * diagnosed from code alone for a long time, because nothing here could
 * actually render a pixel. It can now. The wedge (0/64/128/192/255) makes the
 * *shape* of any deviation readable — a smooth curve means a transfer-function
 * mismatch, stairs in the shadows mean linear light quantised to 8 bit, a
 * per-channel split means a stray matrix node.
 *
 * Two different invariants live here, and the difference matters:
 *
 *  - **Neutral must be bit-exact.** With no adjustment engaged, every
 *    adjustment node is identity-skipped and the graph reduces to
 *    gamma→linear→gamma. That has to round-trip exactly. This is the guard
 *    against the reported darkness.
 *
 *  - **Engaged sliders are pinned to recorded values.** Phase 2 moved the
 *    graph's adjustment math to linear light. The classic pipeline, which
 *    computed on gamma-encoded values, is deleted (tag
 *    attic/pre-deadcode-2026-09 keeps it and its numbers for these cases),
 *    so the engaged cases assert against values recorded from the graph: they
 *    catch an accidental change to the color math.
 *
 * Browser-mode-only — needs WebGL2, OffscreenCanvas, ImageBitmap.
 * Run with: npx vitest --project browser graySweep
 */
import { describe, expect, it } from 'vitest';

import { NodeRegistry } from '../NodeRegistry';
import { GraphCompiler } from '../GraphCompiler';
import { PipelineExecutor } from '../PipelineExecutor';
import { registerBuiltinConverts } from '../builtins';
import { registerBuiltinSources } from '../sources';
import { registerBuiltinPassKinds } from '../passKinds';
import { buildDefaultGraph, type BuilderAdjustments } from '../DefaultGraphBuilder';
import { readPixelsFromTexture, bitmapFromPixels } from './glReadout';

const WEDGE = [0, 64, 128, 192, 255];
const PATCH = 8;

/** Gray wedge: one PATCH-sized square per WEDGE step, left to right. */
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

/** Red channel at the centre of each patch — the wedge is neutral gray, so
 *  one channel carries the whole story unless a pass introduces a cast. */
function samplePatches(px: Uint8Array, width: number): number[] {
  const y = Math.floor(PATCH / 2);
  return WEDGE.map((_, p) => {
    const x = p * PATCH + Math.floor(PATCH / 2);
    return px[(y * width + x) * 4];
  });
}

/** Per-patch [r,g,b], for the cases where a channel split would matter. */
function samplePatchesRgb(px: Uint8Array, width: number): Array<[number, number, number]> {
  const y = Math.floor(PATCH / 2);
  return WEDGE.map((_, p) => {
    const i = (y * width + p * PATCH + Math.floor(PATCH / 2)) * 4;
    return [px[i], px[i + 1], px[i + 2]] as [number, number, number];
  });
}

async function renderGraph(bitmap: ImageBitmap, adj: BuilderAdjustments): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 not available');
  gl.getExtension('EXT_color_buffer_half_float');

  const registry = new NodeRegistry();
  registerBuiltinConverts(registry);
  registerBuiltinSources(registry);
  registerBuiltinPassKinds(registry);

  const { graph, sourceNodeId } = buildDefaultGraph(adj, {
    kind: 'imageBitmap',
    geometry: { width: bitmap.width, height: bitmap.height, pixelRatio: 1 },
  });
  const plan = await new GraphCompiler(registry).compile(graph);

  const executor = new PipelineExecutor(gl, registry);
  executor.bindExternalData(sourceNodeId, bitmap);
  const result = await executor.execute(plan);
  const pixels = readPixelsFromTexture(gl, result.outputTexture, bitmap.width, bitmap.height);
  executor.release();
  return pixels;
}

describe('gray wedge: graph engine', () => {
  it('neutral adjustments: the graph round-trips the wedge unchanged', async () => {
    const w = grayWedge();
    const bitmap = await bitmapFromPixels(w.pixels, w.width, w.height);
    const graph = samplePatchesRgb(await renderGraph(bitmap, {}), w.width);
    bitmap.close();

    // gamma → linear → gamma has to come back exactly. A regression here is
    // the "graph output is much darker" bug: a missing OutputColorSpace step
    // shows linear light as if it were display-encoded (128 would read ~55),
    // and an RGBA8 linear segment would round the mid-tones off.
    for (let i = 0; i < WEDGE.length; i++) {
      expect(graph[i], `patch ${WEDGE[i]}`).toEqual([WEDGE[i], WEDGE[i], WEDGE[i]]);
    }
  });

  // Reference values recorded from the linear-math graph. The classic
  // pipeline's numbers for the same cases stay in this file at tag
  // attic/pre-deadcode-2026-09, for the day a node moves back into gamma space.
  const ENGAGED: Array<{ name: string; adj: BuilderAdjustments; graph: number[] }> = [
    { name: 'exposure +20',   adj: { exposure: 20 },    graph: [0, 74, 145, 217, 255] },
    { name: 'contrast +30',   adj: { contrast: 30 },    graph: [0, 0, 101, 193, 255] },
    { name: 'blacks +30',     adj: { blacks: 30 },      graph: [48, 81, 136, 197, 255] },
    { name: 'shadows +50',    adj: { shadows: 50 },     graph: [0, 71, 137, 192, 255] },
    { name: 'highlights -50', adj: { highlights: -50 }, graph: [0, 64, 128, 192, 225] },
  ];

  for (const c of ENGAGED) {
    it(`${c.name}: graph matches its recorded linear-math reference`, async () => {
      const w = grayWedge();
      const bitmap = await bitmapFromPixels(w.pixels, w.width, w.height);
      const graph = samplePatches(await renderGraph(bitmap, c.adj), w.width);
      bitmap.close();

      // ±1 absorbs GPU rounding differences between drivers.
      for (let i = 0; i < WEDGE.length; i++) {
        expect(Math.abs(graph[i] - c.graph[i]),
          `patch ${WEDGE[i]}: graph ${graph} vs reference ${c.graph}`).toBeLessThanOrEqual(1);
      }
    });
  }
});
