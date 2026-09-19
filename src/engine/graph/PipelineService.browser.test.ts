/**
 * Browser-mode tests for PipelineService end-to-end behaviour. Validates
 * that the high-level renderToBlob / renderToTexture paths work against
 * real WebGL2 + OffscreenCanvas encoding.
 */
import { describe, expect, it } from 'vitest';
import { PipelineService } from './PipelineService';
import { buildDefaultGraph, buildLayeredGraph, maskNodeIdForLayer, paramsByNodeFromAdjustments, spliceCrop } from './DefaultGraphBuilder';
import { KIND_PREVIEW } from './previewKind';
import type { RenderGraph } from './types';
import { colorSwatches } from './compat/syntheticFixtures';
import { bitmapFromPixels, readPixelsFromTexture } from './compat/glReadout';
import { raw16Source } from './projection/projectionFixtures';

async function makeService(): Promise<PipelineService> {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 unavailable');
  gl.getExtension('EXT_color_buffer_half_float');
  return new PipelineService(gl);
}

describe('PipelineService (real GL)', () => {
  it('reads more than 256 real levels from an RGBA16F terminal', async () => {
    const svc = await makeService();
    const width = 512;
    const height = 2;
    const pixels = new Uint16Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = y === 0 ? x * 64 : 60000;
        const index = (y * width + x) * 4;
        pixels[index] = value;
        pixels[index + 1] = value;
        pixels[index + 2] = value;
        pixels[index + 3] = 65535;
      }
    }
    const source = raw16Source({ geometry: { width, height, pixelRatio: 1 } });
    const plan = await svc.compile(buildDefaultGraph({}, source).graph, { terminalFormat: 'rgba16f' });
    const out = await svc.renderToPixels16(plan, { pixels, width, height, channels: 4 });
    const red = out.pixels.filter((_, index) => index % 4 === 0);
    const topRow = red.slice(0, width);

    expect(plan.perNodeFbo.get(plan.output)?.format).toBe('rgba16f');
    expect(new Set(topRow).size).toBeGreaterThan(256);
    expect(topRow.some((value) => value % 257 !== 0)).toBe(true);
    expect(topRow[0]).toBeLessThan(red[width]);

    svc.release();
  });

  it('keeps more than 256 levels through layer branches and an identity terminal compositor', async () => {
    const svc = await makeService();
    const width = 512;
    const height = 2;
    const pixels = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = y === 0 ? x * 64 : 60000;
        const index = (y * width + x) * 3;
        pixels[index] = value;
        pixels[index + 1] = value;
        pixels[index + 2] = value;
      }
    }
    const source = raw16Source({ geometry: { width, height, pixelRatio: 1 }, channels: 3 });
    const graph = buildLayeredGraph(
      {},
      [{ id: 'off', adjustments: {}, opacity: 0, blendMode: 'normal' }],
      source,
    ).graph;
    const plan = await svc.compile(graph, { terminalFormat: 'rgba16f' });
    expect(plan.identitySkips.has('comp:off')).toBe(true);

    const out = await svc.renderToPixels16(plan, { pixels, width, height, channels: 3 });
    const red = out.pixels.filter((_, index) => index % 4 === 0);
    const topRow = red.slice(0, width);
    expect(new Set(topRow).size).toBeGreaterThan(256);
    expect(topRow.some((value) => value % 257 !== 0)).toBe(true);
    expect(topRow[0]).toBeLessThan(red[width]);

    svc.release();
  });

  it('renders only the selected crop pixels at the cropped geometry', async () => {
    const svc = await makeService();
    const width = 4, height = 2;
    const pixels = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        pixels[i] = 20 + x * 50;
        pixels[i + 1] = 10 + y * 30;
        pixels[i + 2] = 5;
        pixels[i + 3] = 255;
      }
    }
    const bitmap = await bitmapFromPixels(pixels, width, height);
    const source = { kind: 'imageBitmap' as const, geometry: { width, height, pixelRatio: 1 } };
    const built = buildDefaultGraph({}, source).graph;
    const graph = spliceCrop(built, { x: 0.5, y: 0, width: 0.5, height: 1 }).graph;
    const plan = await svc.compile(graph);
    const out = await svc.renderToPixels(plan, bitmap);

    expect([out.width, out.height]).toEqual([2, 2]);
    expect(Array.from(out.pixels.filter((_, i) => i % 4 === 0))).toEqual([120, 170, 120, 170]);

    bitmap.close();
    svc.release();
  });

  it('renderToBlob produces a non-empty JPEG of the right type', async () => {
    const svc = await makeService();
    const fixture = colorSwatches(8);
    const bitmap = await bitmapFromPixels(fixture.pixels, fixture.width, fixture.height);

    const { graph } = buildDefaultGraph(
      { exposure: 50 },
      { kind: 'imageBitmap', geometry: { width: fixture.width, height: fixture.height, pixelRatio: 1 } },
    );
    const plan = await svc.compile(graph);
    const blob = await svc.renderToBlob(plan, bitmap);

    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe('image/jpeg');

    bitmap.close();
    svc.release();
  });

  it('renderToTexture output matches direct executor output bit-for-bit', async () => {
    const svc = await makeService();
    const fixture = colorSwatches(8);
    const bitmap = await bitmapFromPixels(fixture.pixels, fixture.width, fixture.height);

    const { graph } = buildDefaultGraph(
      { temperature: 20 },
      { kind: 'imageBitmap', geometry: { width: fixture.width, height: fixture.height, pixelRatio: 1 } },
    );
    const plan = await svc.compile(graph);

    const a = await svc.renderToTexture(plan, bitmap);
    const aPx = readPixelsFromTexture(svc['gl'], a.output, fixture.width, fixture.height);

    // Re-run: cache hit → same plan → identical output expected.
    const b = await svc.renderToTexture(plan, bitmap);
    const bPx = readPixelsFromTexture(svc['gl'], b.output, fixture.width, fixture.height);

    expect(aPx.length).toBe(bPx.length);
    let same = true;
    for (let i = 0; i < aPx.length; i++) if (aPx[i] !== bPx[i]) { same = false; break; }
    expect(same).toBe(true);

    bitmap.close();
    svc.release();
  });

  it('changing paramsByNode without recompile reflects in output', async () => {
    const svc = await makeService();
    // Phase 2: pre-OCS clamp folds saturated colours back to themselves
    // under +exposure, so use a mid-gray fixture that genuinely shifts.
    const W = 16, H = 16;
    const pixels = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      pixels[i * 4 + 0] = 128;
      pixels[i * 4 + 1] = 128;
      pixels[i * 4 + 2] = 128;
      pixels[i * 4 + 3] = 255;
    }
    const bitmap = await bitmapFromPixels(pixels, W, H);

    const { graph } = buildDefaultGraph({}, {
      kind: 'imageBitmap', geometry: { width: W, height: H, pixelRatio: 1 },
    });
    const plan = await svc.compile(graph);

    const identity = await svc.renderToTexture(plan, bitmap);
    const idPx = readPixelsFromTexture(svc['gl'], identity.output, W, H);

    const overrides = new Map<string, unknown>([
      ['default:tone', { exposure: 0.5, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 }],
    ]);
    const adjusted = await svc.renderToTexture(plan, bitmap, overrides);
    const adjPx = readPixelsFromTexture(svc['gl'], adjusted.output, W, H);

    // Different params -> different pixels somewhere.
    let differs = false;
    for (let i = 0; i < idPx.length; i++) if (idPx[i] !== adjPx[i]) { differs = true; break; }
    expect(differs).toBe(true);

    bitmap.close();
    svc.release();
  });

  it('renders a second RAW with its own camera profile from a plan compiled for the first', async () => {
    // Same size, both with a profile: one graph id, one cached plan, with the
    // first photo's profile baked into its base:* nodes.
    const W = 16, H = 16;
    const pixels = new Uint16Array(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      pixels[i * 3] = 16000; pixels[i * 3 + 1] = 20000; pixels[i * 3 + 2] = 12000;
    }
    const data = { pixels, width: W, height: H, channels: 3 as const };
    const render = async (svc: PipelineService, profileExposure: number) => {
      const source = raw16Source({
        geometry: { width: W, height: H, pixelRatio: 1 },
        baseAdjustments: { exposure: profileExposure },
      });
      const plan = await svc.compile(buildDefaultGraph({}, source).graph);
      const { output } = await svc.renderToTexture(plan, data, paramsByNodeFromAdjustments({}, source));
      return Array.from(readPixelsFromTexture(svc['gl'], output, W, H));
    };

    const shared = await makeService();
    const brightFirst = await render(shared, 30);
    const darkFromSharedPlan = await render(shared, -40);
    const alone = await makeService();
    const darkAlone = await render(alone, -40);

    expect(darkFromSharedPlan).toEqual(darkAlone);
    expect(darkFromSharedPlan).not.toEqual(brightFirst);
    shared.release();
    alone.release();
  });

  it('renders a layered document (fan-out) and the layer is visible', async () => {
    const svc = await makeService();
    const fixture = colorSwatches(8);
    const bitmap = await bitmapFromPixels(fixture.pixels, fixture.width, fixture.height);
    const src = {
      kind: 'imageBitmap' as const,
      geometry: { width: fixture.width, height: fixture.height, pixelRatio: 1 },
    };

    const base = buildDefaultGraph({ exposure: 30, clarity: 15 }, src);
    const basePlan = await svc.compile(base.graph);
    const baseOut = await svc.renderToPixels(basePlan, bitmap);

    const layered = buildLayeredGraph(
      { exposure: 30, clarity: 15 },
      [{ id: 'L1', adjustments: { shadows: 60 }, opacity: 1, blendMode: 'normal' }],
      src,
    );
    const layeredPlan = await svc.compile(layered.graph);
    // Regression guard: fan-out topologies used to throw (identity-skipped
    // multi-input producers) or render feedback-loop garbage.
    const layeredOut = await svc.renderToPixels(layeredPlan, bitmap);

    expect(layeredOut.pixels.some((v) => v > 0)).toBe(true);
    let differs = false;
    for (let i = 0; i < baseOut.pixels.length; i++) {
      if (baseOut.pixels[i] !== layeredOut.pixels[i]) { differs = true; break; }
    }
    expect(differs).toBe(true);

    bitmap.close();
    svc.release();
  });

  it('applies a bound layer mask per-pixel (left half masked, right half not)', async () => {
    const svc = await makeService();
    const W = 16, H = 16;
    // Mid-gray source so an exposure lift is clearly visible.
    const px = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      px[i * 4] = 120; px[i * 4 + 1] = 120; px[i * 4 + 2] = 120; px[i * 4 + 3] = 255;
    }
    const bitmap = await bitmapFromPixels(px, W, H);
    // Mask bitmap: left half white (full effect), right half black.
    const maskPx = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = x < W / 2 ? 255 : 0;
        const i = (y * W + x) * 4;
        maskPx[i] = v; maskPx[i + 1] = v; maskPx[i + 2] = v; maskPx[i + 3] = 255;
      }
    }
    const maskBitmap = await bitmapFromPixels(maskPx, W, H);

    const src = { kind: 'imageBitmap' as const, geometry: { width: W, height: H, pixelRatio: 1 } };
    const { graph } = buildLayeredGraph(
      {},
      [{ id: 'L1', adjustments: { exposure: 80 }, opacity: 1, blendMode: 'normal', useMask: true }],
      src,
    );
    const plan = await svc.compile(graph);
    const extra = new Map<string, ImageBitmap>([[maskNodeIdForLayer('L1'), maskBitmap]]);
    const out = await svc.renderToPixels(plan, bitmap, undefined, extra);

    const rowMid = Math.floor(H / 2) * W * 4;
    const leftLum = out.pixels[rowMid + 2 * 4];            // x=2 (masked, lifted)
    const rightLum = out.pixels[rowMid + (W - 3) * 4];     // x=W-3 (unmasked)
    expect(leftLum).toBeGreaterThan(rightLum + 15);
    // Unmasked side stays at the base render (~source gray after roundtrip).
    expect(Math.abs(rightLum - 120)).toBeLessThan(12);

    bitmap.close();
    maskBitmap.close();
    svc.release();
  });

  it('resolves a preview tap terminal to the producing node (non-black)', async () => {
    const svc = await makeService();
    const fixture = colorSwatches(8);
    const bitmap = await bitmapFromPixels(fixture.pixels, fixture.width, fixture.height);
    const src = {
      kind: 'imageBitmap' as const,
      geometry: { width: fixture.width, height: fixture.height, pixelRatio: 1 },
    };

    const { graph } = buildDefaultGraph({ exposure: 20 }, src);
    const nodes = new Map(graph.nodes);
    nodes.set('p1', { id: 'p1', kind: KIND_PREVIEW, params: {} });
    const tapGraph: RenderGraph = {
      ...graph,
      id: `${graph.id}::tap-terminal-test`,
      nodes,
      edges: [
        ...graph.edges,
        { id: 'e:tap', from: { node: graph.output, port: 'out' }, to: { node: 'p1', port: 'in' } },
      ],
      output: 'p1',
    };
    const plan = await svc.compile(tapGraph);
    const out = await svc.renderToPixels(plan, bitmap);
    expect(out.pixels.some((v) => v > 0)).toBe(true);

    bitmap.close();
    svc.release();
  });

  it('keeps vertical orientation end-to-end (top row stays top)', async () => {
    const svc = await makeService();
    const W = 8, H = 8;
    const px = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        px[i + 0] = y < H / 2 ? 255 : 0; // top half red
        px[i + 2] = y < H / 2 ? 0 : 255; // bottom half blue
        px[i + 3] = 255;
      }
    }
    const bitmap = await bitmapFromPixels(px, W, H);
    const { graph } = buildDefaultGraph({}, {
      kind: 'imageBitmap', geometry: { width: W, height: H, pixelRatio: 1 },
    });
    const plan = await svc.compile(graph);

    // renderToPixels: ImageData order — first row is the image's top row.
    const out = await svc.renderToPixels(plan, bitmap);
    const lastRow = (H - 1) * W * 4;
    expect(out.pixels[0]).toBeGreaterThan(150);            // top-left R
    expect(out.pixels[2]).toBeLessThan(100);               // top-left B
    expect(out.pixels[lastRow + 0]).toBeLessThan(100);     // bottom-left R
    expect(out.pixels[lastRow + 2]).toBeGreaterThan(150);  // bottom-left B

    // renderToBlob: decoded blob must be upright too.
    const blob = await svc.renderToBlob(plan, bitmap, undefined, { type: 'image/png' });
    const decoded = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(decoded, 0, 0);
    const data = ctx.getImageData(0, 0, W, H).data;
    expect(data[0]).toBeGreaterThan(150);                  // top-left R
    expect(data[lastRow + 2]).toBeGreaterThan(150);        // bottom-left B
    decoded.close();

    // renderToImageBitmap (GPU blit path): drawn straight, must be upright.
    const ib = await svc.renderToImageBitmap(plan, bitmap);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(ib.bitmap, 0, 0);
    const ibData = ctx.getImageData(0, 0, W, H).data;
    expect(ibData[0]).toBeGreaterThan(150);                // top-left R
    expect(ibData[lastRow + 2]).toBeGreaterThan(150);      // bottom-left B
    ib.bitmap.close();

    bitmap.close();
    svc.release();
  });

  it('uploads raw16 the same way up as an ImageBitmap', async () => {
    // The raw16 source uploads a plain buffer, the imageBitmap source an
    // ImageBitmap; if the two disagreed about row order, every RAW would hang
    // upside down on the canvas, in its thumbnail and in the export. (The
    // compat helper `readPixelsFromTexture` flips rows for the deleted classic
    // pipeline, which is what made the raw16 render look flipped in a test.)
    const svc = await makeService();
    const W = 8, H = 8;
    const pixels = new Uint16Array(W * H * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        pixels[i] = y < H / 2 ? 60000 : 0;      // top half red
        pixels[i + 2] = y < H / 2 ? 0 : 60000;  // bottom half blue
      }
    }
    const data = { pixels, width: W, height: H, channels: 3 as const };
    const source = raw16Source({ geometry: { width: W, height: H, pixelRatio: 1 } });
    const plan = await svc.compile(buildDefaultGraph({}, source).graph);

    const lastRow = (H - 1) * W * 4;
    const out = await svc.renderToPixels(plan, data, paramsByNodeFromAdjustments({}, source));
    expect(out.pixels[0]).toBeGreaterThan(150);             // top-left R
    expect(out.pixels[2]).toBeLessThan(100);                // top-left B
    expect(out.pixels[lastRow]).toBeLessThan(100);          // bottom-left R
    expect(out.pixels[lastRow + 2]).toBeGreaterThan(150);   // bottom-left B

    // The export path decodes upright too.
    const blob = await svc.renderToBlob(plan, data, paramsByNodeFromAdjustments({}, source), { type: 'image/png' });
    const decoded = await createImageBitmap(blob);
    const ctx = new OffscreenCanvas(W, H).getContext('2d')!;
    ctx.drawImage(decoded, 0, 0);
    const exported = ctx.getImageData(0, 0, W, H).data;
    expect(exported[0]).toBeGreaterThan(150);               // top-left R
    expect(exported[lastRow + 2]).toBeGreaterThan(150);     // bottom-left B
    decoded.close();

    svc.release();
  });

  it('lens correction kind visibly warps when enabled with a profile', async () => {
    const svc = await makeService();
    const fixture = colorSwatches(8);
    const bitmap = await bitmapFromPixels(fixture.pixels, fixture.width, fixture.height);
    const src = {
      kind: 'imageBitmap' as const,
      geometry: { width: fixture.width, height: fixture.height, pixelRatio: 1 },
    };
    // Same plan for both renders — lens flips on via paramsByNode, exactly
    // like the editor's per-render param path.
    const { graph } = buildDefaultGraph({}, src);
    const plan = await svc.compile(graph);
    const plainOut = await svc.renderToPixels(plan, bitmap);

    const lensParams = paramsByNodeFromAdjustments(
      { lensCorrection: true, lensCorrectionProfile: 'canon-ef-24-70-2.8', lensCorrectionStrength: 100 },
      src,
    );
    const lensOut = await svc.renderToPixels(plan, bitmap, lensParams);

    let differs = false;
    for (let i = 0; i < plainOut.pixels.length; i++) {
      if (plainOut.pixels[i] !== lensOut.pixels[i]) { differs = true; break; }
    }
    expect(differs).toBe(true);

    bitmap.close();
    svc.release();
  });

  it('first render with a fresh tone-curve LUT matches the second render', async () => {
    const svc = await makeService();
    const fixture = colorSwatches(8);
    const bitmap = await bitmapFromPixels(fixture.pixels, fixture.width, fixture.height);
    const { graph } = buildDefaultGraph(
      { toneCurve: { rgb: [{ x: 0, y: 0.1 }, { x: 0.5, y: 0.6 }, { x: 1, y: 0.9 }] } },
      { kind: 'imageBitmap', geometry: { width: fixture.width, height: fixture.height, pixelRatio: 1 } },
    );
    const plan = await svc.compile(graph);

    // Regression guard: creating the LUT texture used to bind it onto the
    // active unit 0 and clobber the input image for the first draw.
    const a = await svc.renderToPixels(plan, bitmap);
    const b = await svc.renderToPixels(plan, bitmap);
    expect(a.pixels.length).toBe(b.pixels.length);
    let same = true;
    for (let i = 0; i < a.pixels.length; i++) {
      if (a.pixels[i] !== b.pixels[i]) { same = false; break; }
    }
    expect(same).toBe(true);

    bitmap.close();
    svc.release();
  });
});
