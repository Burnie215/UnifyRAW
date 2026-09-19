/**
 * Measuring rig for the straighten/rotate path — real WebGL2, real graph pipeline.
 *
 * The straighten bug ("rotates by the wrong angle") had been chased through
 * code reading alone, which is how five plausible fixes landed without the
 * behaviour ever being observed. This file exists to make the angle a number:
 * put a bright marker at a known offset from the image centre, ask the pipeline
 * for a known rotation, and measure where the marker actually ended up.
 *
 * Screen convention throughout: origin top-left, +x right, +y down, angles
 * positive clockwise — the same convention CSS `rotate()` uses, so the WebGL
 * path and the CSS fallback can be held against one identical yardstick.
 *
 * Browser-mode-only (WebGL2 / OffscreenCanvas / ImageBitmap):
 *   npx vitest --project browser src/engine/passes/TransformPass.browser.test.ts
 */
import { describe, expect, it } from 'vitest';

import { NodeRegistry } from '../graph/NodeRegistry';
import { GraphCompiler } from '../graph/GraphCompiler';
import { PipelineExecutor } from '../graph/PipelineExecutor';
import { registerBuiltinConverts } from '../graph/builtins';
import { registerBuiltinSources } from '../graph/sources';
import { registerBuiltinPassKinds } from '../graph/passKinds';
import { buildDefaultGraph, type BuilderAdjustments } from '../graph/DefaultGraphBuilder';
import { bitmapFromPixels } from '../graph/compat/glReadout';

/**
 * Reads the executor's output in image order (top row first).
 *
 * Deliberately *not* `glReadout.readPixelsFromTexture`: that helper flips rows
 * because the classic pipeline (deleted, tag attic/pre-deadcode-2026-09)
 * uploaded with UNPACK_FLIP_Y. The graph engine
 * does not — see the note on `readPixelsImageOrder` in PipelineService.ts —
 * so framebuffer row 0 already is the image's top row and flipping here would
 * mirror the result, which silently inverts the sign of every angle measured.
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

// ─── Fixture: one bright marker at a known offset ──────────────────

interface Marker {
  pixels: Uint8Array;
  width: number;
  height: number;
  /** Marker centre in screen coords (top-left origin, +y down). */
  x: number;
  y: number;
}

/**
 * Black frame with a white disc `radius` px across, placed `offset` px to the
 * right of centre on the horizontal centre line. Everything else is black, so a
 * luminance-weighted centroid finds the marker no matter what gain the colour
 * passes apply on the way through.
 */
function markerFixture(width: number, height: number, offset: number, radius = 5): Marker {
  const pixels = new Uint8Array(width * height * 4);
  const cx = width / 2 + offset;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i + 3] = 255;
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) {
        pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255;
      }
    }
  }
  return { pixels, width, height, x: cx, y: cy };
}

/** Same disc, but placed `offset` px *above* centre on the vertical centre line. */
function markerFixtureVertical(width: number, height: number, offset: number, radius = 5): Marker {
  const pixels = new Uint8Array(width * height * 4);
  const cx = width / 2;
  const cy = height / 2 - offset;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      pixels[i + 3] = 255;
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) {
        pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255;
      }
    }
  }
  return { pixels, width, height, x: cx, y: cy };
}

/** Luminance-weighted centroid of a top-row-first RGBA8 buffer. */
function centroid(px: Uint8Array, width: number, height: number): { x: number; y: number; mass: number } {
  let sx = 0, sy = 0, mass = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      if (l <= 8) continue; // ignore the black field and its resampling fringe
      sx += (x + 0.5) * l; sy += (y + 0.5) * l; mass += l;
    }
  }
  return mass > 0 ? { x: sx / mass, y: sy / mass, mass } : { x: NaN, y: NaN, mass: 0 };
}

// ─── Pipeline harness (the path the editor actually renders through) ──

async function renderGraph(
  fixture: Marker, adj: BuilderAdjustments,
): Promise<Uint8Array> {
  const bitmap = await bitmapFromPixels(fixture.pixels, fixture.width, fixture.height);
  const canvas = new OffscreenCanvas(fixture.width, fixture.height);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 not available');
  gl.getExtension('EXT_color_buffer_half_float');
  gl.getExtension('EXT_color_buffer_float');

  const registry = new NodeRegistry();
  registerBuiltinConverts(registry);
  registerBuiltinSources(registry);
  registerBuiltinPassKinds(registry);

  const { graph, sourceNodeId } = buildDefaultGraph(adj, {
    kind: 'imageBitmap',
    geometry: { width: fixture.width, height: fixture.height, pixelRatio: 1 },
  });
  const plan = await new GraphCompiler(registry).compile(graph);
  const executor = new PipelineExecutor(gl, registry);
  executor.bindExternalData(sourceNodeId, bitmap);
  const result = await executor.execute(plan);
  const out = readPixelsImageOrder(gl, result.outputTexture, fixture.width, fixture.height);
  executor.release();
  bitmap.close();
  return out;
}

/**
 * Renders `fixture` with `rotationDeg` and reports where the marker landed,
 * as a clockwise-positive screen angle around the image centre.
 */
async function measureRotation(
  fixture: Marker, rotationDeg: number,
): Promise<{ measuredDeg: number; radiusPx: number; mass: number }> {
  const measured = await measureAdjustment(fixture, { rotation: rotationDeg });
  return { measuredDeg: measured.angleDeg, radiusPx: measured.radiusPx, mass: measured.mass };
}

