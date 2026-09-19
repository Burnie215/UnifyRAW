import { describe, expect, it } from 'vitest';

import { createDocLayer, createDocument } from '../../DocumentModel';
import { GraphCompiler } from '../GraphCompiler';
import { PipelineExecutor } from '../PipelineExecutor';
import { NodeRegistry } from '../NodeRegistry';
import { registerBuiltinConverts } from '../builtins';
import { registerBuiltinCompositors } from '../compositorKinds';
import { buildDocumentGraph, preCurveStopNodeFor } from '../documentGraph';
import { registerBuiltinPassKinds } from '../passKinds';
import { registerBuiltinSources } from '../sources';
import { subgraphBefore } from '../subgraph';
import { bitmapFromPixels, readPixelsFromTexture } from './glReadout';

const WIDTH = 8;
const HEIGHT = 8;

function registry(): NodeRegistry {
  const value = new NodeRegistry();
  registerBuiltinConverts(value);
  registerBuiltinSources(value);
  registerBuiltinPassKinds(value);
  registerBuiltinCompositors(value);
  return value;
}

async function tapPixel(
  bitmap: ImageBitmap,
  spec: ReturnType<typeof buildDocumentGraph>,
  stopNodeId: string,
): Promise<number> {
  const sub = subgraphBefore(spec.graph, stopNodeId, { appendLinToGamma: true });
  expect(sub).not.toBeNull();
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 not available');
  gl.getExtension('EXT_color_buffer_half_float');
  const nodes = registry();
  const plan = await new GraphCompiler(nodes).compile(sub!);
  const executor = new PipelineExecutor(gl, nodes);
  executor.bindExternalData(spec.sourceNodeId, bitmap);
  const result = await executor.execute(plan, spec.params);
  const pixels = readPixelsFromTexture(gl, result.outputTexture, WIDTH, HEIGHT);
  executor.release();
  return pixels[((HEIGHT / 2 * WIDTH) + WIDTH / 2) * 4];
}

describe('document pre-curve histogram tap', () => {
  it('samples the selected layer chain instead of the flat base chain', async () => {
    const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 64; pixels[i + 1] = 64; pixels[i + 2] = 64; pixels[i + 3] = 255;
    }
    const bitmap = await bitmapFromPixels(pixels, WIDTH, HEIGHT);
    const base = createDocument();
    const layer = { ...createDocLayer('adjustment'), id: 'bright', adjustments: { exposure: 50 } };
    const doc = { ...base, layers: [...base.layers, layer] };
    const spec = buildDocumentGraph(doc, {
      kind: 'imageBitmap',
      geometry: { width: WIDTH, height: HEIGHT, pixelRatio: 1 },
    });
    const baseStop = preCurveStopNodeFor(spec, null);
    const layerStop = preCurveStopNodeFor(spec, layer.id);
    expect(baseStop).not.toBeNull();
    expect(layerStop).not.toBeNull();

    try {
      const basePixel = await tapPixel(bitmap, spec, baseStop!);
      const layerPixel = await tapPixel(bitmap, spec, layerStop!);
      expect(layerPixel).toBeGreaterThan(basePixel + 20);
    } finally {
      bitmap.close();
    }
  });
});
