import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useBrand } from '../brand';
import { AlphaBadge } from './AlphaBadge';
import { PhotoMetaControls, type PhotoMetaHandlers } from './PhotoMetaControls';
import type { GridMode, GroupMode, LibraryViewMode, SortOption } from '../types';
import type { ScreenClass } from '../platform/adaptiveLayout';
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
import './AdaptiveNavigation.css';

export type NavigationSection = 'sources' | 'collections';

export interface PhoneLibraryChrome {
  title: string;
  totalCount: number;
  filteredCount: number;
  search: string;
  onSearchChange: (value: string) => void;
  sort: SortOption;
  onSortChange: (value: SortOption) => void;
  gridMode: GridMode;
  onGridModeChange: (value: GridMode) => void;
  groupMode: GroupMode;
  onGroupModeChange: (value: GroupMode) => void;
  tileSize: number;
  onTileSizeChange: (value: number) => void;
  libraryViewMode: LibraryViewMode;
  onLibraryViewModeChange: (value: LibraryViewMode) => void;
  multiSelect: boolean;
  selectedCount: number;
  onMultiSelectToggle: () => void;
  onExport?: () => void;
  onRemoveSelected: () => void;
  showOriginals?: boolean;
  onToggleOriginals?: () => void;
  onSyncAdjustments?: () => void;
  onPrint?: () => void;
  onSlideshow?: () => void;
  /**
   * Rating, flag and colour label for the current selection. Present together
   * or not at all; the selection surfaces show the block only when they are.
   */
  onSetRating?: PhotoMetaHandlers['onSetRating'];
  onSetFlag?: PhotoMetaHandlers['onSetFlag'];
  onSetColorLabel?: PhotoMetaHandlers['onSetColorLabel'];
  pairRawJpeg?: boolean;
  onPairRawJpegToggle?: () => void;
  ratingFilter: number;
  onRatingFilterChange: (value: number) => void;
  flagFilter: string;
  onFlagFilterChange: (value: string) => void;
  labelFilter: string;
  onLabelFilterChange: (value: string) => void;
  availabilityFilter: 'online' | 'unavailable' | 'all';
  onAvailabilityFilterChange: (value: 'online' | 'unavailable' | 'all') => void;
  keywordFilter: string;
  onKeywordFilterChange: (value: string) => void;
  cameraFilter: string;
  onCameraFilterChange: (value: string) => void;
  cameras?: string[];
  lensFilter: string;
  onLensFilterChange: (value: string) => void;
  lenses?: string[];
}

interface AdaptiveNavigationProps {
  screen: Exclude<ScreenClass, 'desktop'>;
  photoCount: number;
  drawerOpen: boolean;
  drawerSection: NavigationSection;
  sidebar: ReactNode;
  onOpenDrawer: (section: NavigationSection) => void;
  onCloseDrawer: () => void;
  phoneLibrary?: PhoneLibraryChrome;
  phoneChromeHidden?: boolean;
}

type PhoneSurface = 'adjust' | 'overflow' | 'selection-more' | 'selection-rate' | null;

/** The three setters travel together; one missing means the surface stays off. */
function metaHandlers(library: PhoneLibraryChrome): PhotoMetaHandlers | null {
  const { onSetRating, onSetFlag, onSetColorLabel } = library;
  if (!onSetRating || !onSetFlag || !onSetColorLabel) return null;
  return { onSetRating, onSetFlag, onSetColorLabel };
}

const GRID_MODES: GridMode[] = ['tiles', 'list', 'gallery', 'timeline'];
const LIBRARY_VIEW_MODES: LibraryViewMode[] = ['grid', 'loupe', 'compare', 'survey'];