async function measureAdjustment(
  fixture: Marker, adj: BuilderAdjustments,
): Promise<{ angleDeg: number; radiusPx: number; mass: number }> {
  const px = await renderGraph(fixture, adj);
  const c = centroid(px, fixture.width, fixture.height);
  const dx = c.x - fixture.width / 2;
  const dy = c.y - fixture.height / 2;
  return {
    angleDeg: Math.atan2(dy, dx) * (180 / Math.PI),
    radiusPx: Math.hypot(dx, dy),
    mass: c.mass,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('TransformPass rotation — measured, not assumed', () => {
  it('leaves the marker where it was at rotation 0 (rig sanity check)', async () => {
    const f = markerFixture(400, 300, 120);
    const m = await measureRotation(f, 0);
    expect(m.mass).toBeGreaterThan(0);
    expect(m.measuredDeg).toBeCloseTo(0, 0);
    expect(m.radiusPx).toBeCloseTo(120, 0);
  });

  // The horizontal marker sits on the vertical centre line, so it reads the
  // same whether or not the rig flips y somewhere. This one does not: it pins
  // the readout's orientation before any sign conclusion is drawn from it.
  it('preserves up-is-up at rotation 0 (pins the rig y-axis)', async () => {
    const m = await measureRotation(markerFixtureVertical(400, 300, 100), 0);
    expect(m.radiusPx).toBeCloseTo(100, 0);
    // Marker was drawn 100 px above centre; -90° is straight up in screen coords.
    expect(m.measuredDeg).toBeCloseTo(-90, 0);
  });

  // The core assertion: ask for N degrees, get N degrees. Sign follows CSS
  // `rotate()` — positive turns the picture clockwise on screen.
  for (const deg of [3, 5, 12, -7]) {
    it(`rotates a landscape frame by exactly ${deg}°`, async () => {
      const f = markerFixture(400, 300, 120);
      const m = await measureRotation(f, deg);
      expect(m.measuredDeg).toBeCloseTo(deg, 0);
      // A true rotation is rigid: the marker keeps its distance from centre.
      expect(m.radiusPx).toBeCloseTo(120, 0);
    });
  }

  // Aspect ratio is where texture-space rotation goes wrong, and it goes wrong
  // in opposite directions on landscape and portrait. Both must read the same.
  it('rotates a portrait frame by the same angle as a landscape one', async () => {
    const deg = 5;
    const land = await measureRotation(markerFixture(400, 300, 120), deg);
    const port = await measureRotation(markerFixture(300, 400, 90), deg);
    const square = await measureRotation(markerFixture(360, 360, 120), deg);
    expect(square.measuredDeg).toBeCloseTo(deg, 0);
    expect(land.measuredDeg).toBeCloseTo(deg, 0);
    expect(port.measuredDeg).toBeCloseTo(deg, 0);
  });

  // Hypothesis from the handoff: u_resolution comes from the render target, so
  // a Smart Preview / downscaled render could feed the shader the wrong aspect.
  // A downscale keeps the ratio, so the angle must not move with the size.
  it('reads the same angle on a downscaled render target', async () => {
    const deg = 6;
    const full = await measureRotation(markerFixture(800, 600, 240), deg);
    const half = await measureRotation(markerFixture(400, 300, 120), deg);
    expect(full.measuredDeg).toBeCloseTo(deg, 0);
    expect(half.measuredDeg).toBeCloseTo(deg, 0);
  });

  it('uses the clockwise-positive screen convention', async () => {
    const deg = 6;
    const gl = await measureRotation(markerFixture(400, 300, 120), deg);
    expect(gl.measuredDeg).toBeCloseTo(deg, 0);
  });

  it('is rigid: a marker off the vertical axis keeps its angle too', async () => {
    // Offsetting along y instead of x separates rotation from shear: a shear
    // mis-reads this marker by a different amount than the horizontal one, a
    // true rotation by the same amount (namely none).
    const deg = 8;
    const off = 100;
    const m = await measureRotation(markerFixtureVertical(400, 300, off), deg);
    // Marker starts at -90° (straight up); clockwise rotation adds `deg`.
    expect(m.measuredDeg).toBeCloseTo(-90 + deg, 0);
    expect(m.radiusPx).toBeCloseTo(off, 0);
  });
});

describe('TransformPass perspective and distortion — pixel-square geometry', () => {
  it('applies equal horizontal and vertical perspective at equal pixel offsets', async () => {
    const offset = 90;
    const horizontal = await measureAdjustment(
      markerFixture(480, 300, offset),
      { perspectiveH: 80 },
    );
    const vertical = await measureAdjustment(
      markerFixtureVertical(480, 300, offset),
      { perspectiveV: -80 },
    );

    expect(horizontal.mass).toBeGreaterThan(0);
    expect(vertical.mass).toBeGreaterThan(0);
    expect(horizontal.radiusPx).toBeGreaterThan(offset + 8);
    expect(vertical.radiusPx).toBeGreaterThan(offset + 8);
    expect(Math.abs(horizontal.radiusPx - vertical.radiusPx)).toBeLessThan(1.5);
  });

  it('keeps radial distortion circular in pixel space on a wide frame', async () => {
    const offset = 110;
    const horizontal = await measureAdjustment(
      markerFixture(480, 300, offset),
      { distortion: 100 },
    );
    const vertical = await measureAdjustment(
      markerFixtureVertical(480, 300, offset),
      { distortion: 100 },
    );

    expect(horizontal.mass).toBeGreaterThan(0);
    expect(vertical.mass).toBeGreaterThan(0);
    expect(horizontal.radiusPx).toBeLessThan(offset - 5);
    expect(vertical.radiusPx).toBeLessThan(offset - 5);
    expect(Math.abs(horizontal.radiusPx - vertical.radiusPx)).toBeLessThan(1.5);
  });
});
