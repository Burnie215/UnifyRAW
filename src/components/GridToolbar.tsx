import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdaptiveLayout } from '../contexts/AdaptiveLayoutContext';
import { useToolbarDensity } from '../hooks/useToolbarDensity';
import type { SortOption, GridMode, GroupMode } from '../types';
import { GROUP_LABEL_KEYS, effectiveGroupMode, groupOptionsFor } from './photoGrid/groupOptions';
import { SORT_LABEL_KEYS, sortOptions } from './photoGrid/sortOptions';
import {
  FLAG_FILTER_VALUES,
  LABEL_FILTER_VALUES,
  RATING_FILTER_VALUES,
  filterResetActions,
  isFilterActive,
  toggleValue,
} from '../data/libraryFilters';
import './GridToolbar.css';

interface GridToolbarProps {
  search: string;
  onSearchChange: (s: string) => void;
  sort: SortOption;
  onSortChange: (s: SortOption) => void;
  gridMode: GridMode;
  groupMode: GroupMode;
  onGroupModeChange: (m: GroupMode) => void;
  multiSelect: boolean;
  onMultiSelectToggle: () => void;
  /** Group a RAW with its JPEG/HEIF sibling and show only the sibling. */
  pairRawJpeg: boolean;
  onPairRawJpegToggle: () => void;
  selectedCount: number;
  onRemoveSelected: () => void;
  totalCount: number;
  filteredCount: number;
  ratingFilter: number;
  onRatingFilterChange: (r: number) => void;
  flagFilter: string;
  onFlagFilterChange: (f: string) => void;
  labelFilter: string;
  onLabelFilterChange: (l: string) => void;
  availabilityFilter: 'online' | 'unavailable' | 'all';
  onAvailabilityFilterChange: (value: 'online' | 'unavailable' | 'all') => void;
  keywordFilter: string;
  onKeywordFilterChange: (value: string) => void;
  onExport?: () => void;
  /** Before/After thumbnail toggle */
  showOriginals?: boolean;
  onToggleOriginals?: () => void;
  /** Sync current adjustments to selected photos */
  onSyncAdjustments?: () => void;
  onPrint?: () => void;
  onSlideshow?: () => void;
  // Metadata filters
  cameraFilter: string;
  onCameraFilterChange: (c: string) => void;
  lensFilter: string;
  onLensFilterChange: (l: string) => void;
  cameras?: string[];
  lenses?: string[];
}

/**
 * Density level at which the low-priority controls leave the bar for the
 * overflow menu. Levels 1 and 2 only shrink and drop labels (see GridToolbar.css).
 */
const OVERFLOW_LEVEL = 3;

