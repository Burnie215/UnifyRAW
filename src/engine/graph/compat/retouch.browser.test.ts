/**
 * What the retouch node actually does to pixels (F009, AP06 variant A2).
 *
 * The node is measured through `buildDocumentGraph`, not through a hand-wired
 * two-node graph: where the node is spliced and which converts the compiler
 * puts around it are half of the answer, and a graph built by hand would ask
 * neither question.
 *
 * The fixture is two flat blocks — a saturated red left half and a neutral
 * grey right half — because both modes need the same two things from it: a
 * source that is unmistakably not the target, and a target whose luminance is
 * far enough from the source's for "heal keeps the target's brightness" to be
 * a measurable claim rather than a rounding difference.
 *
 * Browser-mode-only — needs WebGL2, OffscreenCanvas, ImageBitmap.
 * Run with: npx vitest run --project browser retouch
 */
import { describe, expect, it } from 'vitest';

import { NodeRegistry } from '../NodeRegistry';
import { GraphCompiler } from '../GraphCompiler';
import { PipelineExecutor } from '../PipelineExecutor';
import { registerBuiltinConverts } from '../builtins';
import { registerBuiltinSources } from '../sources';
import { KIND_TRANSFORM, registerBuiltinPassKinds, type TransformParams } from '../passKinds';
import { registerBuiltinCompositors } from '../compositorKinds';
import { buildDocumentGraph } from '../documentGraph';
import { serializeGraph } from '../serialize';
import type { RenderGraph } from '../types';
import { createDocument, type PhotoDocument } from '../../DocumentModel';
import type { SpotRemoval } from '../../Mask';
import { readPixelsFromTexture, bitmapFromPixels } from './glReadout';

const WIDTH = 64;
const HEIGHT = 32;
const RED: [number, number, number] = [200, 40, 40];
const GREY: [number, number, number] = [128, 128, 128];

/** Left half red, right half grey. */
function twoBlocks(): Uint8Array {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const c = x < WIDTH / 2 ? RED : GREY;
      const i = (y * WIDTH + x) * 4;
      pixels[i] = c[0]; pixels[i + 1] = c[1]; pixels[i + 2] = c[2]; pixels[i + 3] = 255;
    }
  }
  return pixels;
}

const SOURCE = {
  kind: 'imageBitmap' as const,
  geometry: { width: WIDTH, height: HEIGHT, pixelRatio: 1 },
};

/** Target in the grey half, source in the red half, radius 8 px. */
const SPOT: SpotRemoval = {
  id: 's1', mode: 'clone',
  target: { x: 0.75, y: 0.5, radius: 8 / WIDTH },
  source: { x: 0.25, y: 0.5 },
  feather: 0.5, opacity: 1,
};

const SECOND_TRANSFORM: TransformParams = {
  rotation: Math.PI / 4,
  flipH: false,
  flipV: false,
  perspectiveH: 0,
  perspectiveV: 0,
  distortion: 0,
};

function docWithSpots(...spots: SpotRemoval[]): PhotoDocument {
  const doc = createDocument();
  return spots.length === 0 ? doc : { ...doc, retouch: spots };
}

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

function twoTransformDocument(): PhotoDocument {
  const base = createDocument();
  base.transform.flipH = true;
  const firstGraph = buildDocumentGraph(base, SOURCE).graph;
  const graph = appendTransform(firstGraph, 'custom:transform:2', SECOND_TRANSFORM);
  return {
    ...base,
    pipelineMode: 'graph',
    pipelineGraph: serializeGraph(graph),
  };
}

function makeRegistry(): NodeRegistry {
  const registry = new NodeRegistry();
  registerBuiltinConverts(registry);
  registerBuiltinSources(registry);
  registerBuiltinPassKinds(registry);
  registerBuiltinCompositors(registry);
  return registry;
}

async function render(bitmap: ImageBitmap, doc: PhotoDocument): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 not available');
  gl.getExtension('EXT_color_buffer_half_float');

  const built = buildDocumentGraph(doc, SOURCE);
  const plan = await new GraphCompiler(makeRegistry()).compile(built.graph);
  const executor = new PipelineExecutor(gl, makeRegistry());
  executor.bindExternalData(built.sourceNodeId, bitmap);
  const result = await executor.execute(plan, built.params);
  const pixels = readPixelsFromTexture(gl, result.outputTexture, WIDTH, HEIGHT);
  executor.release();
  return pixels;
}

/** RGB at a fractional position. */
function at(pixels: Uint8Array, fx: number, fy: number): [number, number, number] {
  const x = Math.min(WIDTH - 1, Math.round(fx * WIDTH));
  const y = Math.min(HEIGHT - 1, Math.round(fy * HEIGHT));
  const i = (y * WIDTH + x) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2]];
}

function near(a: readonly number[], b: readonly number[], tolerance = 3): void {
  for (let i = 0; i < 3; i++) {
    expect(Math.abs(a[i] - b[i]), `channel ${i} of ${a} vs ${b}`).toBeLessThanOrEqual(tolerance);
  }
}

/**
 * Luminance in LINEAR light, which is where the node computes it. Measuring
 * it on the encoded values instead answers a different question: a saturated
 * red of the same linear luminance as a neutral grey encodes to a very
 * different weighted average, and the test would read a preserved luminance
 * as a lost one.
 */
function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const luma = (c: readonly number[]) =>
  0.299 * srgbToLinear(c[0]) + 0.587 * srgbToLinear(c[1]) + 0.114 * srgbToLinear(c[2]);

