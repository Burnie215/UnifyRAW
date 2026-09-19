/**
 * The navigator's preview, mounted.
 *
 * F060: the unmount cleanup closed over `previewUrl` from the FIRST render -
 * which is null - so it revoked nothing, and every editor round left its last
 * preview blob behind. Only a real mount/unmount can show that: the leak is in
 * the lifecycle, not in the arithmetic, and `OffscreenCanvas.convertToBlob` is
 * not something the node project hands out either.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { Navigator } from './Navigator';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  host: HTMLDivElement;
  previewUrl(): string | null;
  render(generation: number): void;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => { mounted?.unmount(); mounted = null; vi.restoreAllMocks(); });

function sourceCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#7a7a7a';
  ctx.fillRect(0, 0, 64, 48);
  return canvas;
}

function mount(canvas: HTMLCanvasElement): Mounted {
  const host = document.createElement('div');
  host.style.cssText = 'width:280px;position:fixed;top:0;left:0;';
  document.body.appendChild(host);
  let root: Root;
  const props = (generation: number) => ({
    imageUrl: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    fitScale: 1,
    displayW: 640,
    displayH: 480,
    onPanChange: () => {},
    onZoomChange: () => {},
    renderedCanvas: canvas,
    renderGeneration: generation,
  });
  act(() => {
    root = createRoot(host);
    root.render(createElement(Navigator, props(1)));
  });
  const m: Mounted = {
    host,
    previewUrl: () => host.querySelector<HTMLImageElement>('img.navigator-img')?.getAttribute('src') ?? null,
    render: (generation) => { act(() => { root.render(createElement(Navigator, props(generation))); }); },
    unmount: () => { act(() => { root.unmount(); }); host.remove(); },
  };
  mounted = m;
  return m;
}

/** The preview is produced by an async convertToBlob; wait for it to land. */
async function waitForPreview(m: Mounted, notUrl: string | null = null): Promise<string> {
  for (let i = 0; i < 60; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const url = m.previewUrl();
    if (url?.startsWith('blob:') && url !== notUrl) return url;
  }
  throw new Error('no preview blob URL appeared');
}

/** How often exactly this URL was handed to revokeObjectURL. */
function revokedTimes(spy: { mock: { calls: unknown[][] } }, url: string): number {
  return spy.mock.calls.filter((call) => call[0] === url).length;
}

describe('Navigator preview URLs', () => {
  it('releases the preview it is showing when the editor closes', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const m = mount(sourceCanvas());
    const url = await waitForPreview(m);

    expect(revokedTimes(revoke, url)).toBe(0);
    m.unmount();
    mounted = null;

    expect(revokedTimes(revoke, url)).toBe(1);
  });

  it('releases the previous preview when a new render replaces it', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const m = mount(sourceCanvas());
    const first = await waitForPreview(m);

    m.render(2);
    const second = await waitForPreview(m, first);

    expect(second).not.toBe(first);
    expect(revokedTimes(revoke, first)).toBe(1);
    expect(revokedTimes(revoke, second)).toBe(0);

    m.unmount();
    mounted = null;
    expect(revokedTimes(revoke, first)).toBe(1);
    expect(revokedTimes(revoke, second)).toBe(1);
  });
});