export function AdaptiveNavigation({
  screen,
  photoCount,
  drawerOpen,
  drawerSection,
  sidebar,
  onOpenDrawer,
  onCloseDrawer,
  phoneLibrary,
  phoneChromeHidden = false,
}: AdaptiveNavigationProps) {
  const { t } = useTranslation();
  const brand = useBrand();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const selectionCloseButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [phoneSurface, setPhoneSurface] = useState<PhoneSurface>(null);
  const restoreSearchButtonFocus = useCallback(() => {
    searchButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    const returnFocusTo = drawerReturnFocusRef.current ?? menuButtonRef.current;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseDrawer();
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      trapFocus(event, drawerRef.current);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      drawerReturnFocusRef.current = null;
      window.requestAnimationFrame(() => returnFocusTo?.focus());
    };
  }, [drawerOpen, onCloseDrawer]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setSearchOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      window.requestAnimationFrame(restoreSearchButtonFocus);
    };
  }, [restoreSearchButtonFocus, searchOpen]);

  useEffect(() => {
    if (!phoneSurface) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      // data-autofocus wins over document order: the sheet's own first
      // control may be a rating strip the sheet does not want focused.
      const sheet = sheetRef.current;
      (sheet?.querySelector<HTMLElement>('[data-autofocus]')
        ?? sheet?.querySelector<HTMLElement>('button, input, select'))?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPhoneSurface(null);
        return;
      }
      if (event.key === 'Tab' && sheetRef.current) trapFocus(event, sheetRef.current);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [phoneSurface]);

  useEffect(() => {
    if (screen !== 'phone' || !phoneLibrary) {
      setSearchOpen(false);
      setPhoneSurface(null);
    }
  }, [screen, phoneLibrary]);

  useEffect(() => {
    if (!phoneLibrary?.multiSelect) return;
    const frame = window.requestAnimationFrame(() => selectionCloseButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [phoneLibrary?.multiSelect]);

  const filtersActive = !!phoneLibrary && isFilterActive(phoneLibrary);
  const keepPhoneChromeVisible = searchOpen || !!phoneSurface || !!phoneLibrary?.multiSelect || drawerOpen;

  return (
    <>
      <header className={`adaptive-topbar ${screen === 'phone' ? 'adaptive-topbar-phone' : ''} ${phoneChromeHidden && !keepPhoneChromeVisible ? 'adaptive-topbar-hidden' : ''}`}>
        {screen === 'phone' && phoneLibrary ? (
          searchOpen ? (
            <PhoneSearchBar
              inputRef={searchInputRef}
              value={phoneLibrary.search}
              onChange={phoneLibrary.onSearchChange}
              onClose={() => setSearchOpen(false)}
              t={t}
            />
          ) : phoneLibrary.multiSelect ? (
            <PhoneSelectionBar
              closeButtonRef={selectionCloseButtonRef}
              selectedCount={phoneLibrary.selectedCount}
              onClose={phoneLibrary.onMultiSelectToggle}
              onExport={phoneLibrary.onExport}
              onRate={metaHandlers(phoneLibrary) ? () => setPhoneSurface('selection-rate') : undefined}
              onMore={() => setPhoneSurface('selection-more')}
              t={t}
            />
          ) : (
            <>
              <button
                ref={menuButtonRef}
                className="adaptive-menu-btn"
                onClick={(event) => {
                  drawerReturnFocusRef.current = event.currentTarget;
                  if (drawerOpen) onCloseDrawer(); else onOpenDrawer('sources');
                }}
                aria-label={t('sidebar.library')}
                aria-expanded={drawerOpen}
                aria-haspopup="dialog"
                aria-controls="adaptive-navigation-drawer"
              >
                <MenuIcon />
              </button>
              <button
                className="adaptive-context-button"
                onClick={(event) => {
                  drawerReturnFocusRef.current = event.currentTarget;
                  onOpenDrawer('sources');
                }}
                aria-haspopup="dialog"
                aria-controls="adaptive-navigation-drawer"
                aria-expanded={drawerOpen}
              >
                <span className="adaptive-topbar-title">{phoneLibrary.title}</span>
                <span className="adaptive-context-count">
                  {phoneLibrary.filteredCount !== phoneLibrary.totalCount
                    ? t('gridToolbar.filteredCount', { filtered: phoneLibrary.filteredCount, total: phoneLibrary.totalCount })
                    : t('uiShell.viewMode.countPhotos', { count: phoneLibrary.totalCount })}
                </span>
              </button>
              <button ref={searchButtonRef} className="adaptive-action-btn" onClick={() => setSearchOpen(true)} aria-label={t('common.search')}>
                <SearchIcon />
              </button>
              <button
                className={`adaptive-action-btn adaptive-adjust-btn ${filtersActive ? 'active' : ''}`}
                onClick={() => setPhoneSurface('adjust')}
                aria-label={t('uiShell.phoneLibrary.adjust')}
                aria-haspopup="dialog"
                aria-controls="phone-library-sheet"
                aria-expanded={phoneSurface === 'adjust'}
              >
                <AdjustIcon />
                {filtersActive && <span className="adaptive-active-dot" />}
              </button>
              <button
                className="adaptive-action-btn"
                onClick={() => setPhoneSurface('overflow')}
                aria-label={t('common.more')}
                aria-haspopup="dialog"
                aria-controls="phone-library-sheet"
                aria-expanded={phoneSurface === 'overflow'}
              >
                <MoreIcon />
              </button>
            </>
          )
        ) : (
          <>
            <button
              ref={menuButtonRef}
              className="adaptive-menu-btn"
              onClick={(event) => {
                drawerReturnFocusRef.current = event.currentTarget;
                if (drawerOpen) onCloseDrawer(); else onOpenDrawer('sources');
              }}
              aria-label={t('sidebar.library')}
              aria-expanded={drawerOpen}
              aria-haspopup="dialog"
              aria-controls="adaptive-navigation-drawer"
            >
              <MenuIcon />
            </button>
            <span className="adaptive-topbar-brand">
              <span className="adaptive-topbar-title">{brand.name}</span>
              <AlphaBadge />
            </span>
            <span className="adaptive-topbar-count">{photoCount}</span>
          </>
        )}
      </header>

      {drawerOpen && (
        <div className="adaptive-drawer-layer" role="presentation">
          <button className="adaptive-drawer-backdrop" onClick={onCloseDrawer} aria-label={t('common.close')} />
          <div
            ref={drawerRef}
            id="adaptive-navigation-drawer"
            className={`adaptive-navigation-drawer adaptive-navigation-drawer-${screen}`}
            role="dialog"
            aria-modal="true"
            aria-label={drawerSection === 'sources' ? t('sidebar.sources') : t('sidebar.collectionsTitle')}
          >
            <button ref={closeButtonRef} className="adaptive-drawer-close" onClick={onCloseDrawer} aria-label={t('common.close')}>
              <CloseIcon />
            </button>
            {sidebar}
          </div>
        </div>
      )}

      {screen === 'phone' && phoneLibrary && phoneSurface && (
        <div className="phone-library-sheet-layer" role="presentation">
          <button className="phone-library-sheet-backdrop" onClick={() => setPhoneSurface(null)} aria-label={t('common.close')} />
          <section
            ref={sheetRef}
            id="phone-library-sheet"
            className="phone-library-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="phone-library-sheet-title"
          >
            <div className="phone-library-sheet-handle" aria-hidden="true" />
            {phoneSurface === 'adjust' ? (
              <PhoneAdjustSheet library={phoneLibrary} filtersActive={filtersActive} onClose={() => setPhoneSurface(null)} t={t} />
            ) : phoneSurface === 'selection-rate' ? (
              <PhoneRateSheet library={phoneLibrary} onClose={() => setPhoneSurface(null)} t={t} />
            ) : (
              <PhoneActionsSheet
                library={phoneLibrary}
                selection={phoneSurface === 'selection-more'}
                onClose={() => setPhoneSurface(null)}
                t={t}
              />
            )}
          </section>
        </div>
      )}
    </>
  );
}

function PhoneSearchBar({ inputRef, value, onChange, onClose, t }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className="adaptive-search-mode">
      <button className="adaptive-action-btn" onClick={onClose} aria-label={t('common.back')}><BackIcon /></button>
      <SearchIcon />
      <input
        ref={inputRef}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('gridToolbar.searchPlaceholder')}
        aria-label={t('common.search')}
      />
      {value && <button className="adaptive-action-btn" onClick={() => onChange('')} aria-label={t('gridToolbar.clearSearch')}><CloseIcon /></button>}
    </div>
  );
}