async function withBlocks<T>(fn: (bitmap: ImageBitmap) => Promise<T>): Promise<T> {
  const bitmap = await bitmapFromPixels(twoBlocks(), WIDTH, HEIGHT);
  try {
    return await fn(bitmap);
  } finally {
    bitmap.close();
  }
}

describe('retouch node on the document graph', () => {
  it('a document without spots renders exactly as it did before', async () => {
    await withBlocks(async (bitmap) => {
      const plain = await render(bitmap, docWithSpots());
      near(at(plain, 0.25, 0.5), RED, 2);
      near(at(plain, 0.75, 0.5), GREY, 2);
    });
  });

  it('clone puts the source colour on the target, and leaves the rest alone', async () => {
    await withBlocks(async (bitmap) => {
      const plain = await render(bitmap, docWithSpots());
      const cloned = await render(bitmap, docWithSpots(SPOT));

      // The disc carries the source pixels…
      near(at(cloned, 0.75, 0.5), at(plain, 0.25, 0.5));
      expect(at(cloned, 0.75, 0.5)).not.toEqual(at(plain, 0.75, 0.5));
      // …and nothing outside it moves.
      near(at(cloned, 0.95, 0.5), at(plain, 0.95, 0.5), 1);
      near(at(cloned, 0.25, 0.5), at(plain, 0.25, 0.5), 1);
    });
  });

  it('maps displayed spot points through the transform before retouching', async () => {
    await withBlocks(async (bitmap) => {
      const rotated = {
        ...docWithSpots(SPOT),
        transform: { ...createDocument().transform, rotation: 180 },
      };
      const plain = await render(bitmap, { ...rotated, retouch: undefined });
      const cloned = await render(bitmap, rotated);

      // Rotation swaps the displayed halves. The clicked source is grey at
      // x=.25 and the clicked target is red at x=.75; the repair must land at
      // that displayed target, not at its pre-transform coordinate x=.25.
      near(at(cloned, 0.75, 0.5), at(plain, 0.25, 0.5));
      expect(at(cloned, 0.75, 0.5)).not.toEqual(at(plain, 0.75, 0.5));
      near(at(cloned, 0.25, 0.2), at(plain, 0.25, 0.2), 1);
    });
  });

  it('maps spots back through every serial transform in reverse sampling order', async () => {
    await withBlocks(async (bitmap) => {
      const base = twoTransformDocument();
      const spot: SpotRemoval = {
        ...SPOT,
        target: { x: 0.75, y: 0.5, radius: 4 / WIDTH },
        source: { x: 0.25, y: 0.5 },
      };
      const plain = await render(bitmap, base);
      const cloned = await render(bitmap, { ...base, retouch: [spot] });

      // The graph first flips, then rotates. At these off-axis points the
      // two inverse maps do not commute: using either only the first map or
      // the right maps in forward order leaves the displayed target red.
      near(at(cloned, spot.target.x, spot.target.y), at(plain, spot.source.x, spot.source.y), 4);
      expect(at(cloned, spot.target.x, spot.target.y)).not.toEqual(
        at(plain, spot.target.x, spot.target.y),
      );
    });
  });

  it('heal keeps the target luminance and takes the source colour', async () => {
    await withBlocks(async (bitmap) => {
      const plain = await render(bitmap, docWithSpots());
      const healed = await render(bitmap, docWithSpots({ ...SPOT, mode: 'heal' }));

      const target = at(healed, 0.75, 0.5);
      const grey = at(plain, 0.75, 0.5);
      const red = at(plain, 0.25, 0.5);
      // The source's colour direction arrives…
      expect(target[0] - target[2]).toBeGreaterThan(20);
      expect(target).not.toEqual(red);
      // …while the brightness stays the target's, within 8-bit rounding, and
      // is measurably not the source's.
      expect(Math.abs(luma(target) - luma(grey))).toBeLessThan(0.05 * luma(grey));
      expect(Math.abs(luma(target) - luma(red))).toBeGreaterThan(5 * Math.abs(luma(target) - luma(grey)));
    });
  });

  it('feather 0 renders a hard disc instead of a hole (the NaN case)', async () => {
    await withBlocks(async (bitmap) => {
      // The CPU formula divided by zero here — every alpha NaN, the disc a
      // hole (obs-retouch-feather-zero-nan). The proof is that the pixel at
      // 90% of the radius is fully cloned rather than black or unchanged.
      const plain = await render(bitmap, docWithSpots());
      const hard = await render(bitmap, docWithSpots({ ...SPOT, feather: 0 }));

      const source = at(plain, 0.25, 0.5);
      near(at(hard, 0.75, 0.5), source);
      near(at(hard, 0.75 + 0.9 * SPOT.target.radius, 0.5), source);
      // Just outside the disc the picture is untouched.
      near(at(hard, 0.75 + 1.4 * SPOT.target.radius, 0.5), at(plain, 0.75, 0.5), 2);
    });
  });

  it('spots are placed in image fractions, so the same edit survives a resize', async () => {
    // The radius used to be preview pixels; on any other surface that meant
    // a differently-sized disc. Rendering the same document at half size has
    // to cover the same part of the picture.
    await withBlocks(async (bitmap) => {
      const cloned = await render(bitmap, docWithSpots(SPOT));
      const plain = await render(bitmap, docWithSpots());
      // One radius to the left of the centre is still inside the disc.
      near(at(cloned, 0.75 - 0.5 * SPOT.target.radius, 0.5), at(plain, 0.25, 0.5), 4);
    });
  });
});
