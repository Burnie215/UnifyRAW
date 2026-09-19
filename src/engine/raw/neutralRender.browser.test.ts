/**
 * `neutralRawRender` against the real raw16 render graph.
 *
 * This is the invariant the auto modes depend on: what they analyse has to be
 * what the sliders will act on. It was not — the auto modes measured
 * `displayUrl`, whose preview JPEG skips the WhiteBalanceRaw node, and the
 * reference match consequently landed ~15 code values too bright on every
 * photograph tested, blowing highlights that the camera JPEG had held. If this
 * test drifts, that bug is back.
 *
 * Browser-mode-only — needs WebGL2, OffscreenCanvas.
 * Run with: npx vitest --project browser neutralRender
 */
import { describe, expect, it } from 'vitest';

import { NodeRegistry } from '../graph/NodeRegistry';
import { GraphCompiler } from '../graph/GraphCompiler';
import { PipelineExecutor } from '../graph/PipelineExecutor';
import { registerBuiltinConverts } from '../graph/builtins';
import { registerBuiltinSources } from '../graph/sources';
import { registerBuiltinPassKinds } from '../graph/passKinds';
import { buildDefaultGraph, type BuilderSourceSpec } from '../graph/DefaultGraphBuilder';
import { histogramFromPixels } from '../../image/histogram';
import { imageStats } from '../AutoOptimizer';
import { neutralRawRender } from './neutralRender';
import type { RawPixelData } from './RawDecoderStrategy';

/** Daylight as-shot gains: green untouched, red and blue lifted. Skipping
 *  these is exactly what the preview JPEG does. */
const AS_SHOT_NEUTRAL: [number, number, number] = [2.1, 1.0, 1.5];
const COLOR_MATRIX = [1.75, -0.62, -0.13, -0.18, 1.42, -0.24, 0.03, -0.42, 1.39];

const WIDTH = 64;
const HEIGHT = 48;

/**
 * A synthetic camera-space frame: a full-range luminance ramp crossed with
 * hue variation, so the sweep exercises the colour matrix and the shadow
 * quantisation rather than just a neutral wedge.
 */
function syntheticRaw(): Uint16Array {
  const data = new Uint16Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = (y * WIDTH + x) * 3;
      const ramp = x / (WIDTH - 1);
      const hue = y / (HEIGHT - 1);
      data[i] = Math.round(65535 * ramp * (0.35 + 0.65 * hue));
      data[i + 1] = Math.round(65535 * ramp);
      data[i + 2] = Math.round(65535 * ramp * (1 - 0.6 * hue));
    }
  }
  return data;
}

function rawPixelData(data: Uint16Array, colorMatrix: number[] | null): RawPixelData {
  return {
    data, width: WIDTH, height: HEIGHT, channels: 3, bits: 16,
    colorMatrix, asShotNeutral: AS_SHOT_NEUTRAL,
  };
}

/**
 * Reads the executor's output in image order (top row first), the way
 * `PipelineService.readPixelsImageOrder` does for every real surface.
 *
 * Deliberately *not* `glReadout.readPixelsFromTexture`: that helper flips
 * rows for the classic pipeline (deleted, tag attic/pre-deadcode-2026-09),
 * which uploaded with UNPACK_FLIP_Y. The graph engine does not, so framebuffer
 * row 0 already is the image's top row — flipping here made the raw16 render
 * look row-flipped against the software render and hid it behind a
 * both-orientations comparison.
 */
function readPixelsImageOrder(
  gl: WebGL2RenderingContext, texture: WebGLTexture, width: number, height: number,
): Uint8Array {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('readPixelsImageOrder: createFramebuffer null');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const out = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  return out;
}

async function renderNeutralThroughGraph(
  data: Uint16Array, colorMatrix: number[] | null,
): Promise<Uint8ClampedArray> {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 not available');
  gl.getExtension('EXT_color_buffer_half_float');

  const registry = new NodeRegistry();
  registerBuiltinConverts(registry);
  registerBuiltinSources(registry);
  registerBuiltinPassKinds(registry);

  const source: BuilderSourceSpec = {
    kind: 'raw16',
    geometry: { width: WIDTH, height: HEIGHT, pixelRatio: 1 },
    channels: 3,
    baseAdjustments: null,
    lensProfile: null,
    calibration: { asShotNeutral: AS_SHOT_NEUTRAL, colorMatrix },
  };
  const { graph, sourceNodeId } = buildDefaultGraph({}, source);
  const plan = await new GraphCompiler(registry).compile(graph);

  const executor = new PipelineExecutor(gl, registry);
  executor.bindExternalData(sourceNodeId, { pixels: data, width: WIDTH, height: HEIGHT, channels: 3 });
  const result = await executor.execute(plan);
  const px = readPixelsImageOrder(gl, result.outputTexture, WIDTH, HEIGHT);
  executor.release();
  return new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength);
}

/** Pixel for pixel, same orientation: both sides are top-row-first. */
function maxChannelDelta(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let worst = 0;
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(a[i * 4 + c] - b[i * 4 + c]));
  }
  return worst;
}

describe('neutralRawRender', () => {
  for (const [label, matrix] of [
    ['without a colour matrix', null],
    ['with a camera colour matrix', COLOR_MATRIX],
  ] as const) {
    it(`reproduces the neutral raw16 graph render ${label}`, async () => {
      const data = syntheticRaw();
      const software = neutralRawRender(rawPixelData(data, matrix));
      expect(software).not.toBeNull();
      const graph = await renderNeutralThroughGraph(data, matrix);

      // One code value of slack for the 16-bit float segment and the encode LUT.
      expect(maxChannelDelta(software!.pixels, graph)).toBeLessThanOrEqual(1);
    });
  }

  it('differs from the white-balance-free preview the way the bug did', async () => {
    // Reproduces SmartPreviewStrategy.tiffToPreviewJpeg: high byte, sRGB LUT,
    // no white balance. The gap it leaves is the whole defect.
    const data = syntheticRaw();
    const preview = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      lut[i] = Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
    }
    for (let p = 0; p < WIDTH * HEIGHT; p++) {
      preview[p * 4] = lut[data[p * 3] >> 8];
      preview[p * 4 + 1] = lut[data[p * 3 + 1] >> 8];
      preview[p * 4 + 2] = lut[data[p * 3 + 2] >> 8];
      preview[p * 4 + 3] = 255;
    }

    const rendered = neutralRawRender(rawPixelData(data, null))!;
    const previewStats = imageStats(histogramFromPixels(preview), preview);
    const renderStats = imageStats(histogramFromPixels(rendered.pixels), rendered.pixels);

    // The render is materially brighter. Analysing the preview instead asks
    // the sliders for a lift the render does not need.
    expect(renderStats.median - previewStats.median).toBeGreaterThan(5);
  });

  it('downsamples to the requested long edge', () => {
    const rendered = neutralRawRender(rawPixelData(syntheticRaw(), null), 16);
    expect(rendered!.width).toBeLessThanOrEqual(16);
    expect(rendered!.height).toBeLessThanOrEqual(16);
  });

  it('returns null for 8-bit data, where displayUrl is already the right input', () => {
    const eightBit: RawPixelData = {
      data: new Uint8Array(WIDTH * HEIGHT * 3), width: WIDTH, height: HEIGHT,
      channels: 3, bits: 8, colorMatrix: null, asShotNeutral: AS_SHOT_NEUTRAL,
    };
    expect(neutralRawRender(eightBit)).toBeNull();
  });
});
