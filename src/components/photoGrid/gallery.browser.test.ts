/**
 * The gallery, measured in a real browser.
 *
 * Both claims here need layout, which a jsdom cannot give: the film strip is
 * virtualised along its own axis, so where a thumbnail sits and whether the
 * load-more trigger has come within reach are both questions about boxes.
 *
 *  - the router handed `loadMoreEl` to tiles, list and timeline but not to the
 *    gallery, so a gallery with more pages waiting stayed on the first one.
 *  - the arrow keys moved the main image while the strip stayed put, so the
 *    active thumbnail walked out of the strip and, being virtualised, out of
 *    the DOM with it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PhotoView } from '../../storage/repos';
import '../PhotoGrid.css';

vi.mock('../../hooks/useThumbnail', () => ({
  useThumbnail: () => ({ url: undefined, hasEdit: false }),
}));

import { PhotoGrid } from '../PhotoGrid';
import { AdaptiveLayoutProvider } from '../../contexts/AdaptiveLayoutContext';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Clamped to the page, not wished for: the vitest page is a few hundred pixels
// wide, and a host wider than it would push the load-more trigger outside the
// IntersectionObserver's root (the viewport) however far the strip is scrolled.
// Nothing below asserts these numbers - every assertion measures the strip.
const HOST_WIDTH = Math.min(1200, document.documentElement.clientWidth);
const HOST_HEIGHT = Math.min(800, document.documentElement.clientHeight);

function photo(id: number): PhotoView {
  return {
    id,
    sourceId: 'fixture',
    sourcePhotoId: `lib/${String(id).padStart(5, '0')}.jpg`,
    name: `${String(id).padStart(5, '0')}.jpg`,
    contentHash: null,
    availability: 'online',
    dateTaken: null,
    indexedAt: 1,
    updatedAt: 1,
  } as PhotoView;
}

const photos = (count: number) => Array.from({ length: count }, (_, i) => photo(i + 1));

interface Mounted {
  host: HTMLDivElement;
  strip: HTMLElement;
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
    // TileItem asks useAdaptiveLayout() for its hover-prefetch gate, and
    // PhotoGrid itself asks for the screen class; the app always renders under
    // this provider, so the test must too.
    root.render(createElement(AdaptiveLayoutProvider, null, element));
  });
  const result: Mounted = {
    host,
    strip: host.querySelector<HTMLElement>('.gallery-strip')!,
    unmount() { act(() => root.unmount()); host.remove(); },
  };
  mounted = result;
  return result;
}

/**
 * Two frames. An IntersectionObserver reports no earlier than the next one,
 * and a programmatic `scrollLeft` dispatches its scroll event just as late -
 * which is what re-renders the virtualised window around the new position.
 */
async function settleFrames(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }
}

function gallery(props: { photos: PhotoView[]; canLoadMore: boolean; onLoadMore: () => void }) {
  return createElement(PhotoGrid, {
    photos: props.photos,
    selectedIds: new Set<number>(),
    multiSelect: false,
    gridMode: 'gallery',
    groupMode: 'none',
    tileSize: 180,
    gridFlow: 'left',
    onSelect: () => {},
    onOpen: () => {},
    canLoadMore: props.canLoadMore,
    onLoadMore: props.onLoadMore,
    scanning: false,
  });
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('the gallery can load the next page (F089)', () => {
  it('puts exactly one load-more trigger at the end of the strip', () => {
    const view = mount(gallery({ photos: photos(500), canLoadMore: true, onLoadMore: () => {} }));

    expect(view.strip.querySelectorAll('.load-more-trigger')).toHaveLength(1);
    // Behind every thumbnail, not floating over the first ones.
    const track = view.host.querySelector<HTMLElement>('.gallery-strip-track')!;
    const trigger = view.strip.querySelector<HTMLElement>('.load-more-trigger')!;
    expect(trigger.getBoundingClientRect().left)
      .toBeGreaterThanOrEqual(track.getBoundingClientRect().right - 1);
  });

  it('has no trigger while there is nothing more to load', () => {
    const view = mount(gallery({ photos: photos(500), canLoadMore: false, onLoadMore: () => {} }));
    expect(view.strip.querySelectorAll('.load-more-trigger')).toHaveLength(0);
  });

  it('loads the next page when the strip is scrolled to its end', async () => {
    let calls = 0;
    const view = mount(gallery({ photos: photos(500), canLoadMore: true, onLoadMore: () => { calls++; } }));

    // 500 thumbnails at 78 px each put the trigger some 39 000 px to the
    // right, far past the observer's 800 px margin: nothing asked for yet.
    await settleFrames();
    expect(calls).toBe(0);

    await act(async () => {
      view.strip.scrollLeft = view.strip.scrollWidth;
      view.strip.dispatchEvent(new Event('scroll'));
    });
    await settleFrames();
    expect(calls).toBeGreaterThan(0);
  });

  it('loads the next page when the button is pressed', () => {
    let calls = 0;
    const view = mount(gallery({ photos: photos(500), canLoadMore: true, onLoadMore: () => { calls++; } }));

    const button = view.strip.querySelector<HTMLButtonElement>('.load-more-btn')!;
    const before = calls;
    act(() => { button.click(); });
    expect(calls).toBe(before + 1);
  });
});

/**
 * The strip's geometry, as the stylesheet lays it out: a 90 px strip (tile size
 * 180 halved) minus 16 px padding is a 74 px thumbnail, 4 px gap, and the track
 * starts 8 px in. `scrollOffsetToReveal` scrolls just far enough, so the
 * revealed thumbnail ends flush with the strip's right edge - which is an
 * absolute position, not "it scrolled somewhere".
 */
describe('the strip follows the arrow keys', () => {
  const PAD = 8;
  const SIZE = 74;
  const STRIDE = 78;

  /**
   * One `act` per press on purpose: the key handler reads `activeIndex` out of
   * the closure it was rendered with, so a batch of presses would all step off
   * the same index and move exactly one photo.
   */
  function arrows(view: Mounted, key: 'ArrowLeft' | 'ArrowRight', times: number) {
    const surface = view.host.querySelector<HTMLElement>('.photo-grid.gallery-view')!;
    for (let i = 0; i < times; i++) {
      act(() => {
        surface.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
    }
  }

  it('has the active thumbnail in the DOM and flush at the right edge', async () => {
    const view = mount(gallery({ photos: photos(500), canLoadMore: false, onLoadMore: () => {} }));
    const presses = 40;
    arrows(view, 'ArrowRight', presses);
    await settleFrames();

    const active = view.host.querySelector<HTMLElement>('.gallery-strip-item.active');
    expect(active).not.toBeNull();
    expect(Math.round(view.strip.scrollLeft))
      .toBe(PAD + presses * STRIDE + SIZE - view.strip.clientWidth);
    expect(Math.round(active!.getBoundingClientRect().right - view.strip.getBoundingClientRect().left))
      .toBe(view.strip.clientWidth);
  });

  it('scrolls back to the first thumbnail on the way left', async () => {
    const view = mount(gallery({ photos: photos(500), canLoadMore: false, onLoadMore: () => {} }));
    arrows(view, 'ArrowRight', 60);
    expect(view.strip.scrollLeft).toBeGreaterThan(0);
    arrows(view, 'ArrowLeft', 60);
    await settleFrames();

    expect(Math.round(view.strip.scrollLeft)).toBe(PAD);
    const active = view.host.querySelector<HTMLElement>('.gallery-strip-item.active')!;
    expect(Math.round(active.getBoundingClientRect().left - view.strip.getBoundingClientRect().left))
      .toBe(0);
  });
});