function PhoneSelectionBar({ closeButtonRef, selectedCount, onClose, onExport, onRate, onMore, t }: {
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
  selectedCount: number;
  onClose: () => void;
  onExport?: () => void;
  onRate?: () => void;
  onMore: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <>
      <button ref={closeButtonRef} className="adaptive-action-btn" onClick={onClose} aria-label={t('common.close')}><CloseIcon /></button>
      <strong className="adaptive-selection-count">{t('uiShell.phoneLibrary.selectedCount', { count: selectedCount })}</strong>
      {onRate && (
        <button
          className="adaptive-action-btn adaptive-selection-rate-btn"
          onClick={onRate}
          disabled={selectedCount === 0}
          aria-label={t('uiShell.phoneLibrary.rateSelection')}
          aria-haspopup="dialog"
          aria-controls="phone-library-sheet"
        ><StarIcon /></button>
      )}
      {onExport && (
        <button className="adaptive-action-btn" onClick={onExport} disabled={selectedCount === 0} aria-label={t('common.export')}><ExportIcon /></button>
      )}
      <button
        className="adaptive-action-btn"
        onClick={onMore}
        aria-label={t('common.more')}
        aria-haspopup="dialog"
        aria-controls="phone-library-sheet"
      ><MoreIcon /></button>
    </>
  );
}

