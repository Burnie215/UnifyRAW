/**
 * `applyTone` against the real tone shader.
 *
 * ToneMatch fits the six tone sliders by simulating TonePass in JS. The node
 * test only checks that simulation against itself, so a change to the shader
 * (dec-contrast-pivot-linear would move exactly the mirrored line) would leave
 * both auto modes fitting a shader that no longer exists, with every test
 * green. This sends a gray ramp through the graph the app renders with and
 * holds the result against the simulation.
 *
 * Browser-mode-only — needs WebGL2, OffscreenCanvas, ImageBitmap.
 * Run with: npx vitest run --project browser ToneMatch
 */
import { describe, expect, it } from 'vitest';

import { applyTone, type ToneMatchAdjustments } from './ToneMatch';
import { NodeRegistry } from './graph/NodeRegistry';
import { GraphCompiler } from './graph/GraphCompiler';
import { PipelineExecutor } from './graph/PipelineExecutor';
import { registerBuiltinConverts } from './graph/builtins';
import { registerBuiltinSources } from './graph/sources';
import { registerBuiltinPassKinds } from './graph/passKinds';
import { adjustmentsToBuilderAdjustments, buildDefaultGraph } from './graph/DefaultGraphBuilder';
import { bitmapFromPixels, readPixelsFromTexture } from './graph/compat/glReadout';
import { defaultAdjustments } from '../types';

const WIDTH = 256;
const HEIGHT = 1;
/** Measured 2026-09-11: at most 0.018 on every case below; a whites
 *  coefficient of 0.16 instead of 0.15 shifts the mean by 0.26 to 0.32. */
const MEAN_TOLERANCE = 0.1;

const NEUTRAL: ToneMatchAdjustments = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
};

function ramp(): Uint8Array {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH; i++) {
    pixels[i * 4] = i;
    pixels[i * 4 + 1] = i;
    pixels[i * 4 + 2] = i;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

async function renderThroughGraph(tone: ToneMatchAdjustments): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 not available');
  gl.getExtension('EXT_color_buffer_half_float');

  const registry = new NodeRegistry();
  registerBuiltinConverts(registry);
  registerBuiltinSources(registry);
  registerBuiltinPassKinds(registry);

  const { graph, sourceNodeId } = buildDefaultGraph(
    adjustmentsToBuilderAdjustments({ ...defaultAdjustments, ...tone }),
    { kind: 'imageBitmap', geometry: { width: WIDTH, height: HEIGHT, pixelRatio: 1 } },
  );
  const plan = await new GraphCompiler(registry).compile(graph);

  const executor = new PipelineExecutor(gl, registry);
  executor.bindExternalData(sourceNodeId, await bitmapFromPixels(ramp(), WIDTH, HEIGHT));
  const result = await executor.execute(plan);
  const px = readPixelsFromTexture(gl, result.outputTexture, WIDTH, HEIGHT);
  executor.release();
  return px;
}

/**
 * Gap on the red channel (the ramp is neutral, so red stands for all three):
 * the worst single code value, and the mean signed gap over the unclipped
 * part of the ramp. A small coefficient drift stays under one code value per
 * pixel but shifts every pixel the same way, which the mean shows.
 */
async function compare(tone: ToneMatchAdjustments): Promise<{ worst: number; meanSigned: number }> {
  const rendered = await renderThroughGraph(tone);
  let worst = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < WIDTH; i++) {
    const exact = applyTone(i / 255, tone, true) * 255;
    const simulated = Math.round(exact);
    const gap = rendered[i * 4] - simulated;
    worst = Math.max(worst, Math.abs(gap));
    if (exact > 0.5 && exact < 254.5) {
      sum += rendered[i * 4] - exact;
      count++;
    }
  }
  return { worst, meanSigned: count ? sum / count : 0 };
}

describe('applyTone mirrors the tone shader', () => {
  const cases: Array<[string, Partial<ToneMatchAdjustments>]> = [
    ['neutral', {}],
    ['exposure +50', { exposure: 50 }],
    ['exposure -50', { exposure: -50 }],
    ['contrast +40', { contrast: 40 }],
    ['contrast -40', { contrast: -40 }],
    ['highlights +60', { highlights: 60 }],
    ['highlights -60', { highlights: -60 }],
    ['shadows +60', { shadows: 60 }],
    ['shadows -60', { shadows: -60 }],
    ['whites +50', { whites: 50 }],
    ['whites -50', { whites: -50 }],
    ['blacks +50', { blacks: 50 }],
    ['blacks -50', { blacks: -50 }],
    ['all six at once', { exposure: 20, contrast: -25, highlights: -40, shadows: 35, whites: 30, blacks: -20 }],
  ];

  for (const [label, delta] of cases) {
    it(`within one code value: ${label}`, async () => {
      const { worst, meanSigned } = await compare({ ...NEUTRAL, ...delta });
      // One code value of slack for the float segment and the 8-bit encode.
      expect(worst).toBeLessThanOrEqual(1);
      expect(Math.abs(meanSigned), `mean signed gap ${meanSigned.toFixed(3)}`).toBeLessThanOrEqual(MEAN_TOLERANCE);
    });
  }
});
