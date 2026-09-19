/**
 * What the library actually puts into the DOM, measured in a real browser.
 *
 * The node project cannot answer this: the range depends on layout (`clientHeight`,
 * `getBoundingClientRect`, the CSS that makes `.photo-grid` the scroll box), and
 * a jsdom without layout reports zero for all of it. So the grids are mounted
 * here, against the real stylesheet, and the tiles are counted.
 *
 * Two claims are under test:
 *  - F021: with folder grouping several grids share one scroll parent, and a
 *    grid further down must subtract its own offset or it renders nothing.
 *  - F089: timeline and gallery strip used to render every photo; with ten
 *    thousand photos that was ten thousand tiles.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PhotoView } from '../../storage/repos';
import '../PhotoGrid.css';

// A tile's thumbnail load is not what this measures, and ten thousand of them
// would drown the run in timers.
vi.mock('../../hooks/useThumbnail', () => ({
  useThumbnail: () => ({ url: undefined, hasEdit: false }),
}));

import { TilesView } from './TilesView';
import { TimelineView } from './TimelineView';
import { GalleryView } from './GalleryView';
import { AdaptiveLayoutProvider } from '../../contexts/AdaptiveLayoutContext';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOST_WIDTH = 1200;
const HOST_HEIGHT = 800;
const TILE_SIZE = 180;

function photo(id: number, folder: string, dateTaken: number | null): PhotoView {
  return {
    id,
    sourceId: 'fixture',
    sourcePhotoId: `${folder}/${String(id).padStart(5, '0')}.jpg`,
    name: `${String(id).padStart(5, '0')}.jpg`,
    contentHash: null,
    availability: 'online',
    dateTaken,
    indexedAt: 1,
    updatedAt: 1,
  } as PhotoView;
}

/** `count` photos spread over `months` month groups, newest first. */
function photosOverMonths(count: number, months: number): PhotoView[] {
  const perMonth = Math.ceil(count / months);
  return Array.from({ length: count }, (_, i) =>
    photo(i + 1, 'lib', Date.UTC(2020 + Math.floor(i / perMonth / 12), Math.floor(i / perMonth) % 12, 1 + (i % 27))));
}

interface Mounted {
  host: HTMLDivElement;
  scroller: HTMLElement;
  tiles(): number;
  scrollTo(offset: number): void;
  unmount(): void;
}

let mounted: Mounted | null = null;

function mount(element: ReactElement): Mounted {
  const host = document.createElement('div');
  host.style.cssText = `width:${HOST_WIDTH}px;height:${HOST_HEIGHT}px;position:fixed;top:0;left:0;`;
  document.body.appendChild(host);
  let root: Root;
  act(() => {
    root = createRoot(host);
    // TileItem asks useAdaptiveLayout() for hoverAvailable (the hover-prefetch
    // gate); the app always renders under this provider, so the test must too.
    root.render(createElement(AdaptiveLayoutProvider, null, element));
  });
  const scroller = host.querySelector<HTMLElement>('.photo-grid')!;
  const result: Mounted = {
    host,
    scroller,
    tiles: () => host.querySelectorAll('.grid-item').length,
    scrollTo(offset: number) {
      act(() => {
        scroller.scrollTop = offset;
        scroller.dispatchEvent(new Event('scroll'));
      });
    },
    unmount() { act(() => root.unmount()); host.remove(); },
  };
  mounted = result;
  return result;
}