export function GridToolbar({
  search, onSearchChange, sort, onSortChange,
  gridMode, groupMode, onGroupModeChange,
  ratingFilter, onRatingFilterChange, flagFilter, onFlagFilterChange, labelFilter, onLabelFilterChange,
  availabilityFilter, onAvailabilityFilterChange,
  keywordFilter, onKeywordFilterChange,
  multiSelect, onMultiSelectToggle, pairRawJpeg, onPairRawJpegToggle, selectedCount, onRemoveSelected,
  totalCount, filteredCount, onExport, showOriginals, onToggleOriginals, onSyncAdjustments, onPrint, onSlideshow,
  cameraFilter, onCameraFilterChange, cameras,
  lensFilter, onLensFilterChange, lenses,
}: GridToolbarProps) {
  const { t } = useTranslation();
  const { screen } = useAdaptiveLayout();
  const [filterBarOpen, setFilterBarOpen] = useState(false);
  // Tablet chrome already stacks the bar into two scrollable rows, so only the
  // single-row desktop bar can run out of width.
  const { ref: toolbarRef, level } = useToolbarDensity<HTMLDivElement>(
    screen === 'desktop' ? OVERFLOW_LEVEL : 0,
  );
  const collapsed = level >= OVERFLOW_LEVEL;
  const filtersActive = isFilterActive({
    ratingFilter, flagFilter, labelFilter, availabilityFilter,
    cameraFilter, lensFilter, keywordFilter,
  });
  const resetFilters = filterResetActions({
    onRatingFilterChange, onFlagFilterChange, onLabelFilterChange,
    onAvailabilityFilterChange, onCameraFilterChange, onLensFilterChange,
    onKeywordFilterChange,
  });

  // On phones these controls live in AdaptiveNavigation's temporary sheet.
  // Returning no chrome here lets the grid begin directly below the only bar.
  if (screen === 'phone') return null;

  const hasSelection = multiSelect && selectedCount > 0;

  const sortControl = (
    <label className="toolbar-sort-control" title={t('toolbar.sort')}>
      <SortIcon />
      <span className="toolbar-label">{t('toolbar.sort')}</span>
      <select
        value={sort}
        onChange={(event) => onSortChange(event.target.value as SortOption)}
        aria-label={t('toolbar.sort')}
      >
        {sortOptions().map((value) => (
          <option key={value} value={value}>{t(`gridToolbar.sort.${SORT_LABEL_KEYS[value]}`)}</option>
        ))}
      </select>
    </label>
  );

  const groupOptions = groupOptionsFor(gridMode);
  const groupControl = groupOptions.length < 2 ? null : (
    <select
      className="sort-select"
      value={effectiveGroupMode(gridMode, groupMode)}
      onChange={(e) => onGroupModeChange(e.target.value as GroupMode)}
      aria-label={t('gridToolbar.groupLabel')}
    >
      {groupOptions.map((mode) => (
        <option key={mode} value={mode}>{t(`gridToolbar.groups.${GROUP_LABEL_KEYS[mode]}`)}</option>
      ))}
    </select>
  );

  const pairRawControl = (
    <button
      className={`toolbar-btn ${pairRawJpeg ? 'active' : ''}`}
      onClick={onPairRawJpegToggle}
      title={t('gridToolbar.pairRawJpegHint')}
      aria-pressed={pairRawJpeg}
    >
      <PairRawIcon />
      <span className="toolbar-label">{t('gridToolbar.pairRawJpeg')}</span>
    </button>
  );

  const multiSelectControl = (
    <button
      className={`toolbar-btn ${multiSelect ? 'active' : ''}`}
      onClick={onMultiSelectToggle}
      title={t('gridToolbar.multiSelect')}
    >
      <MultiSelectIcon />
      <span className="toolbar-label-menu">{t('gridToolbar.multiSelect')}</span>
    </button>
  );

  // Kept in the bar as long as anything is selected: acting on a selection is
  // why the bar was opened in the first place.
  const selectionPrimary = hasSelection && (
    <>
      <button className="toolbar-btn danger" onClick={onRemoveSelected} title={t('gridToolbar.removeSelectedTooltip', { count: selectedCount })}>
        <TrashIcon />
        <span className="toolbar-label">{t('gridToolbar.removeSelected', { count: selectedCount })}</span>
      </button>
      {onExport && (
        <button className="toolbar-btn" onClick={onExport} title={t('gridToolbar.exportSelected')}>
          <ExportIcon />
          <span className="toolbar-label">{t('common.export')}</span>
        </button>
      )}
    </>
  );

  const selectionExtras = hasSelection && (
    <>
      {onToggleOriginals && (
        <button className={`toolbar-btn ${showOriginals ? 'active' : ''}`} onClick={onToggleOriginals}
          title={showOriginals ? t('gridToolbar.showEditedPreview') : t('gridToolbar.showOriginal')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="1" y="1" width="4" height="10" rx="1" /><rect x="7" y="1" width="4" height="10" rx="1" />
          </svg>
          <span className="toolbar-label">{showOriginals ? t('gridToolbar.original') : t('gridToolbar.beforeAfter')}</span>
        </button>
      )}
      {onSyncAdjustments && (
        <button className="toolbar-btn" onClick={onSyncAdjustments} title={t('gridToolbar.syncAdjustmentsTooltip')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M1 6h10M8 3l3 3-3 3" />
          </svg>
          <span className="toolbar-label">{t('gridToolbar.syncAdjustments')}</span>
        </button>
      )}
      {onPrint && (
        <button className="toolbar-btn" onClick={onPrint} title={t('gridToolbar.print')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="2" y="5" width="8" height="5" rx="1" /><path d="M3 5V2h6v3" /><path d="M4 8h4" />
          </svg>
          <span className="toolbar-label">{t('gridToolbar.print')}</span>
        </button>
      )}
      {onSlideshow && (
        <button className="toolbar-btn" onClick={onSlideshow} title={t('gridToolbar.startSlideshow')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
            <polygon points="3,1 10,6 3,11" fill="currentColor" stroke="none" />
          </svg>
          <span className="toolbar-label">{t('gridToolbar.slideshow')}</span>
        </button>
      )}
    </>
  );

  return (
    <div className="grid-toolbar-wrapper">
      <div className="grid-toolbar" ref={toolbarRef} data-density={level}>
        <div className="toolbar-left">
          <div className="search-box">
            <SearchIcon />
            <input
              type="text"
              placeholder={t('gridToolbar.searchPlaceholder')}
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
            />
            {search && (
              <button className="search-clear" onClick={() => onSearchChange('')} title={t('gridToolbar.clearSearch')}>
                <XIcon />
              </button>
            )}
          </div>
          {filteredCount !== totalCount && (
            <span className="filter-count">{t('gridToolbar.filteredCount', { filtered: filteredCount, total: totalCount })}</span>
          )}

          <button
            className={`toolbar-btn filter-toggle-btn ${filterBarOpen || filtersActive ? 'active' : ''}`}
            onClick={() => setFilterBarOpen(!filterBarOpen)}
            title={t('gridToolbar.showFilters')}
          >
            <FilterIcon />
            <span className="toolbar-label">{t('gridToolbar.filter')}</span>
            {filtersActive && <span className="filter-dot" />}
          </button>

          {!collapsed && sortControl}
        </div>

        <div className="toolbar-right">
          {selectionPrimary}
          {!collapsed && selectionExtras}
          {!collapsed && pairRawControl}
          {!collapsed && multiSelectControl}
          {!collapsed && groupControl}

          {collapsed && (
            <OverflowMenu label={t('gridToolbar.more')}>
              {sortControl}
              {groupControl}
              {pairRawControl}
              {multiSelectControl}
              {selectionExtras}
            </OverflowMenu>
          )}
        </div>
      </div>

      {/* Filter Bar — Lightroom-style attribute filters */}
      {filterBarOpen && (
        <div className="filter-bar">
          {/* Rating */}
          <div className="fb-group">
            <span className="fb-label">{t('gridToolbar.fb.rating')}</span>
            <div className="fb-stars">
              {RATING_FILTER_VALUES.map((r) => (
                <button
                  key={r}
                  className={`fb-star-btn ${ratingFilter === r ? 'active' : ''}`}
                  onClick={() => onRatingFilterChange(toggleValue(ratingFilter, r, 0))}
                  aria-pressed={ratingFilter === r}
                  title={r === 0 ? t('gridToolbar.fb.allRatings') : t('gridToolbar.fb.starsPlus', { count: r })}
                >
                  {r === 0 ? t('gridToolbar.fb.allRatings') : '★'.repeat(r)}
                </button>
              ))}
            </div>
          </div>

          <div className="fb-sep" />

          {/* Flags */}
          <div className="fb-group">
            <span className="fb-label">{t('gridToolbar.fb.flag')}</span>
            <div className="fb-flags">
              {FLAG_FILTER_VALUES.map((flag) => (
                <button key={flag}
                  className={`fb-flag-btn ${flag === 'pick' ? 'fb-pick' : flag === 'reject' ? 'fb-reject' : ''} ${flagFilter === flag ? 'active' : ''}`}
                  onClick={() => onFlagFilterChange(toggleValue(flagFilter, flag, 'all'))}
                  aria-pressed={flagFilter === flag} title={t(`gridToolbar.fb.${flag === 'all' ? 'allFlags' : flag}`)}>
                  {flag === 'pick' ? <FlagPickIcon /> : flag === 'reject' ? <FlagRejectIcon /> : flag === 'unflagged' ? '—' : t('gridToolbar.fb.allFlags')}
                </button>
              ))}
            </div>
          </div>

          <div className="fb-sep" />

          <div className="fb-group">
            <span className="fb-label">{t('gridToolbar.fb.availability')}</span>
            <select
              className="fb-select"
              value={availabilityFilter}
              onChange={(event) => onAvailabilityFilterChange(
                event.target.value as 'online' | 'unavailable' | 'all',
              )}
            >
              <option value="online">{t('gridToolbar.fb.available')}</option>
              <option value="unavailable">{t('gridToolbar.fb.unavailable')}</option>
              <option value="all">{t('gridToolbar.fb.allAvailability')}</option>
            </select>
          </div>

          <div className="fb-sep" />

          {/* Color Labels */}
          <div className="fb-group">
            <span className="fb-label">{t('gridToolbar.fb.color')}</span>
            <div className="fb-colors">
              {LABEL_FILTER_VALUES.map((c) => (
                <button key={c}
                  className={`fb-color-btn ${labelFilter === c ? 'active' : ''}`}
                  onClick={() => onLabelFilterChange(toggleValue(labelFilter, c, 'all'))}
                  aria-pressed={labelFilter === c}
                  title={c === 'all' ? t('gridToolbar.fb.allColors') : c}
                >
                  <span className="fb-color-dot" style={{ background: c === 'all' ? 'var(--text-secondary)' : `var(--label-${c})` }} />
                </button>
              ))}
            </div>
          </div>

          {/* Metadata filters (camera/lens) */}
          {cameras && cameras.length > 0 && (
            <>
              <div className="fb-sep" />
              <div className="fb-group">
                <span className="fb-label">{t('gridToolbar.fb.camera')}</span>
                <select className="fb-select" value={cameraFilter}
                  aria-label={t('gridToolbar.fb.camera')}
                  onChange={(e) => onCameraFilterChange(e.target.value)}>
                  <option value="all">{t('gridToolbar.fb.all')}</option>
                  {cameras.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </>
          )}
          {lenses && lenses.length > 0 && (
            <div className="fb-group">
              <span className="fb-label">{t('gridToolbar.fb.lens')}</span>
              <select className="fb-select" value={lensFilter}
                aria-label={t('gridToolbar.fb.lens')}
                onChange={(e) => onLensFilterChange(e.target.value)}>
                <option value="all">{t('gridToolbar.fb.all')}</option>
                {lenses.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            </div>
          )}

          {keywordFilter && (
            <>
              <div className="fb-sep" />
              <div className="fb-group">
                <span className="fb-label">{t('gridToolbar.fb.keyword')}</span>
                <button
                  className="fb-keyword-chip"
                  onClick={() => onKeywordFilterChange('')}
                  aria-label={t('gridToolbar.fb.clearKeyword', { keyword: keywordFilter })}
                >
                  <span>{keywordFilter}</span><span aria-hidden="true">×</span>
                </button>
              </div>
            </>
          )}

          {/* Reset all filters */}
          {filtersActive && (
            <button className="fb-reset" onClick={resetFilters} title={t('gridToolbar.fb.resetAll')}>
              {t('gridToolbar.fb.reset')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6" cy="6" r="4.5" />
      <path d="M9.5 9.5L13 13" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 2l6 6M8 2L2 8" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2 3h8M4.5 3V2h3v1M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" />
    </svg>
  );
}

function MultiSelectIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1" y="1" width="5" height="5" rx="1" />
      <rect x="8" y="1" width="5" height="5" rx="1" />
      <rect x="1" y="8" width="5" height="5" rx="1" />
      <path d="M9.5 10l1 1 2.5-3" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M6 1v7M3 4l3-3 3 3" /><path d="M1 9v1h10V9" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 2h10M3 6h6M5 10h2" />
    </svg>
  );
}

function SortIcon() {
  return <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2 3h7M2 7h5M2 11h3M10 6v6M8 10l2 2 2-2" /></svg>;
}

function FlagPickIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2 1v10M2 1l7 3.5L2 8" />
    </svg>
  );
}

function FlagRejectIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 3l6 6M9 3L3 9" />
    </svg>
  );
}

/**
 * Holds the controls that no longer fit in the bar. Closes on Escape and on any
 * pointer press outside, so it never covers the grid longer than needed.
 */
function OverflowMenu({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="toolbar-overflow" ref={ref}>
      <button
        className={`toolbar-btn ${open ? 'active' : ''}`}
        onClick={() => setOpen(!open)}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreIcon />
      </button>
      {open && (
        <div className="toolbar-overflow-menu" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

function PairRawIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="1" y="3" width="8" height="8" rx="1.5" />
      <path d="M5 3V1.5h7.5V9H11" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <circle cx="3" cy="7" r="1.3" />
      <circle cx="7" cy="7" r="1.3" />
      <circle cx="11" cy="7" r="1.3" />
    </svg>
  );
}