function PhoneAdjustSheet({ library, filtersActive, onClose, t }: {
  library: PhoneLibraryChrome;
  filtersActive: boolean;
  onClose: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const resetFilters = filterResetActions(library);
  return (
    <>
      <SheetHeader title={t('uiShell.phoneLibrary.adjust')} onClose={onClose} t={t} />
      <div className="phone-library-sheet-content">
        <ControlSection label={t('uiShell.phoneLibrary.libraryView')}>
          <div className="phone-choice-grid" role="group" aria-label={t('uiShell.phoneLibrary.libraryView')}>
            {LIBRARY_VIEW_MODES.map((mode) => (
              <button key={mode} className={library.libraryViewMode === mode ? 'active' : ''} onClick={() => library.onLibraryViewModeChange(mode)} aria-pressed={library.libraryViewMode === mode}>
                <LibraryModeIcon mode={mode} />
                <span>{t(`uiShell.viewMode.${mode}`)}</span>
              </button>
            ))}
          </div>
        </ControlSection>

        <ControlSection label={t('uiShell.phoneLibrary.layout')}>
          <div className="phone-choice-grid" role="group" aria-label={t('uiShell.phoneLibrary.layout')}>
            {GRID_MODES.map((mode) => (
              <button key={mode} className={library.gridMode === mode ? 'active' : ''} onClick={() => library.onGridModeChange(mode)} aria-pressed={library.gridMode === mode}>
                <GridModeIcon mode={mode} />
                <span>{t(`gridToolbar.viewModes.${mode}`)}</span>
              </button>
            ))}
          </div>
          {library.gridMode !== 'list' && (
            <label className="phone-range-control">
              <span>{t('gridToolbar.sizeTitle')}</span>
              <input type="range" min={80} max={400} value={library.tileSize} onChange={(event) => library.onTileSizeChange(Number(event.target.value))} />
            </label>
          )}
        </ControlSection>

        <ControlSection label={t('uiShell.phoneLibrary.organize')}>
          <label className="phone-select-control">
            <span>{t('uiShell.phoneLibrary.sort')}</span>
            <select value={library.sort} onChange={(event) => library.onSortChange(event.target.value as SortOption)}>
              {sortOptions().map((value) => (
                <option key={value} value={value}>{t(`gridToolbar.sort.${SORT_LABEL_KEYS[value]}`)}</option>
              ))}
            </select>
          </label>
          {groupOptionsFor(library.gridMode).length > 1 && (
            <label className="phone-select-control">
              <span>{t('uiShell.phoneLibrary.group')}</span>
              <select value={effectiveGroupMode(library.gridMode, library.groupMode)} onChange={(event) => library.onGroupModeChange(event.target.value as GroupMode)}>
                {groupOptionsFor(library.gridMode).map((mode) => (
                  <option key={mode} value={mode}>{t(`gridToolbar.groups.${GROUP_LABEL_KEYS[mode]}`)}</option>
                ))}
              </select>
            </label>
          )}
          {library.onPairRawJpegToggle && (
            <label className="phone-switch-control">
              <span>{t('gridToolbar.pairRawJpeg')}</span>
              <input
                type="checkbox"
                className="phone-pair-raw-toggle"
                checked={!!library.pairRawJpeg}
                onChange={library.onPairRawJpegToggle}
                aria-label={t('gridToolbar.pairRawJpegHint')}
              />
            </label>
          )}
        </ControlSection>

        <ControlSection label={t('gridToolbar.filter')}>
          <div className="phone-filter-row">
            <span>{t('gridToolbar.fb.rating')}</span>
            <div className="phone-rating-buttons" role="group" aria-label={t('gridToolbar.fb.rating')}>
              {RATING_FILTER_VALUES.map((rating) => (
                <button key={rating} className={library.ratingFilter === rating ? 'active' : ''}
                  onClick={() => library.onRatingFilterChange(toggleValue(library.ratingFilter, rating, 0))}
                  aria-pressed={library.ratingFilter === rating}
                  aria-label={rating === 0 ? t('gridToolbar.fb.allRatings') : t('gridToolbar.fb.starsPlus', { count: rating })}>
                  {rating === 0 ? t('common.all') : rating}
                  {rating > 0 && <span aria-hidden="true">★</span>}
                </button>
              ))}
            </div>
          </div>
          <div className="phone-filter-row">
            <span>{t('gridToolbar.fb.flag')}</span>
            <div className="phone-flag-buttons" role="group" aria-label={t('gridToolbar.fb.flag')}>
              {FLAG_FILTER_VALUES.map((flag) => (
                <button key={flag} className={library.flagFilter === flag ? 'active' : ''}
                  onClick={() => library.onFlagFilterChange(toggleValue(library.flagFilter, flag, 'all'))}
                  aria-pressed={library.flagFilter === flag}>
                  {t(`gridToolbar.fb.${flag === 'all' ? 'allFlags' : flag}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="phone-filter-row">
            <span>{t('gridToolbar.fb.color')}</span>
            <div className="phone-color-buttons" role="group" aria-label={t('gridToolbar.fb.color')}>
              {LABEL_FILTER_VALUES.map((color) => (
                <button key={color} className={library.labelFilter === color ? 'active' : ''}
                  onClick={() => library.onLabelFilterChange(toggleValue(library.labelFilter, color, 'all'))}
                  aria-pressed={library.labelFilter === color}
                  aria-label={color === 'all' ? t('gridToolbar.fb.allColors') : t(`uiShell.colorPanels.${color}`)}>
                  {color === 'all' ? t('common.all') : <span className="phone-color-dot" style={{ background: `var(--label-${color})` }} />}
                </button>
              ))}
            </div>
          </div>
          <label className="phone-select-control">
            <span>{t('gridToolbar.fb.availability')}</span>
            <select value={library.availabilityFilter} onChange={(event) => library.onAvailabilityFilterChange(event.target.value as 'online' | 'unavailable' | 'all')}>
              <option value="online">{t('gridToolbar.fb.available')}</option>
              <option value="unavailable">{t('gridToolbar.fb.unavailable')}</option>
              <option value="all">{t('gridToolbar.fb.allAvailability')}</option>
            </select>
          </label>
          {!!library.cameras?.length && (
            <label className="phone-select-control">
              <span>{t('gridToolbar.fb.camera')}</span>
              <select value={library.cameraFilter} onChange={(event) => library.onCameraFilterChange(event.target.value)}>
                <option value="all">{t('gridToolbar.fb.all')}</option>
                {library.cameras.map((camera) => <option key={camera} value={camera}>{camera}</option>)}
              </select>
            </label>
          )}
          {!!library.lenses?.length && (
            <label className="phone-select-control">
              <span>{t('gridToolbar.fb.lens')}</span>
              <select value={library.lensFilter} onChange={(event) => library.onLensFilterChange(event.target.value)}>
                <option value="all">{t('gridToolbar.fb.all')}</option>
                {library.lenses.map((lens) => <option key={lens} value={lens}>{lens}</option>)}
              </select>
            </label>
          )}
          {library.keywordFilter && (
            <div className="phone-filter-row">
              <span>{t('gridToolbar.fb.keyword')}</span>
              <button className="phone-keyword-chip" onClick={() => library.onKeywordFilterChange('')}
                aria-label={t('gridToolbar.fb.clearKeyword', { keyword: library.keywordFilter })}>
                <span>{library.keywordFilter}</span><span aria-hidden="true">×</span>
              </button>
            </div>
          )}
          {filtersActive && (
            <button className="phone-reset-filters" onClick={resetFilters}>{t('gridToolbar.fb.reset')}</button>
          )}
        </ControlSection>
      </div>
    </>
  );
}

function PhoneRateSheet({ library, onClose, t }: {
  library: PhoneLibraryChrome;
  onClose: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const handlers = metaHandlers(library);
  return (
    <>
      <SheetHeader title={t('uiShell.phoneLibrary.rateSelection')} onClose={onClose} t={t} />
      <div className="phone-library-sheet-content">
        {handlers && <PhotoMetaControls count={library.selectedCount} {...handlers} />}
      </div>
    </>
  );
}

function PhoneActionsSheet({ library, selection, onClose, t }: {
  library: PhoneLibraryChrome;
  selection: boolean;
  onClose: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const handlers = metaHandlers(library);
  const run = (callback?: () => void) => {
    onClose();
    callback?.();
  };
  return (
    <>
      <SheetHeader title={selection ? t('uiShell.phoneLibrary.selectionActions') : t('uiShell.phoneLibrary.moreActions')} onClose={onClose} t={t} />
      {selection && handlers && (
        <div className="phone-library-sheet-content">
          <PhotoMetaControls count={library.selectedCount} {...handlers} />
        </div>
      )}
      <div className="phone-library-action-list">
        {!selection && (
          <button data-autofocus onClick={() => run(library.onMultiSelectToggle)}><MultiSelectIcon /><span>{t('common.select')}</span></button>
        )}
        {library.onToggleOriginals && (
          <button data-autofocus={selection || undefined} onClick={() => run(library.onToggleOriginals)}><BeforeAfterIcon /><span>{library.showOriginals ? t('gridToolbar.showEditedPreview') : t('gridToolbar.showOriginal')}</span></button>
        )}
        {selection && library.onSyncAdjustments && (
          <button onClick={() => run(library.onSyncAdjustments)}><SyncIcon /><span>{t('gridToolbar.syncAdjustments')}</span></button>
        )}
        {library.onSlideshow && (
          <button onClick={() => run(library.onSlideshow)}><PlayIcon /><span>{t('gridToolbar.slideshow')}</span></button>
        )}
        {library.onPrint && (
          <button onClick={() => run(library.onPrint)} disabled={selection && library.selectedCount === 0}><PrintIcon /><span>{t('gridToolbar.print')}</span></button>
        )}
        {selection && (
          <button className="danger" onClick={() => run(library.onRemoveSelected)} disabled={library.selectedCount === 0}><TrashIcon /><span>{t('gridToolbar.removeSelected', { count: library.selectedCount })}</span></button>
        )}
      </div>
    </>
  );
}

function SheetHeader({ title, onClose, t }: { title: string; onClose: () => void; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <div className="phone-library-sheet-header">
      <h2 id="phone-library-sheet-title">{title}</h2>
      <button onClick={onClose} aria-label={t('common.close')}><CloseIcon /></button>
    </div>
  );
}

function ControlSection({ label, children }: { label: string; children: ReactNode }) {
  return <section className="phone-control-section"><h3>{label}</h3>{children}</section>;
}

function trapFocus(event: KeyboardEvent, container: HTMLElement) {
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
  ));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function MenuIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M4 12h16M4 17h16" /></svg>; }
function CloseIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 6l12 12M18 6L6 18" /></svg>; }
function BackIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M15 5l-7 7 7 7" /></svg>; }
function SearchIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="11" cy="11" r="6" /><path d="M16 16l4 4" /></svg>; }
function AdjustIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M10 14v6" /></svg>; }
function MoreIcon() { return <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>; }
function ExportIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 15V3M7 8l5-5 5 5M5 13v7h14v-7" /></svg>; }
function StarIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 4l2.3 4.9 5.2.7-3.8 3.7.9 5.3-4.6-2.5-4.6 2.5.9-5.3-3.8-3.7 5.2-.7z" /></svg>; }
function MultiSelectIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14.5 17l2 2 4-5" /></svg>; }
function BeforeAfterIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M12 3v18" /></svg>; }
function SyncIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 12h16M16 8l4 4-4 4" /></svg>; }
function PlayIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 8l6 4-6 4z" fill="currentColor" /></svg>; }
function PrintIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M7 9V3h10v6M7 17H4V9h16v8h-3M7 14h10v7H7z" /></svg>; }
function TrashIcon() { return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14" /></svg>; }

function LibraryModeIcon({ mode }: { mode: LibraryViewMode }) {
  if (mode === 'grid') return <svg viewBox="0 0 20 20" fill="currentColor"><rect x="2" y="2" width="6" height="6" rx="1" /><rect x="12" y="2" width="6" height="6" rx="1" /><rect x="2" y="12" width="6" height="6" rx="1" /><rect x="12" y="12" width="6" height="6" rx="1" /></svg>;
  if (mode === 'compare') return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="16" height="14" rx="2" /><path d="M10 3v14" /></svg>;
  if (mode === 'survey') return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="6" height="14" rx="1" /><rect x="12" y="3" width="6" height="14" rx="1" /></svg>;
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="16" height="16" rx="2" /></svg>;
}

function GridModeIcon({ mode }: { mode: GridMode }) {
  if (mode === 'tiles') return <LibraryModeIcon mode="grid" />;
  if (mode === 'list') return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 5h14M3 10h14M3 15h14" /></svg>;
  if (mode === 'gallery') return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="2" width="16" height="11" rx="2" /><path d="M3 17h4M8 17h4M13 17h4" /></svg>;
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 2v16h15" /><rect x="6" y="5" width="2" height="6" fill="currentColor" /><rect x="11" y="8" width="2" height="3" fill="currentColor" /><rect x="16" y="3" width="2" height="8" fill="currentColor" /></svg>;
}
