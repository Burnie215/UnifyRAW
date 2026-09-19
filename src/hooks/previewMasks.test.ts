/**
 * bindPreviewMasks is the piece that keeps the graph-editor previews honest:
 * a layered graph carries a `mask:<layerId>` source node per masked layer, and
 * without a bound texture the compositor's `u_mask` samples whatever is left
 * on the unit. These tests pin the binding contract (right node id, preview
 * size, release) without needing a GL context.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { bindPreviewMasks, maskSignature } from './usePreviewTapRenderer';
import type { RenderGraph } from '../engine/graph';
import type { MaskDefinition } from '../engine/Mask';

const rasterCalls: Array<{ mask: MaskDefinition; w: number; h: number }> = [];

vi.mock('../engine/Mask', () => ({
  renderMaskToCanvas: (mask: MaskDefinition, w: number, h: number) => {
    rasterCalls.push({ mask, w, h });
    return { width: w, height: h } as unknown as OffscreenCanvas;
  },
}));

const g = globalThis as unknown as { createImageBitmap?: unknown };
g.createImageBitmap = async (src: { width: number; height: number }) => src as unknown as ImageBitmap;

function makeGraph(maskNodeIds: string[]): RenderGraph {
  const nodes = new Map<string, { id: string; kind: string; params: unknown }>();
  nodes.set('default:exposure', { id: 'default:exposure', kind: 'x', params: {} });
  for (const id of maskNodeIds) nodes.set(id, { id, kind: '__source.rasterizedMask', params: {} });
  return { id: 'g', nodes, edges: [], output: 'default:exposure', metadata: { revision: 1 } } as unknown as RenderGraph;
}

function makeSvc() {
  const bound = new Set<string>();
  return {
    bound,
    bindSource: vi.fn(async (id: string) => { bound.add(id); }),
    unbindSource: vi.fn(async (id: string) => { bound.delete(id); }),
  };
}

const mask = (id: string): MaskDefinition => ({
  id, name: id, type: 'radial-gradient', visible: true,
  center: { x: 0.5, y: 0.5 }, radiusX: 0.3, radiusY: 0.3,
} as MaskDefinition);

beforeEach(() => { rasterCalls.length = 0; });

describe('bindPreviewMasks', () => {
  it('binds one source per mask node and maps it onto that node id', async () => {
    const svc = makeSvc();
    const graph = makeGraph(['mask:L1', 'mask:L2']);
    const res = await bindPreviewMasks(
      svc as never, graph,
      [{ layerId: 'L1', mask: mask('m1') }, { layerId: 'L2', mask: mask('m2') }],
      { width: 512, height: 341 }, 'p',
    );
    expect(Object.keys(res.extraSources ?? {}).sort()).toEqual(['mask:L1', 'mask:L2']);
    expect(svc.bound.size).toBe(2);
  });

  it('rasterizes at the downscaled preview size, not the native one', async () => {
    const svc = makeSvc();
    await bindPreviewMasks(
      svc as never, makeGraph(['mask:L1']), [{ layerId: 'L1', mask: mask('m1') }],
      { width: 512, height: 341 }, 'p',
    );
    expect(rasterCalls).toEqual([{ mask: expect.anything(), w: 512, h: 341 }]);
  });

  it('skips layers whose mask node the graph does not carry', async () => {
    const svc = makeSvc();
    const res = await bindPreviewMasks(
      svc as never, makeGraph([]), [{ layerId: 'L1', mask: mask('m1') }],
      { width: 64, height: 64 }, 'p',
    );
    expect(res.extraSources).toBeNull();
    expect(svc.bindSource).not.toHaveBeenCalled();
  });

  it('returns null extraSources when there is nothing to bind', async () => {
    const svc = makeSvc();
    const res = await bindPreviewMasks(svc as never, makeGraph(['mask:L1']), [], { width: 8, height: 8 }, 'p');
    expect(res.extraSources).toBeNull();
    await res.release();
    expect(svc.unbindSource).not.toHaveBeenCalled();
  });

  it('release unbinds everything it bound', async () => {
    const svc = makeSvc();
    const res = await bindPreviewMasks(
      svc as never, makeGraph(['mask:L1', 'mask:L2']),
      [{ layerId: 'L1', mask: mask('m1') }, { layerId: 'L2', mask: mask('m2') }],
      { width: 32, height: 32 }, 'p',
    );
    await res.release();
    expect(svc.bound.size).toBe(0);
    await res.release();
    expect(svc.unbindSource).toHaveBeenCalledTimes(2);
  });
});

describe('maskSignature', () => {
  it('is stable for equal content and changes with the shape', () => {
    const a = maskSignature([{ layerId: 'L1', mask: mask('m1') }]);
    const b = maskSignature([{ layerId: 'L1', mask: mask('m1') }]);
    expect(a).toBe(b);
    const moved = { ...mask('m1'), center: { x: 0.2, y: 0.5 } } as MaskDefinition;
    expect(maskSignature([{ layerId: 'L1', mask: moved }])).not.toBe(a);
  });

  it('is empty without masks', () => {
    expect(maskSignature(undefined)).toBe('');
    expect(maskSignature([])).toBe('');
  });
});
