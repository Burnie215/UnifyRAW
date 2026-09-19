import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../contexts/AdaptiveLayoutContext', () => ({
  useAdaptiveLayout: () => ({ screen: 'desktop' }),
}));
vi.mock('../hooks/useToolbarDensity', () => ({
  useToolbarDensity: () => ({ ref: { current: null }, level: 0 }),
}));
vi.mock('../brand', () => ({
  useBrand: () => ({ name: 'UnifyRAW' }),
}));

import { AdaptiveNavigation, type PhoneLibraryChrome } from './AdaptiveNavigation';
import { GridToolbar } from './GridToolbar';
import { KeywordsPanel } from './KeywordsPanel';

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

function changeSelect(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function callbacks() {
  return {
    onRatingFilterChange: vi.fn(),
    onFlagFilterChange: vi.fn(),
    onLabelFilterChange: vi.fn(),
    onAvailabilityFilterChange: vi.fn(),
    onKeywordFilterChange: vi.fn(),
    onCameraFilterChange: vi.fn(),
    onLensFilterChange: vi.fn(),
  };
}

function commonFilters() {
  return {
    ratingFilter: 3,
    flagFilter: 'pick',
    labelFilter: 'red',
    availabilityFilter: 'all' as const,
    keywordFilter: 'Animals|Dogs',
    cameraFilter: 'Fujifilm X-T5',
    lensFilter: 'XF 35mm',
    cameras: ['Fujifilm X-T5', 'Nikon Z8'],
    lenses: ['XF 35mm', 'Nikkor Z 50mm'],
  };
}

describe('library filter chrome', () => {
  it('clears active desktop values and resets keyword and metadata filters together', () => {
    const handlers = callbacks();
    mount(createElement(GridToolbar, {
      search: '', onSearchChange: vi.fn(), sort: 'name-asc', onSortChange: vi.fn(),
      gridMode: 'tiles', groupMode: 'none', onGroupModeChange: vi.fn(),
      multiSelect: false, onMultiSelectToggle: vi.fn(), pairRawJpeg: false,
      onPairRawJpegToggle: vi.fn(), selectedCount: 0, onRemoveSelected: vi.fn(),
      totalCount: 4, filteredCount: 1, ...commonFilters(), ...handlers,
    }));

    act(() => host!.querySelector<HTMLButtonElement>('.filter-toggle-btn')!.click());
    act(() => host!.querySelector<HTMLButtonElement>('.fb-star-btn.active')!.click());
    act(() => host!.querySelector<HTMLButtonElement>('.fb-flag-btn.fb-pick')!.click());
    act(() => host!.querySelector<HTMLButtonElement>('.fb-color-btn[title="red"]')!.click());
    expect(handlers.onRatingFilterChange).toHaveBeenLastCalledWith(0);
    expect(handlers.onFlagFilterChange).toHaveBeenLastCalledWith('all');
    expect(handlers.onLabelFilterChange).toHaveBeenLastCalledWith('all');

    expect(host!.querySelector('.fb-keyword-chip')?.textContent).toContain('Animals|Dogs');
    act(() => host!.querySelector<HTMLButtonElement>('.fb-keyword-chip')!.click());
    expect(handlers.onKeywordFilterChange).toHaveBeenLastCalledWith('');
    changeSelect(host!.querySelector<HTMLSelectElement>('select[aria-label="gridToolbar.fb.camera"]')!, 'Nikon Z8');
    changeSelect(host!.querySelector<HTMLSelectElement>('select[aria-label="gridToolbar.fb.lens"]')!, 'Nikkor Z 50mm');
    expect(handlers.onCameraFilterChange).toHaveBeenLastCalledWith('Nikon Z8');
    expect(handlers.onLensFilterChange).toHaveBeenLastCalledWith('Nikkor Z 50mm');

    act(() => host!.querySelector<HTMLButtonElement>('.fb-reset')!.click());
    expect(handlers.onKeywordFilterChange).toHaveBeenCalledWith('');
    expect(handlers.onCameraFilterChange).toHaveBeenCalledWith('all');
    expect(handlers.onLensFilterChange).toHaveBeenCalledWith('all');
  });

  it('uses the identical click-again semantics in the phone sheet', () => {
    const handlers = callbacks();
    const library: PhoneLibraryChrome = {
      title: 'All photos', totalCount: 4, filteredCount: 1,
      search: '', onSearchChange: vi.fn(), sort: 'name-asc', onSortChange: vi.fn(),
      gridMode: 'tiles', onGridModeChange: vi.fn(), groupMode: 'none', onGroupModeChange: vi.fn(),
      tileSize: 180, onTileSizeChange: vi.fn(), libraryViewMode: 'grid', onLibraryViewModeChange: vi.fn(),
      multiSelect: false, selectedCount: 0, onMultiSelectToggle: vi.fn(), onRemoveSelected: vi.fn(),
      ...commonFilters(), ...handlers,
    };
    mount(createElement(AdaptiveNavigation, {
      screen: 'phone', photoCount: 4, drawerOpen: false, drawerSection: 'sources',
      sidebar: null, onOpenDrawer: vi.fn(), onCloseDrawer: vi.fn(), phoneLibrary: library,
    }));

    act(() => host!.querySelector<HTMLButtonElement>('.adaptive-adjust-btn')!.click());
    act(() => host!.querySelector<HTMLButtonElement>('.phone-rating-buttons button.active')!.click());
    act(() => host!.querySelector<HTMLButtonElement>('.phone-flag-buttons button.active')!.click());
    act(() => host!.querySelector<HTMLButtonElement>('.phone-color-buttons button.active')!.click());
    expect(handlers.onRatingFilterChange).toHaveBeenLastCalledWith(0);
    expect(handlers.onFlagFilterChange).toHaveBeenLastCalledWith('all');
    expect(handlers.onLabelFilterChange).toHaveBeenLastCalledWith('all');

    expect(host!.querySelector('.phone-keyword-chip')?.textContent).toContain('Animals|Dogs');
    act(() => host!.querySelector<HTMLButtonElement>('.phone-keyword-chip')!.click());
    expect(handlers.onKeywordFilterChange).toHaveBeenLastCalledWith('');
    const cameraSelect = [...host!.querySelectorAll<HTMLSelectElement>('.phone-select-control select')]
      .find((select) => select.value === 'Fujifilm X-T5')!;
    const lensSelect = [...host!.querySelectorAll<HTMLSelectElement>('.phone-select-control select')]
      .find((select) => select.value === 'XF 35mm')!;
    changeSelect(cameraSelect, 'Nikon Z8');
    changeSelect(lensSelect, 'Nikkor Z 50mm');
    expect(handlers.onCameraFilterChange).toHaveBeenLastCalledWith('Nikon Z8');
    expect(handlers.onLensFilterChange).toHaveBeenLastCalledWith('Nikkor Z 50mm');

    act(() => host!.querySelector<HTMLButtonElement>('.phone-reset-filters')!.click());
    expect(handlers.onKeywordFilterChange).toHaveBeenCalledWith('');
    expect(handlers.onCameraFilterChange).toHaveBeenCalledWith('all');
    expect(handlers.onLensFilterChange).toHaveBeenCalledWith('all');
  });
});

describe('keyword filter tree', () => {
  it('marks the active node and makes native keyboard activation clear it', async () => {
    const onKeywordFilter = vi.fn();
    mount(createElement(KeywordsPanel, {
      selectedPhotos: [], onAddKeywords: vi.fn(), onRemoveKeyword: vi.fn(),
      allKeywords: [
        { keyword: 'Animals|Dogs', count: 2, photoIdentities: new Set(['photo:1', 'photo:2']) },
        { keyword: 'Landscape', count: 1, photoIdentities: new Set(['photo:3']) },
      ],
      activeKeyword: 'Animals', onKeywordFilter,
    }));

    const active = host!.querySelector<HTMLButtonElement>('.kw-tree-item.active .kw-tree-select')!;
    expect(active.getAttribute('aria-pressed')).toBe('true');
    active.focus();
    await act(async () => { await userEvent.keyboard('{Enter}'); });
    expect(onKeywordFilter).toHaveBeenCalledWith('');

    const landscape = [...host!.querySelectorAll<HTMLButtonElement>('.kw-tree-select')]
      .find((button) => button.textContent?.includes('Landscape'))!;
    act(() => landscape.click());
    expect(onKeywordFilter).toHaveBeenLastCalledWith('Landscape');
  });
});
