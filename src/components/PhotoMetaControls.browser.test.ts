import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../brand', () => ({
  useBrand: () => ({ name: 'UnifyRAW' }),
}));

import { AdaptiveNavigation, type PhoneLibraryChrome } from './AdaptiveNavigation';
import { ContextMenu } from './ContextMenu';
import { PhotoMetaControls } from './PhotoMetaControls';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

function mount(element: React.ReactNode): void {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  act(() => root!.render(element));
}

function click(selector: string): void {
  const button = host!.querySelector<HTMLButtonElement>(selector);
  if (!button) throw new Error(`no element for ${selector}`);
  act(() => button.click());
}

function metaSetters() {
  return {
    onSetRating: vi.fn(),
    onSetFlag: vi.fn(),
    onSetColorLabel: vi.fn(),
  };
}

function library(overrides: Partial<PhoneLibraryChrome> = {}): PhoneLibraryChrome {
  return {
    title: 'All photos', totalCount: 4, filteredCount: 4,
    search: '', onSearchChange: vi.fn(), sort: 'name-asc', onSortChange: vi.fn(),
    gridMode: 'tiles', onGridModeChange: vi.fn(), groupMode: 'none', onGroupModeChange: vi.fn(),
    tileSize: 180, onTileSizeChange: vi.fn(), libraryViewMode: 'grid', onLibraryViewModeChange: vi.fn(),
    multiSelect: true, selectedCount: 2, onMultiSelectToggle: vi.fn(), onRemoveSelected: vi.fn(),
    ratingFilter: 0, onRatingFilterChange: vi.fn(),
    flagFilter: 'all', onFlagFilterChange: vi.fn(),
    labelFilter: 'all', onLabelFilterChange: vi.fn(),
    availabilityFilter: 'online', onAvailabilityFilterChange: vi.fn(),
    keywordFilter: '', onKeywordFilterChange: vi.fn(),
    cameraFilter: 'all', onCameraFilterChange: vi.fn(),
    lensFilter: 'all', onLensFilterChange: vi.fn(),
    ...overrides,
  };
}

function mountPhone(overrides: Partial<PhoneLibraryChrome> = {}): PhoneLibraryChrome {
  const chrome = library(overrides);
  mount(createElement(AdaptiveNavigation, {
    screen: 'phone', photoCount: 4, drawerOpen: false, drawerSection: 'sources',
    sidebar: null, onOpenDrawer: vi.fn(), onCloseDrawer: vi.fn(), phoneLibrary: chrome,
  }));
  return chrome;
}

describe('phone selection metadata', () => {
  it('rates, flags and labels the selection from the star button in the selection bar', () => {
    const setters = metaSetters();
    mountPhone(setters);

    click('.adaptive-selection-rate-btn');
    expect(host!.querySelector('.phone-library-sheet .photo-meta-controls')).not.toBeNull();

    click('.photo-meta-controls [data-rating="3"]');
    click('.photo-meta-controls [data-flag="pick"]');
    click('.photo-meta-controls [data-label="red"]');
    expect(setters.onSetRating).toHaveBeenLastCalledWith(3);
    expect(setters.onSetFlag).toHaveBeenLastCalledWith('pick');
    expect(setters.onSetColorLabel).toHaveBeenLastCalledWith('red');

    // Each row also carries the way back, so the phone can undo what the
    // desktop shortcuts set.
    click('.photo-meta-controls [data-rating="0"]');
    click('.photo-meta-controls [data-flag="none"]');
    click('.photo-meta-controls [data-label="none"]');
    expect(setters.onSetRating).toHaveBeenLastCalledWith(0);
    expect(setters.onSetFlag).toHaveBeenLastCalledWith(null);
    expect(setters.onSetColorLabel).toHaveBeenLastCalledWith(null);
  });

  it('offers the same block in the selection actions sheet', () => {
    const setters = metaSetters();
    mountPhone(setters);

    click('.adaptive-topbar button[aria-label="common.more"]');
    expect(host!.querySelectorAll('.phone-library-sheet .photo-meta-controls')).toHaveLength(1);
    click('.photo-meta-controls [data-rating="5"]');
    expect(setters.onSetRating).toHaveBeenLastCalledWith(5);
  });

  it('keeps the block and the star button away when the setters are missing', () => {
    mountPhone();
    expect(host!.querySelector('.adaptive-selection-rate-btn')).toBeNull();
    click('.adaptive-topbar button[aria-label="common.more"]');
    expect(host!.querySelector('.photo-meta-controls')).toBeNull();
  });

  it('disables the block while nothing is selected', () => {
    mountPhone({ ...metaSetters(), selectedCount: 0 });
    click('.adaptive-topbar button[aria-label="common.more"]');
    const buttons = [...host!.querySelectorAll<HTMLButtonElement>('.photo-meta-controls button')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });
});

describe('phone adjust sheet', () => {
  it('switches RAW+JPEG pairing back off from the organize section', () => {
    const onPairRawJpegToggle = vi.fn();
    mountPhone({ multiSelect: false, pairRawJpeg: true, onPairRawJpegToggle });

    click('.adaptive-adjust-btn');
    const toggle = host!.querySelector<HTMLInputElement>('.phone-pair-raw-toggle')!;
    expect(toggle.checked).toBe(true);
    act(() => toggle.click());
    expect(onPairRawJpegToggle).toHaveBeenCalledTimes(1);
  });

  it('leaves the switch out when the shell does not offer pairing', () => {
    mountPhone({ multiSelect: false });
    click('.adaptive-adjust-btn');
    expect(host!.querySelector('.phone-pair-raw-toggle')).toBeNull();
  });
});

describe('desktop context menu row', () => {
  it('renders the block as a menu row and dismisses the menu after a value was set', () => {
    const setters = metaSetters();
    const onClose = vi.fn();
    mount(createElement(ContextMenu, {
      x: 10,
      y: 10,
      onClose,
      items: [
        { label: 'common.open', onClick: vi.fn() },
        {
          render: (close: () => void) => createElement(PhotoMetaControls, {
            count: 3, ...setters, onAfterApply: close,
          }),
        },
      ],
    }));

    expect(host!.querySelector('.context-menu-row .photo-meta-controls')).not.toBeNull();
    click('.context-menu-row [data-rating="4"]');
    expect(setters.onSetRating).toHaveBeenCalledWith(4);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
