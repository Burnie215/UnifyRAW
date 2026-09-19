/**
 * The timeline, measured in a real browser.
 *
 * Both claims need layout, which a jsdom cannot give: whether a month is
 * folded away is a question about what is in the DOM after a click, and the
 * tile size under "fill" is computed from the width the grid actually got.
 *
 *  - months are collapsible, so a long library can be walked by date.
 *  - the timeline runs on the tile scaling from the settings. It used to
 *    hard-wire `gridFlow: 'left'` and ignore it, so tiles in the timeline were
 *    a different size than the same photos in the tiles view.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PhotoView } from '../../storage/repos';
import type { GridFlow, GridMode } from '../../types';
import '../PhotoGrid.css';

vi.mock('../../hooks/useThumbnail', () => ({
  useThumbnail: () => ({ url: undefined, hasEdit: false }),
}));

import { PhotoGrid } from '../PhotoGrid';
import { AdaptiveLayoutProvider } from '../../contexts/AdaptiveLayoutContext';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST_WIDTH = Math.min(1200, document.documentElement.clientWidth);
const HOST_HEIGHT = Math.min(800, document.documentElement.clientHeight);
const TILE_SIZE = 180;

/** Two months, so folding one away leaves something to compare against. */
const JANUARY = Date.UTC(2026, 0, 12);
const MARCH = Date.UTC(2026, 2, 3);

function photo(id: number, dateTaken: number): PhotoView {
  return {
    id,
    sourceId: 'fixture',
    sourcePhotoId: `lib/${String(id).padStart(5, '0')}.jpg`,
    name: `${String(id).padStart(5, '0')}.jpg`,
    contentHash: null,
    availability: 'online',
    dateTaken,
    indexedAt: 1,
    updatedAt: 1,
  } as PhotoView;
}

const library = () => [
  ...Array.from({ length: 4 }, (_, i) => photo(i + 1, MARCH)),
  ...Array.from({ length: 3 }, (_, i) => photo(i + 10, JANUARY)),
];

let mounted: { host: HTMLDivElement; unmount(): void } | null = null;

function mount(element: ReactElement): HTMLDivElement {
  const host = document.createElement('div');
  host.style.cssText = `width:${HOST_WIDTH}px;height:${HOST_HEIGHT}px;position:fixed;top:0;left:0;`;
  document.body.appendChild(host);
  let root: Root;
  act(() => {
    root = createRoot(host);
    root.render(createElement(AdaptiveLayoutProvider, null, element));
  });
  mounted = { host, unmount() { act(() => root.unmount()); host.remove(); } };
  return host;
}

function grid(over: { gridMode: GridMode; gridFlow: GridFlow }) {
  return createElement(PhotoGrid, {
    photos: library(),
    selectedIds: new Set<number>(),
    multiSelect: false,
    groupMode: 'none',
    tileSize: TILE_SIZE,
    onSelect: () => {},
    onOpen: () => {},
    canLoadMore: false,
    onLoadMore: () => {},
    scanning: false,
    ...over,
  });
}

const months = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.timeline-month')];
const headers = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>('.timeline-month-header')];
const tiles = (el: ParentNode) => el.querySelectorAll('.grid-item.tile').length;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('the timeline folds a month away', () => {
  it('starts with every month open', () => {
    const host = mount(grid({ gridMode: 'timeline', gridFlow: 'left' }));
    expect(months(host)).toHaveLength(2);
    expect(headers(host).map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    expect(tiles(host)).toBe(7);
  });

  it('takes the month\'s tiles out on a click and brings them back on the next', () => {
    const host = mount(grid({ gridMode: 'timeline', gridFlow: 'left' }));
    const [march] = months(host);

    act(() => { headers(host)[0].click(); });
    expect(tiles(march)).toBe(0);
    expect(headers(host)[0].getAttribute('aria-expanded')).toBe('false');
    // The other month is untouched, and the header itself stays.
    expect(tiles(months(host)[1])).toBe(3);
    expect(headers(host)).toHaveLength(2);

    act(() => { headers(host)[0].click(); });
    expect(tiles(march)).toBe(4);
    expect(headers(host)[0].getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the timeline uses the tile scaling from the settings', () => {
  // Not pixel-for-pixel equal to the tiles view: the timeline is indented and
  // carries its own PHONE_TIMELINE_HORIZONTAL_INSET, so its tiles are a little
  // narrower on a phone by design. What has to match is the SETTING - the
  // timeline used to hard-wire `gridFlow: 'left'` and ignore it entirely.
  const flowOf = (host: HTMLElement) => getComputedStyle(
    host.querySelector<HTMLElement>('.tiles-grid-virtual > div')!,
  ).justifyContent;

  it('lays its tiles out the way the tiles view does, for every flow', () => {
    for (const flow of ['left', 'center', 'fill'] as const) {
      const timelineHost = mount(grid({ gridMode: 'timeline', gridFlow: flow }));
      const fromTimeline = flowOf(timelineHost);
      mounted!.unmount();
      mounted = null;

      const tilesHost = mount(grid({ gridMode: 'tiles', gridFlow: flow }));
      const fromTiles = flowOf(tilesHost);
      mounted!.unmount();
      mounted = null;

      expect(`${flow}: ${fromTimeline}`).toBe(`${flow}: ${fromTiles}`);
    }
  });

  it('centres under "center" and does not under "left"', () => {
    const centered = mount(grid({ gridMode: 'timeline', gridFlow: 'center' }));
    expect(flowOf(centered)).toBe('center');
    mounted!.unmount();
    mounted = null;

    const left = mount(grid({ gridMode: 'timeline', gridFlow: 'left' }));
    expect(flowOf(left)).toBe('start');
  });

});
