/**
 * The preset panel's thumbnails, mounted.
 *
 * F060: every preset thumbnail is an object URL, and the hook released them
 * from inside a `setThumbnails` updater in an UNMOUNT cleanup - React never
 * runs an updater for a component that is gone, so the whole panel's worth of
 * blobs stayed alive for the life of the tab. A second, smaller loss sat in
 * `renderAll`: a generation change dropped the URLs the loop had already made.
 *
 * Both are lifecycle facts, so the hook is mounted here. The pipeline service
 * is mocked - what is under test is the bookkeeping, not the render.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PresetRow } from '../storage/repos';

const graph = vi.hoisted(() => {
  let renders = 0;
  let renderDelayMs = 0;
  const service = {
    compile: async () => ({ id: 'plan' }),
    bindSource: vi.fn(async (_id: string, _source: unknown) => {}),
    unbindSource: vi.fn(async (_id: string) => {}),
    renderToBlob: async () => {
      if (renderDelayMs > 0) await new Promise((r) => setTimeout(r, renderDelayMs));
      return new Blob([`thumb-${++renders}`], { type: 'image/jpeg' });
    },
  };
  return {
    service,
    setRenderDelay: (ms: number) => { renderDelayMs = ms; },
  };
});

vi.mock('../engine/graph', () => ({
  getDefaultPipelineService: () => graph.service,
  buildDefaultGraph: () => ({ graph: { id: 'preset-thumb-test' } }),
  adjustmentsToBuilderAdjustments: (adjustments: unknown) => adjustments,
  paramsByNodeFromAdjustments: () => ({}),
  KIND_RAW16_SOURCE: '__source.raw16',
}));

import { usePresetThumbnails, type PresetThumbRawSource } from './usePresetThumbnails';
import { acquirePreviewSource, rawPreviewSourceSpec } from './previewSource';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function preset(id: number): PresetRow {
  return {
    id,
    syncId: `p${id}`,
    name: `Preset ${id}`,
    adjustments: { exposure: id },
    category: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
}

/** A tiny real image, so the hook's fetch + createImageBitmap path runs. */
function imageDataUrl(shade: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, 8, 8);
  return canvas.toDataURL('image/png');
}

interface Mounted {
  thumbnails(): Map<number, string>;
  render(imageUrl: string | null, presets: PresetRow[], rawSource?: PresetThumbRawSource | null): void;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
  graph.service.bindSource.mockClear();
  graph.service.unbindSource.mockClear();
  graph.setRenderDelay(0);
});

function mount(
  imageUrl: string | null,
  presets: PresetRow[],
  rawSource?: PresetThumbRawSource | null,
): Mounted {
  const seen = { current: new Map<number, string>() };
  function Probe({ url, rows, raw }: { url: string | null; rows: PresetRow[]; raw?: PresetThumbRawSource | null }) {
    seen.current = usePresetThumbnails(url, rows, raw);
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  let root: Root;
  act(() => {
    root = createRoot(host);
    root.render(createElement(Probe, { url: imageUrl, rows: presets, raw: rawSource }));
  });
  const m: Mounted = {
    thumbnails: () => seen.current,
    render: (url, rows, raw) => { act(() => { root.render(createElement(Probe, { url, rows, raw })); }); },
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
  mounted = m;
  return m;
}

async function settle(ms = 80): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}

async function waitForThumbnails(m: Mounted, count: number): Promise<string[]> {
  for (let i = 0; i < 60; i++) {
    await settle(50);
    if (m.thumbnails().size === count) return [...m.thumbnails().values()];
  }
  throw new Error(`only ${m.thumbnails().size} of ${count} preset thumbnails appeared`);
}

describe('usePresetThumbnails object URLs', () => {
  it('shares the 512px RAW preview source instead of binding the full sensor buffer', async () => {
    const pixels = {
      data: new Uint16Array(2048 * 1024 * 3),
      width: 2048,
      height: 1024,
      channels: 3 as const,
      bits: 16 as const,
    };
    const rawSource = { pixels };
    const m = mount(null, [preset(1)], rawSource);
    await waitForThumbnails(m, 1);

    expect(graph.service.bindSource).toHaveBeenCalledTimes(1);
    const bound = graph.service.bindSource.mock.calls[0][1] as {
      pixels: Uint16Array;
      width: number;
      height: number;
    };
    expect({ width: bound.width, height: bound.height }).toEqual({ width: 512, height: 256 });
    expect(bound.pixels).toHaveLength(512 * 256 * 3);
    expect(pixels.data).toHaveLength(2048 * 1024 * 3);

    const lease = await acquirePreviewSource(rawPreviewSourceSpec(pixels)!);
    expect(graph.service.bindSource).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it('releases every thumbnail when the panel goes away', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const m = mount(imageDataUrl('#808080'), [preset(1), preset(2), preset(3)]);
    const urls = await waitForThumbnails(m, 3);

    expect(urls.every((url) => url.startsWith('blob:'))).toBe(true);
    expect(revoke.mock.calls.flat()).toEqual([]);

    m.unmount();
    mounted = null;

    expect(revoke.mock.calls.flat().sort()).toEqual([...urls].sort());
  });

  it('releases the old thumbnails when the open photo changes', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const m = mount(imageDataUrl('#808080'), [preset(1), preset(2)]);
    const first = await waitForThumbnails(m, 2);

    m.render(imageDataUrl('#303030'), [preset(1), preset(2)]);
    await settle(400);

    for (const url of first) {
      expect(revoke.mock.calls.filter((call) => call[0] === url)).toHaveLength(1);
    }
  });

  it('keeps nothing back when a preset change overtakes a running render', async () => {
    const created = vi.spyOn(URL, 'createObjectURL');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    graph.setRenderDelay(120);

    const m = mount(imageDataUrl('#808080'), [preset(1), preset(2), preset(3)]);
    await settle(300);
    // The first pass is mid-loop here: it has made a URL or two that nothing
    // will ever show, because this render retires its generation.
    m.render(imageDataUrl('#808080'), [preset(4), preset(5), preset(6)]);
    await waitForThumbnails(m, 3);

    m.unmount();
    mounted = null;
    await settle(200);

    const madeByHook = created.mock.results.map((r) => r.value as string).filter((url) => url.startsWith('blob:'));
    expect(madeByHook.length).toBeGreaterThan(3);
    const released = new Set(revoke.mock.calls.map((call) => call[0]));
    expect(madeByHook.filter((url) => !released.has(url))).toEqual([]);
  });

  it('releases a render that lands after the panel is already gone', async () => {
    const created = vi.spyOn(URL, 'createObjectURL');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    graph.setRenderDelay(150);

    const m = mount(imageDataUrl('#808080'), [preset(1), preset(2)]);
    await settle(250);
    // The loop is between two presets; closing the editor here used to leave
    // whatever it produced afterwards with nowhere to go.
    m.unmount();
    mounted = null;
    await settle(700);

    const madeByHook = created.mock.results.map((r) => r.value as string).filter((url) => url.startsWith('blob:'));
    expect(madeByHook.length).toBeGreaterThan(0);
    const released = new Set(revoke.mock.calls.map((call) => call[0]));
    expect(madeByHook.filter((url) => !released.has(url))).toEqual([]);
  });
});