let observerCount = 0;
beforeAll(() => {
  const Real = window.IntersectionObserver;
  class Counting extends Real {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      super(callback, options);
      observerCount++;
    }
  }
  window.IntersectionObserver = Counting;
  return () => { window.IntersectionObserver = Real; };
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('folder grouping (F021)', () => {
  it('shows tiles in the second folder once it is scrolled into view', () => {
    const photos = [
      ...Array.from({ length: 400 }, (_, i) => photo(i + 1, 'A', null)),
      ...Array.from({ length: 100 }, (_, i) => photo(1000 + i, 'B', null)),
    ];
    const view = mount(createElement(TilesView, {
      photos, selectedIds: new Set<number>(), multiSelect: false, groupMode: 'folder',
      tileSize: TILE_SIZE, gridFlow: 'left', onSelect: () => {}, onOpen: () => {},
    }));

    const sections = view.host.querySelectorAll<HTMLElement>('.folder-section');
    expect(sections).toHaveLength(2);
    const second = sections[1];
    const offset = second.getBoundingClientRect().top
      - view.scroller.getBoundingClientRect().top + view.scroller.scrollTop;
    view.scrollTo(offset);

    const inSecond = second.querySelectorAll('.grid-item').length;
    console.log(`[measure] folder B tiles after scrolling to it: ${inSecond}`);
    expect(inSecond).toBeGreaterThan(0);
    expect(inSecond).toBeLessThanOrEqual(100);
  });
});

describe('ten thousand photos (F089)', () => {
  const TOTAL = 10_000;

  it('keeps the timeline under 400 tiles', () => {
    const view = mount(createElement(TimelineView, {
      photos: photosOverMonths(TOTAL, 24), selectedIds: new Set<number>(), multiSelect: false,
      tileSize: TILE_SIZE, gridFlow: 'left', onSelect: () => {}, onOpen: () => {},
    }));

    const atTop = view.tiles();
    view.scrollTo(view.scroller.scrollHeight / 2);
    const midway = view.tiles();
    console.log(`[measure] timeline tiles for ${TOTAL} photos: ${atTop} at the top, ${midway} midway`);
    expect(atTop).toBeLessThan(400);
    expect(midway).toBeLessThan(400);
    expect(midway).toBeGreaterThan(0);
  }, 120_000);

  it('keeps the gallery strip under 100 thumbnails', () => {
    const photos = photosOverMonths(TOTAL, 24);
    const view = mount(createElement(GalleryView, {
      photos, selectedIds: new Set<number>(), tileSize: TILE_SIZE,
      onSelect: () => {}, onOpen: () => {},
    }));
    const strip = view.host.querySelector<HTMLElement>('.gallery-strip')!;
    const count = () => strip.querySelectorAll('.gallery-strip-item').length;

    const atStart = count();
    act(() => {
      strip.scrollLeft = strip.scrollWidth / 2;
      strip.dispatchEvent(new Event('scroll'));
    });
    const midway = count();
    console.log(`[measure] gallery strip items for ${TOTAL} photos: ${atStart} at the start, ${midway} midway`);
    expect(atStart).toBeLessThan(100);
    expect(midway).toBeLessThan(100);
    expect(midway).toBeGreaterThan(0);
  }, 120_000);

  /**
   * The placeholder's length and the thumbnails' real positions have to be the
   * same arithmetic, or the strip drifts a few pixels per photo. It did: the
   * 2 px border used to sit OUTSIDE the width the strip computes with, which
   * made every thumbnail 4 px wider than the model.
   */
  it('places every thumbnail where its scroll length says it is', () => {
    const view = mount(createElement(GalleryView, {
      photos: photosOverMonths(40, 2), selectedIds: new Set<number>(), tileSize: TILE_SIZE,
      onSelect: () => {}, onOpen: () => {},
    }));
    const strip = view.host.querySelector<HTMLElement>('.gallery-strip')!;
    const track = view.host.querySelector<HTMLElement>('.gallery-strip-track')!;
    const items = Array.from(view.host.querySelectorAll<HTMLElement>('.gallery-strip-item'));
    const stripLeft = strip.getBoundingClientRect().left;
    const x = (el: HTMLElement) => Math.round(el.getBoundingClientRect().left - stripLeft);

    // 8 px strip padding, a 74 px thumbnail (the 90 px strip minus its padding)
    // and a 4 px gap: one column every 78 px.
    expect(items.slice(0, 4).map(x)).toEqual([8, 86, 164, 242]);
    expect(x(items[items.length - 1])).toBe(8 + (items.length - 1) * 78);
    expect(Math.round(track.getBoundingClientRect().width)).toBe(40 * 78 - 4);
  });

  it('needs no IntersectionObserver per photo', () => {
    console.log(`[measure] IntersectionObservers constructed so far: ${observerCount}`);
    expect(observerCount).toBeLessThan(50);
  });
});
