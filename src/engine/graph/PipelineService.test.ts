import { describe, expect, it, vi } from 'vitest';
import { FakeGl, asGl } from './__testHelpers';
import { PipelineService, readPixels16 } from './PipelineService';
import { requireHalfFloatColorBuffer } from '../webglCaps';
import { buildDefaultGraph, paramsByNodeFromAdjustments } from './DefaultGraphBuilder';
import { raw16Source } from './projection/projectionFixtures';

const baseGeometry = { width: 32, height: 32, pixelRatio: 1 };

describe('PipelineService', () => {
  it('requires the half-float color-buffer extension in an independent GL context', () => {
    expect(() => requireHalfFloatColorBuffer(asGl(new FakeGl({ halfFloatExtension: false }))))
      .toThrow(/EXT_color_buffer_half_float is required/);
  });

  it('fails closed on incomplete or errored chunk readback', () => {
    const texture = {} as WebGLTexture;
    expect(() => readPixels16(
      asGl(new FakeGl({ framebufferStatus: 0x8CD6 })), texture, 1, 1,
    )).toThrow(/readback framebuffer incomplete.*8cd6/);
    expect(() => readPixels16(
      asGl(new FakeGl({ glError: 0x0502 })), texture, 1, 1,
    )).toThrow(/HALF_FLOAT readPixels failed.*502/);
    expect(() => readPixels16(
      asGl(new FakeGl({ implementationReadType: 0x1406, glError: 0x0502 })), texture, 1, 1,
    )).toThrow(/FLOAT readPixels failed.*502/);
  });

  it('uses the implementation HALF_FLOAT pair when explicitly reported', () => {
    const gl = new FakeGl({
      implementationReadType: 0x140B,
      readPixelsFill: (args) => {
        const target = args[6] as Uint16Array;
        target.set([0x0000, 0x3800, 0x3C00, 0x3C00]);
      },
    });
    const pixels = readPixels16(asGl(gl), {} as WebGLTexture, 1, 1);
    const call = gl.findCalls('readPixels')[0];
    expect(call.args[5]).toBe(gl.HALF_FLOAT);
    expect(call.args[6]).toBeInstanceOf(Uint16Array);
    expect([...pixels]).toEqual([0, 32768, 65535, 65535]);
  });

  it('falls back to chunked FLOAT readback and preserves more than 256 levels', () => {
    const width = 1024;
    const height = 513;
    const gl = new FakeGl({
      implementationReadType: 0x1406,
      readPixelsFill: (args) => {
        const rows = args[3] as number;
        const target = args[6] as Float32Array;
        for (let row = 0; row < rows; row++) {
          for (let x = 0; x < width; x++) {
            const value = x / (width - 1);
            const index = (row * width + x) * 4;
            target[index] = value;
            target[index + 1] = value;
            target[index + 2] = value;
            target[index + 3] = 1;
          }
        }
      },
    });
    const pixels = readPixels16(asGl(gl), {} as WebGLTexture, width, height);
    const calls = gl.findCalls('readPixels');
    const firstRowRed = Array.from({ length: width }, (_, x) => pixels[x * 4]);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.args[5] === gl.FLOAT)).toBe(true);
    expect(calls.every((call) => call.args[6] instanceof Float32Array)).toBe(true);
    expect(new Set(firstRowRed).size).toBeGreaterThan(256);
    expect(firstRowRed.some((value) => value % 257 !== 0)).toBe(true);
  });

  it('registers built-in convert, source, and pass kinds on construction', () => {
    const gl = new FakeGl();
    const svc = new PipelineService(asGl(gl));
    expect(svc.registry.has('tone')).toBe(true);
    expect(svc.registry.has('whiteBalance')).toBe(true);
    expect(svc.registry.has('toneCurve')).toBe(true);
    expect(svc.registry.has('__source.imageBitmap')).toBe(true);
    expect(svc.registry.has('__convert.linToGamma')).toBe(true);
    expect(svc.registry.has('__tap')).toBe(true);
    svc.release();
  });

  it('caches plans by topology — second compile is a hit', async () => {
    const gl = new FakeGl();
    const svc = new PipelineService(asGl(gl));
    const { graph } = buildDefaultGraph({ exposure: 50 }, { kind: 'imageBitmap', geometry: baseGeometry });

    const compileSpy = vi.spyOn(svc['compiler'], 'compile');
    await svc.compile(graph);
    await svc.compile(graph);
    expect(compileSpy).toHaveBeenCalledTimes(1);
    svc.release();
  });

  it('shares one plan between two RAWs with different camera profiles, their params stay apart', async () => {
    const gl = new FakeGl();
    const svc = new PipelineService(asGl(gl));
    const profiled = (exposure: number) => raw16Source({ geometry: baseGeometry, baseAdjustments: { exposure } });

    const compileSpy = vi.spyOn(svc['compiler'], 'compile');
    const a = await svc.compile(buildDefaultGraph({}, profiled(30)).graph);
    const b = await svc.compile(buildDefaultGraph({}, profiled(-40)).graph);
    expect(compileSpy).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    // The shared plan has the first photo's profile baked in. The executor
    // takes a node's params from paramsByNode before node.params
    // (PipelineExecutor.executeNode), so the second photo renders with its own
    // profile only because the map carries the base:* keys.
    expect(a.augmentedNodes.get('base:tone')?.params).toMatchObject({ exposure: 0.3 });
    expect(paramsByNodeFromAdjustments({}, profiled(-40)).get('base:tone')).toMatchObject({ exposure: -0.4 });
    svc.release();
  });

  it('re-compiles when graph.metadata.revision bumps', async () => {
    const gl = new FakeGl();
    const svc = new PipelineService(asGl(gl));
    const { graph } = buildDefaultGraph({}, { kind: 'imageBitmap', geometry: baseGeometry });

    const compileSpy = vi.spyOn(svc['compiler'], 'compile');
    await svc.compile(graph);
    graph.metadata.revision = 2;
    await svc.compile(graph);
    expect(compileSpy).toHaveBeenCalledTimes(2);
    svc.release();
  });

  it('different graph topologies produce distinct cache keys', async () => {
    const gl = new FakeGl();
    const svc = new PipelineService(asGl(gl));
    const a = buildDefaultGraph({}, { kind: 'imageBitmap', geometry: baseGeometry }).graph;
    // Force a different topology by changing the source dimensions (graph id
    // is derived from them, so the cache key is distinct).
    const b = buildDefaultGraph({}, { kind: 'imageBitmap', geometry: { width: 64, height: 64, pixelRatio: 1 } }).graph;

    const compileSpy = vi.spyOn(svc['compiler'], 'compile');
    await svc.compile(a);
    await svc.compile(b);
    expect(compileSpy).toHaveBeenCalledTimes(2);
    svc.release();
  });

  it('invalidatePlan removes the cached entry', async () => {
    const gl = new FakeGl();
    const svc = new PipelineService(asGl(gl));
    const { graph } = buildDefaultGraph({}, { kind: 'imageBitmap', geometry: baseGeometry });

    const compileSpy = vi.spyOn(svc['compiler'], 'compile');
    await svc.compile(graph);
    svc.invalidatePlan(graph);
    await svc.compile(graph);
    expect(compileSpy).toHaveBeenCalledTimes(2);
    svc.release();
  });

  it('release frees executor + clears cache', async () => {
    const gl = new FakeGl();
    const svc = new PipelineService(asGl(gl));
    const { graph } = buildDefaultGraph({}, { kind: 'imageBitmap', geometry: baseGeometry });
    await svc.compile(graph);
    svc.release();
    // Subsequent compile would re-run because cache cleared.
    const compileSpy = vi.spyOn(svc['compiler'], 'compile');
    await svc.compile(graph);
    expect(compileSpy).toHaveBeenCalledTimes(1);
  });
});
