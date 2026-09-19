import { lazy, Suspense, useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Sidebar } from './components/Sidebar';
import { GridToolbar } from './components/GridToolbar';
import { PhotoGrid } from './components/PhotoGrid';
import { ContextMenu } from './components/ContextMenu';
import { AddToCollectionDialog } from './components/AddToCollectionDialog';
import { ConfirmDeleteDialog } from './components/ConfirmDeleteDialog';
import { ConfirmRemoveDialog } from './components/ConfirmRemoveDialog';
import { BatchAutoOptimizeDialog, type BatchAutoOptimizeStatus } from './components/BatchAutoOptimizeDialog';
import { sourceManager, writeCapabilitiesOf } from './sources';
import { sourceCapability } from './sources/capabilities';
import { StaleAssetBanner } from './components/StaleAssetBanner';
import { CatalogReadOnlyBanner } from './components/CatalogReadOnlyBanner';
import { AdaptiveNavigation, type NavigationSection } from './components/AdaptiveNavigation';
import { ToastProvider, useToast } from './components/Toast';
import { RawPairOpenDialog } from './components/RawPairOpenDialog';
import { buildRawPairIndex, EMPTY_RAW_PAIR_INDEX, isRawName, pairMembers, pairPartner, type RawPair } from './data/rawPairing';
import { RawPairProvider } from './contexts/RawPairContext';
import { buildStackIndex, isStackHead, stackMemberIds } from './data/photoStacks';
import { StackProvider, type StackView } from './contexts/StackContext';
import { useStacking } from './hooks/useStacking';
import { AlignmentBench } from './components/bench/AlignmentBench';
import { baseAdjustmentsFor } from './engine/developProfileStore';
import { lensCoefficientsFor } from './engine/lensProfileStore';
import { useDevelopProfiles } from './hooks/useDevelopProfiles';
import { useLensProfiles } from './hooks/useLensProfiles';
import { LensCoefficientsPanel } from './components/bench/LensCoefficientsPanel';
import { NEUTRAL_LENS_COEFFICIENTS, type LensCoefficients } from './engine/lensProfile';
import { toBaseProfileAdjustments } from './engine/developProfile';
import { analyseBenchSelection, benchSelectionHint } from './components/bench/benchSelection';

import { LibrarySpecialView } from './components/LibrarySpecialView';
import { useSources } from './hooks/useSources';
import { countAlbumsWithoutName, countFailedParts } from './sources/IncompleteListingError';
import { refreshToastMessage } from './i18n/sourceMessages';
import { historyForPersistence, usePhotoEdits, type SidecarCallbacks } from './hooks/usePhotoEdits';
import { usePresets } from './hooks/usePresets';
import { usePhotoActions } from './hooks/usePhotoActions';
import { canPushMetadata, useMetadataPush } from './hooks/useMetadataPush';
import { exportPhoto, generateFileName, renderPhoto } from './engine/Exporter';
import { deliverFile } from './platform/fileDelivery';
import type { ExportOptions, ExportWarning, RenderPhotoInput, RenderedFrame } from './engine/Exporter';
import type { ExportDestination } from './components/ExportDialog';
import { usePhotoAggregations } from './hooks/usePhotoAggregations';
import { useAvailablePhotos } from './hooks/useAvailablePhotos';
import { getBrand } from './brand';
import { editStackHash, editStackFingerprint, shortEditStackHash } from './export/editStackHash';
import { shouldWarnUnexportedEdit } from './export/unexportedEdit';
import { buildExportFilename } from './export/filename';
import { isExportError } from './export/ExportError';
import { exportErrorToast } from './export/exportErrorToast';
import { exportWarningToast } from './export/exportWarningToast';
import { retryExport } from './export/exportRetry';
import { ViewModeBar } from './ui/ViewModeBar';
import { useCollections } from './hooks/useCollections';
import { useImportPreset } from './hooks/useImportPreset';
import { useUiPreferences } from './hooks/useUiPreferences';
import { pauseThumbnailQueue, resumeThumbnailQueue } from './hooks/thumbnailQueue';
import { IndexingStatus } from './components/IndexingStatus';
import { useBackgroundThumbnails } from './hooks/useBackgroundThumbnails';
import { useSidecarManager } from './hooks/useSidecarManager';
import { perfLog } from './platform/perfLog';
import { usePhotoFilter } from './hooks/usePhotoFilter';
import { DEFAULT_LIBRARY_FILTERS } from './data/libraryFilters';
import { defaultAdjustments, type ViewMode, type LibraryViewMode, type SortOption, type GridMode, type GridFlow, type GroupMode, type Adjustments, type HistogramStyle } from './types';
import type { PhotoColorLabel, PhotoFlag, PhotoView } from './storage/repos';
import type { PhotoMetaOutcome } from './data/photoMeta';
import { PhotoMetaControls } from './components/PhotoMetaControls';
import { useRepos } from './contexts/StorageContext';
import { PanelSystem } from './ui/PanelSystem';
import { PANEL_MAP } from './ui/panelRegistry';
import { PanelLayoutProvider, usePanelLayoutContext } from './contexts/PanelLayoutContext';
import { useLibraryPanelContent } from './ui/useLibraryPanelContent';
import { useExif, exifFromCatalog } from './hooks/useExif';
import { createFirstEditState, runFirstEdit } from './hooks/firstQuickDevEdit';
import { slideshowSelection } from './components/slideshowSelection';
import { useExifBackfill } from './hooks/useExifBackfill';
import { usePersistedState, usePersistedSet } from './hooks/usePersistedState';
import { isFileSystemAccessSupported as hasNativeFSAccess } from './storage';
import { STORAGE_KEYS, hasStoredAppState } from './platform/storageKeys';
import { config as platformConfig } from './platform/config';
import { useDialogState } from './hooks/useDialogState';
import { SourceProvider } from './contexts/SourceContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { StorageProvider, useStorage, useStorageRevisions } from './contexts/StorageContext';
import { AdaptiveLayoutProvider, useAdaptiveLayout } from './contexts/AdaptiveLayoutContext';
import { FirstLaunchModal } from './components/FirstLaunchModal';
import { AlphaNoticeModal } from './components/AlphaNoticeModal';
import { alphaNoticePending, acknowledgeAlphaNotice } from './components/alphaNotice';
import { PassphraseDialog } from './components/PassphraseDialog';
import './App.css';
import { makeRawCacheKey } from './engine/raw/cacheKey';
import { capRenderLongEdge } from './engine/printResolution';
import { canExportAllAt16Bit } from './engine/sourceBitDepth';
import { HeifDecoder } from './engine/HeifDecoder';
import { planExportDepth } from './export/exportDepthFallback';
import {
  AutoOptimizeEtaEstimator,
  analyzeFileForAutoOptimize,
  autoOptimizeFileType,
  orderForEtaCalibration,
} from './engine/BatchAutoOptimize';
import { applyAutoResult } from './engine/AutoOptimizer';
import { adjustmentsToDocument, documentToAdjustments, isPhotoDocument, patchBaseAdjustments } from './engine/DocumentModel';
import { computeContentHash } from './data/contentHash';
import { exportEditsFor } from './export/exportEdits';
import { decidePushToSource } from './export/pushToSource';
import type { PhotoDocument } from './engine/DocumentModel';
import { applyPresetAsLayer, DEFAULT_PRESET_STRENGTH, findPresetLayer, setPresetLayerStrength } from './engine/PresetLayer';
import { adjustmentsForPanels } from './engine/adjustmentFields';
import { queueEditThumbnail, renderEditThumbnailNow } from './engine/ThumbnailRenderer';
import { editThumbnailKey } from './cache/editThumbnailKey';
import { thumbnailStampFor } from './engine/thumbnailStamp';
import { thumbMemCache } from './cache/ThumbMemCache';

// Keep editor and dialog-only dependencies off the initial library route.
// Named exports are adapted to React.lazy's default-export contract.
const PhotoEditor = lazy(() => import('./components/PhotoEditor').then((module) => ({ default: module.PhotoEditor })));
const AppDialogs = lazy(() => import('./components/AppDialogs').then((module) => ({ default: module.AppDialogs })));

/**
 * One-time alpha warning on the first load of this browser profile. Rendered
 * above every other overlay so it is read before a library gets connected.
 */
function AlphaNoticeGate() {
  const [open, setOpen] = useState(alphaNoticePending);
  if (!open) return null;
  return (
    <AlphaNoticeModal
      onDismiss={() => {
        acknowledgeAlphaNotice();
        setOpen(false);
      }}
    />
  );
}

/** Gate that renders the FirstLaunchModal only when explicitly requested. */
function FirstLaunchModalGate() {
  const { showOnboarding } = useStorage();
  if (!showOnboarding) return null;
  return <FirstLaunchModal />;
}

function PassphraseDialogGate() {
  const { passphraseRequest } = useStorage();
  return <PassphraseDialog request={passphraseRequest} />;
}

// sortPhotos moved to usePhotoFilter hook

/**
 * Outer App: only renders the StorageProvider. The actual app body lives
 * in AppInner, which is mounted as a child of the provider so its useRepos()
 * / useStorage() calls find a context. AppGate gates AppInner on storage
 * readiness (the initial OPFS open is async) — useRepos() throws if called
 * with no storage yet.
 */
/** How many photos the alignment bench shows at once. */
const BENCH_MAX_PHOTOS = 9;

/** Panels the preset bench offers, and which of them start expanded. */
const BENCH_PRESET_PANELS = [
  'basic', 'whitebalance', 'presence',
  'tonecurve', 'levels', 'hsl', 'colorgrading', 'detail', 'effects',
];
const BENCH_PRESET_OPEN = ['basic', 'whitebalance', 'presence'];

/**
 * The RAW-development bench. Effects and transform are missing on purpose:
 * they have no base: node, so a value set there would be stored and never
 * rendered. The lens coefficients arrive as an extra panel when the selection
 * agrees on one lens.
 */
const RAWDEV_PANELS = [
  'basic', 'whitebalance', 'presence',
  'tonecurve', 'levels', 'colorgrading', 'detail',
];
const RAWDEV_OPEN = ['basic', 'whitebalance', 'presence'];

/** Working on the lens: the coefficients, and the passes judged beside them. */
const LENS_PANELS = ['presence', 'detail', 'effects'];
const LENS_OPEN = ['lenscoeff'];


function App() {
  return (
    <AdaptiveLayoutProvider>
      <ToastProvider>
        <StorageProvider>
          <AlphaNoticeGate />
          <PassphraseDialogGate />
          <FirstLaunchModalGate />
          <Phase2MigrationToast />
          <AppGate />
        </StorageProvider>
      </ToastProvider>
    </AdaptiveLayoutProvider>
  );
}

/**
 * Phase 2 (linear-math hard-cut) shipped a behaviour change for every
 * existing edit. One-time toast tells the user; localStorage flag keeps
 * it from re-firing across sessions.
 */
function Phase2MigrationToast() {
  const { t } = useTranslation();
  const { push } = useToast();
  useEffect(() => {
    const KEY = STORAGE_KEYS.phase2MigrationToastShown;
    try {
      if (localStorage.getItem(KEY) === '1') return;
      // Fresh profile (no prior photolib state) → nobody has pre-phase-2
      // edits that could "look different"; set the flag silently.
      if (!hasStoredAppState([KEY])) {
        localStorage.setItem(KEY, '1');
        return;
      }
      push({
        kind: 'info',
        title: t('migration.linearEngineTitle'),
        message: t('migration.linearEngineMessage'),
        persistent: true,
        dedupeKey: 'phase2-migration',
      });
      localStorage.setItem(KEY, '1');
    } catch { /* localStorage unavailable — silent skip */ }
  }, [push, t]);
  return null;
}

function AppGate() {
  const { storage, opening, openError, pendingFolderName, resumeFolder, setShowOnboarding } = useStorage();
  const { t } = useTranslation();
  // The panel layout owns one localStorage key and is read by both shells
  // (library and editor), so it is created once above them.
  if (storage) return <PanelLayoutProvider><AppInner /></PanelLayoutProvider>;
  // A folder catalog after a browser restart: the browser asks again, and it
  // may only ask from a click - so the splash offers the click.
  if (pendingFolderName && !opening) {
    return (
      <div className="app-splash">
        <div className="app-splash-inner app-splash-ask">
          <p>{t('app.splash.folderPermission', { name: pendingFolderName })}</p>
          <p className="app-splash-note">{t('app.splash.folderPermissionNote')}</p>
          {openError && <p className="app-splash-error">{t('app.splash.error', { message: openError })}</p>}
          <div className="app-splash-actions">
            <button className="app-splash-primary" onClick={() => void resumeFolder()}>
              {t('app.splash.folderPermissionAllow')}
            </button>
            <button className="app-splash-secondary" onClick={() => setShowOnboarding('switch')}>
              {t('app.splash.folderPermissionOther')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="app-splash">
      <div className="app-splash-inner">
        {opening ? <span>{t('app.splash.opening')}</span> : openError
          ? <span style={{ color: 'var(--color-error, #e74c3c)' }}>{t('app.splash.error', { message: openError })}</span>
          : <span>{t('app.splash.select')}</span>}
      </div>
    </div>
  );
}

/** How long a Quick Develop slider has to rest before the selection follows. */
const QUICK_DEV_FANOUT_DELAY_MS = 600;
/** Parallel fan-out writes. Each one may fetch a file to hash it, so keep it low. */
const QUICK_DEV_FANOUT_CONCURRENCY = 3;
/** How long "N photos removed" stays around with its undo. */
const REMOVE_UNDO_MS = 10_000;

function AppInner() {
  const { t } = useTranslation();
  const toast = useToast();
  const revisions = useStorageRevisions();
  const adaptiveLayout = useAdaptiveLayout();
  const {
    sources, photos: indexedPhotos, scanning, reconnected, canLoadMore, loadMore,
    addLocalSource, addLocalSourceFromFiles, addImmichSource, addImmichV3Source, addWebDAVSource,
    addPhotoLibLibrarySource, scanSource,
    removeSource, rescanSource, refreshSourceFull, removePhotosFromIndex, restorePhotosToIndex,
    getAutoRefresh, setAutoRefresh,
    ensureContentHash, getDisplayUrl, refreshPhotos,
    disconnectedIds, reconnectSource,
  } = useSources();

  const [availabilityFilter, setAvailabilityFilter] = usePersistedState<'online' | 'unavailable' | 'all'>(
    'availabilityFilter',
    DEFAULT_LIBRARY_FILTERS.availabilityFilter,
  );

  // The catalog keeps indexed photo rows across temporary disconnects. All
  // library surfaces consume this single availability projection so orphaned
  // rows never appear as empty images in one view but disappear in another.
  const { photos } = useAvailablePhotos(
    indexedPhotos,
    sources,
    disconnectedIds,
    reconnected,
    availabilityFilter,
  );

  const [selectedPhoto, setSelectedPhoto] = useState<PhotoView | null>(null);
  const [navigationDrawerOpen, setNavigationDrawerOpen] = useState(false);
  const [navigationDrawerSection, setNavigationDrawerSection] = useState<NavigationSection>('sources');
  const [phoneTopbarHidden, setPhoneTopbarHidden] = useState(false);
  const phoneLibraryScrollRef = useRef({ top: 0, accumulated: 0 });
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [view, setView] = usePersistedState<ViewMode>('view', 'grid');
  const [contentHash, setContentHash] = useState<string | null>(null);
  const [libraryViewMode, setLibraryViewMode] = usePersistedState<LibraryViewMode>('libraryViewMode', 'grid');
  const [search, setSearch] = useState('');
  const [sort, setSort] = usePersistedState<SortOption>('sort', 'date-newest');
  const [multiSelect, setMultiSelect] = useState(false);
  const [showOriginals, setShowOriginals] = useState(false);
  const [gridMode, setGridMode] = usePersistedState<GridMode>('gridMode', 'tiles');
  const [groupMode, setGroupMode] = usePersistedState<GroupMode>('groupMode', 'none');
  const [tileSize, setTileSize] = usePersistedState('tileSize', 180);
  const [hiddenSources, setHiddenSources] = usePersistedSet('hiddenSources');
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [histogramStyle, setHistogramStyle] = usePersistedState<HistogramStyle>('histogramStyle', 'filled');
  const uiPrefs = useUiPreferences();
  const dialogs = useDialogState();
  const hasOpenDialog = dialogs.showAddSource
    || dialogs.showExport
    || dialogs.showPrint
    || dialogs.showSlideshow
    || dialogs.showAbout
    || dialogs.showSettings
    || dialogs.showUnexportedEdit;
  const [ratingFilter, setRatingFilter] = usePersistedState<number>('ratingFilter', DEFAULT_LIBRARY_FILTERS.ratingFilter);
  const [flagFilter, setFlagFilter] = usePersistedState<string>('flagFilter', DEFAULT_LIBRARY_FILTERS.flagFilter);
  const [labelFilter, setLabelFilter] = usePersistedState<string>('labelFilter', DEFAULT_LIBRARY_FILTERS.labelFilter);
  const [cameraFilter, setCameraFilter] = usePersistedState<string>('cameraFilter', DEFAULT_LIBRARY_FILTERS.cameraFilter);
  const [lensFilter, setLensFilter] = usePersistedState<string>('lensFilter', DEFAULT_LIBRARY_FILTERS.lensFilter);
  const repos = useRepos();
  const { presets, savePreset, deletePreset, exportPreset, importPreset } = usePresets();
  // Fills the module-level store the render paths read from. Held here rather
  // than in the editor because the exporter and the background thumbnail
  // renderer read it too, and they outlive any open photo.
  const { profiles: developProfiles, saveProfile, deleteProfile } = useDevelopProfiles();
  const { lensProfiles, saveLensProfile, deleteLensProfile } = useLensProfiles();
  // Filled in below, once the pairing is known; usePhotoEdits only needs a
  // stable entry point.
  const mirrorTransformRef = useRef<(contentHash: string, document: PhotoDocument) => void>(() => {});
  const handleEditPersisted = useCallback(
    (hash: string, doc: PhotoDocument) => mirrorTransformRef.current(hash, doc),
    [],
  );
  // A sidecar only exists where the source can hold one - today LocalSource,
  // which keeps it in .photolib/index.json. Keyed on the photo's identity, not
  // on the row: a new PhotoView object for the same photo must not restart the
  // edit-loading effect.
  const sidecarSourceId = selectedPhoto?.sourceId;
  const sidecarPhotoId = selectedPhoto?.sourcePhotoId;
  const sidecarPhotoName = selectedPhoto?.name;
  const sidecarCallbacks = useMemo<SidecarCallbacks | null>(() => {
    if (!sidecarSourceId || !sidecarPhotoId || !sidecarPhotoName) return null;
    const source = sourceManager.get(sidecarSourceId);
    const read = source?.readSidecar?.bind(source);
    const write = source?.writeSidecar?.bind(source);
    if (!read || !write) return null;
    const ref = { sourcePhotoId: sidecarPhotoId, sourceId: sidecarSourceId, name: sidecarPhotoName };
    return { readSidecar: () => read(ref), writeSidecar: (data: string) => write(ref, data) };
  }, [sidecarSourceId, sidecarPhotoId, sidecarPhotoName]);
  const { adjustments, setAdjustments, document: photoDocument, setDocument: setPhotoDocument, saving, history, undo, redo, canUndo, canRedo, restoreToIndex, copyIndex } = usePhotoEdits(contentHash, sidecarCallbacks, handleEditPersisted);
  const adjustmentsRef = useRef(adjustments);
  adjustmentsRef.current = adjustments;
  // RAW+JPEG pairing. The index is always built so the editor can offer the
  // switch, but the grid only collapses pairs while grouping is on.
  const [pairRawJpeg, setPairRawJpeg] = usePersistedState<boolean>('pairRawJpeg', false);
  // Which half leads a pair follows the edits, so the index is rebuilt whenever
  // an edit is written - and only then, which is why this watches the edits
  // revision rather than every write to the catalog.
  const editedAtByHash = useMemo(() => repos.edits.editedAtByHash(), [repos, revisions.edits]);
  const allRawPairs = useMemo(
    () => buildRawPairIndex(photos, editedAtByHash),
    [photos, editedAtByHash],
  );
  // Everything downstream reads the gated index, so switching grouping off
  // really does leave the two files as two ordinary photos.
  const rawPairIndex = pairRawJpeg ? allRawPairs : EMPTY_RAW_PAIR_INDEX;

  // Stacking. Unlike pairing this is stored, not derived, so there is no
  // switch: a stack the user made stays folded until they open it. Opening is
  // per session - it says "show me this stack now", not "keep it open".
  const [expandedStacks, setExpandedStacks] = useState<ReadonlySet<string>>(() => new Set());
  const stackIndex = useMemo(() => buildStackIndex(photos), [photos]);
  const toggleStack = useCallback((stackId: string) => {
    setExpandedStacks((previous) => {
      const next = new Set(previous);
      if (next.has(stackId)) next.delete(stackId);
      else next.add(stackId);
      return next;
    });
  }, []);
  const stackContextValue = useMemo<StackView>(
    () => ({ index: stackIndex, expanded: expandedStacks, toggle: toggleStack }),
    [stackIndex, expandedStacks, toggleStack],
  );
  // A folded head stands for its whole stack, so every stack action reaches
  // the members the grid is hiding behind it.
  const expandAcrossStacks = useCallback(
    (photoIds: number[]) => Array.from(new Set(photoIds.flatMap((id) => stackMemberIds(id, stackIndex)))),
    [stackIndex],
  );
  const { autoStack, stackPhotos, unstackPhotos, setStackHead } = useStacking(photos, stackIndex, refreshPhotos);

  // Geometry belongs to the shot, not to one of its two files: straightening or
  // turning one half of a grouped pair has to move the other half too, or the
  // two drift apart. Colour and tone stay per file - that is the point of
  // keeping two edit stacks.
  mirrorTransformRef.current = (sourceHash, doc) => {
    const partner = selectedPhoto ? pairPartner(selectedPhoto, rawPairIndex) : null;
    if (!partner?.contentHash || partner.contentHash === sourceHash) return;

    const master = repos.edits.getMaster(partner.contentHash);
    const base = master?.document ?? adjustmentsToDocument(master?.adjustments ?? defaultAdjustments);
    if (JSON.stringify(base.transform) === JSON.stringify(doc.transform)) return;

    const next: PhotoDocument = { ...base, transform: { ...doc.transform } };
    repos.edits.upsert({
      contentHash: partner.contentHash,
      copyIndex: 0,
      adjustments: documentToAdjustments(next),
      document: next,
      history: master?.history,
      documentHistory: master?.documentHistory,
    });
  };

  // A rating belongs to the shot, not to one of its two files.
  const expandAcrossPairs = useCallback(
    (photoIds: number[]) => Array.from(new Set(photoIds.flatMap((id) => pairMembers(id, rawPairIndex)))),
    [rawPairIndex],
  );

  const pushMetadataToSource = useMetadataPush();
  /**
   * Auto-push is opt-in and off by default: a star click must not write to
   * someone's Immich unasked. The rows are read back from the repository
   * because the write that triggered this has not reached `photos` yet.
   */
  const [autoPushMetadata, setAutoPushMetadata] = usePersistedState<boolean>('autoPushMetadata', false);
  const handlePushableMetaChange = useCallback((photoIds: number[]) => {
    if (!autoPushMetadata || photoIds.length === 0) return;
    void pushMetadataToSource(repos.photos.bulkGet(photoIds), { quiet: true });
  }, [autoPushMetadata, pushMetadataToSource, repos]);

  const { setRating, setFlag, setColorLabel, addKeywords, removeKeyword } =
    usePhotoActions(refreshPhotos, expandAcrossPairs, handlePushableMetaChange);

  // Photos that have not been identified yet carry no metadata. The setters
  // report how many they had to leave out; saying so once is the difference
  // between "nothing happened" and "it did nothing to these".
  const reportMetaOutcome = useCallback((outcome: PhotoMetaOutcome) => {
    if (outcome.skipped === 0) return;
    toast.push({
      kind: 'warning',
      message: t('photoMeta.skippedNoHash', { count: outcome.skipped }),
      dedupeKey: 'photo-meta-skipped',
    });
  }, [t, toast]);

  const rateSelection = useCallback((photoIds: number[], rating: number) => {
    reportMetaOutcome(setRating(photoIds, rating));
  }, [reportMetaOutcome, setRating]);

  const flagSelection = useCallback((photoIds: number[], flag: PhotoFlag) => {
    reportMetaOutcome(setFlag(photoIds, flag));
  }, [reportMetaOutcome, setFlag]);

  const labelSelection = useCallback((photoIds: number[], colorLabel: PhotoColorLabel) => {
    reportMetaOutcome(setColorLabel(photoIds, colorLabel));
  }, [reportMetaOutcome, setColorLabel]);

  const handleRemoveSource = useCallback(async (sourceId: string) => {
    const removedPhotoIds = new Set(
      indexedPhotos
        .filter((photo) => photo.sourceId === sourceId)
        .map((photo) => photo.id),
    );

    await removeSource(sourceId);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const id of removedPhotoIds) next.delete(id);
      return next;
    });
    if (selectedPhoto?.sourceId === sourceId) {
      setSelectedPhoto(null);
      setContentHash(null);
      setView('grid');
    }
  }, [indexedPhotos, removeSource, selectedPhoto, setView]);

  // Batch: sync current adjustments to all selected photos
  const syncAdjustmentsToSelected = useCallback(() => {
    const adj = adjustmentsRef.current;
    const targets = photos.filter((p) => selectedIds.has(p.id) && p.contentHash && p.contentHash !== contentHash);
    for (const photo of targets) {
      repos.edits.upsert({ contentHash: photo.contentHash!, copyIndex: 0, adjustments: adj });
      // Without this the row is written but every tile keeps its old picture,
      // so the button looks like it did nothing.
      queueEditThumbnail(photo.contentHash!, adj);
    }
  }, [photos, selectedIds, contentHash, repos]);
  const {
    collections, addCollection, deleteCollection, renameCollection,
    addPhotosToCollection, removePhotosFromCollection,
    updateSmartRules,
  } = useCollections();
  const importSettings = useImportPreset();
  const [activeCollectionId, setActiveCollectionId] = useState<number | null>(null);

  // Quick Collection: auto-created special collection
  const quickCollection = collections.find((c) => c.name === '⚡ Quick Collection' && c.type === 'manual');
  const toggleQuickCollection = useCallback(async (photoIds: number[]) => {
    let qcId = quickCollection?.id;
    if (!qcId) {
      // Auto-create on first use
      addCollection('⚡ Quick Collection', 'manual');
      const created = repos.collections.list().find((c) => c.name === '⚡ Quick Collection');
      if (!created) return;
      qcId = created.id;
    }
    const existing = new Set(quickCollection?.photoIds ?? []);
    // If ALL selected are already in QC → remove them; otherwise add them
    const allIn = photoIds.every((id) => existing.has(id));
    if (allIn) {
      removePhotosFromCollection(qcId, photoIds);
    } else {
      addPhotosToCollection(qcId, photoIds);
    }
  }, [quickCollection, addCollection, addPhotosToCollection, removePhotosFromCollection, repos.collections]);
  const [keywordFilter, setKeywordFilter] = useState<string>(DEFAULT_LIBRARY_FILTERS.keywordFilter);
  const [lastPhotoId, setLastPhotoId] = usePersistedState<number | null>('lastPhotoId', null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const panelLayout = usePanelLayoutContext();
  useBackgroundThumbnails(photos, view !== 'editor' && !scanning);
  useExifBackfill(photos, view !== 'editor' && !scanning);
  // Opening a photo throttles the thumbnail queue. The editor has more exits
  // than the back button (removing the open photo's source, the view switcher),
  // so the queue opens up again on the view, not on one handler.
  useEffect(() => {
    if (view !== 'editor') resumeThumbnailQueue();
  }, [view]);

  // Restore last opened photo on app start. `view` is persisted, so a session
  // that ended in the editor comes back as view === 'editor' with no photo —
  // fall back to the library instead of stranding the user on an empty screen.
  useEffect(() => {
    if (view !== 'editor' || selectedPhoto) return;
    if (lastPhotoId !== null && photos.length > 0) {
      const photo = photos.find((p) => p.id === lastPhotoId);
      if (photo) { handleOpen(photo); return; }
    }
    // Only give up once the library is done loading — the photo may still be
    // in a page that has not been fetched yet.
    if (lastPhotoId === null || (!scanning && !canLoadMore)) setView('grid');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photos.length, scanning, canLoadMore]);

  // EXIF for selected photo (library mode — for metadata panel)
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const selectedFileExif = useExif(selectedFile);
  const selectedExif = selectedFileExif ?? (selectedPhoto ? exifFromCatalog(selectedPhoto) : null);
  useEffect(() => {
    if (view === 'editor') { setSelectedFile(null); return; }
    if (!selectedPhoto) { setSelectedFile(null); setContentHash(null); return; }
    const controller = new AbortController();
    let cancelled = false;
    // A stored hash is the photo's identity and costs nothing to read, so the
    // library panels get it right away. What must NOT happen here is a write:
    // every photo row write bumps the photos revision, and that re-reads the
    // whole photos table, re-filters it, and rebuilds the RAW pair index -
    // once per click through the grid.
    setContentHash(selectedPhoto.contentHash ?? null);
    // Only a source whose bytes the browser already owns hands the original
    // over for free. For a server-side library (Immich, Lychee, ...) getFile
    // IS the download of the original, 20-60 MB, and a single click through
    // the grid stacks one per photo. There the catalogue row carries the EXIF
    // and the hash waits for the first edit (F022).
    if (sourceCapability(sourceManager.get(selectedPhoto.sourceId)?.type)?.transport !== 'browser-native') {
      setSelectedFile(null);
      return () => { cancelled = true; controller.abort(); };
    }
    // Try getFile first (has EXIF), fallback to getDisplayUrl
    (async () => {
      try {
        const source = (await import('./sources')).sourceManager.get(selectedPhoto.sourceId);
        if (source && !cancelled) {
          const file = await source.getFile({
            sourcePhotoId: selectedPhoto.sourcePhotoId,
            sourceId: selectedPhoto.sourceId,
            name: selectedPhoto.name,
          }, controller.signal);
          if (file && !cancelled) {
            setSelectedFile(file);
            // Only the original bytes may be hashed. The display-URL fallback
            // below re-encodes, so a hash taken from it would name a different
            // photo than the editor's.
            if (!selectedPhoto.contentHash) {
              const hash = await computeContentHash(file);
              if (!cancelled) setContentHash(hash);
            }
            return;
          }
        }
      } catch { /* */ }
      // Fallback
      if (cancelled) return;
      try {
        const url = await getDisplayUrl(selectedPhoto);
        if (url && !cancelled) {
          const r = await fetch(url, { signal: controller.signal });
          const b = await r.blob();
          // Deliberately NOT the original's name: this is a display rendition,
          // and calling it "X.RAF" would send the histogram's decoder ladder
          // hunting for an embedded JPEG inside what is already a JPEG.
          if (!cancelled) setSelectedFile(new File([b], 'display.jpg'));
        }
      } catch { /* */ }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [view, selectedPhoto, getDisplayUrl]);

  const { allKeywords, cameras, lenses, photoCountBySource, folderTree } =
    usePhotoAggregations(photos, sources, hiddenSources);

  // Selected photos for keywords panel
  const selectedPhotos = useMemo(() => {
    if (selectedIds.size === 0 && selectedPhoto) return [selectedPhoto];
    return photos.filter((p) => selectedIds.has(p.id!));
  }, [photos, selectedIds, selectedPhoto]);

  // Print. Collects WHICH photos to print, nothing more: the dialog renders
  // them through the engine (see renderForPrint). It used to resolve display
  // URLs here, and the page then drew those originals - unedited, and for a
  // local RAW not decodable at all (F071).
  const handlePrint = useCallback(() => {
    const targets = selectedPhotos.length > 0 ? selectedPhotos : (selectedPhoto ? [selectedPhoto] : []);
    if (targets.length > 0) {
      dialogs.openPrint(targets.map((photo) => ({ photo, name: photo.name })));
    }
  }, [selectedPhotos, selectedPhoto, dialogs]);

  // Source for the library histogram: whatever the tile is showing.
  //
  // Two reasons it cannot be the display URL any more. It has to be decodable
  // by an <img>, which a RAF or a HEIC is not — the histogram then got no bins
  // and the panel kept the PREVIOUS photo's curve on screen. And it has to be
  // the same picture as the tile: once a photo has been developed the tile
  // shows the edit thumbnail, so measuring the untouched original would
  // describe an image nobody is looking at.
  // Leaving the editor is the one moment a RAW's pixels can have become
  // available since a tile last asked. The renderer remembers which photos it
  // found cold so scrolling does not re-probe them; this is what lets those
  // photos be asked again.
  useEffect(() => {
    if (view === 'editor') return;
    void import('./engine/ThumbnailRenderer').then((mod) => mod.forgetColdThumbnails()).catch(() => {});
  }, [view]);

  const [selectedDisplayUrl, setSelectedDisplayUrl] = useState<string | null>(null);
  const [tileThumbTick, setTileThumbTick] = useState(0);
  useEffect(() => {
    const photoId = view === 'editor' ? undefined : selectedPhoto?.id;
    if (!photoId) return;
    return thumbMemCache.subscribe(photoId, () => setTileThumbTick((tick) => tick + 1));
  }, [view, selectedPhoto]);

  useEffect(() => {
    if (view === 'editor') { setSelectedDisplayUrl(null); return; }
    if (!selectedPhoto) { setSelectedDisplayUrl(null); return; }
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      let blob = selectedPhoto.id ? thumbMemCache.get(selectedPhoto.id) : null;
      if (!blob && contentHash) {
        blob = await repos.thumbnails
          .get(editThumbnailKey(contentHash, thumbnailStampFor(selectedPhoto)))
          .catch(() => null);
      }
      // Deliberately no decode of its own when nothing is cached yet. Decoding
      // here competes with the grid for the same two RAW decoder slots, which
      // stalled tile loads badly enough to be visible. The tile is loading that
      // photo anyway; the subscription above picks its result up as it lands.
      if (cancelled) return;
      if (!blob) { setSelectedDisplayUrl(null); return; }
      objectUrl = URL.createObjectURL(blob);
      setSelectedDisplayUrl(objectUrl);
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [view, selectedPhoto, selectedFile, contentHash, repos, tileThumbTick]);

  // ─── Quick Develop ───
  // The panel reads from the selected photo but writes to the whole selection.
  // The fan-out waits for the slider to come to rest: every target that has
  // never been identified has to be fetched once to be hashed, and the
  // thumbnail renders behind it are not free either.
  const [quickDevProgress, setQuickDevProgress] = useState<{ done: number; total: number } | null>(null);
  const [quickDevIdentifying, setQuickDevIdentifying] = useState(false);
  const firstEditRef = useRef(createFirstEditState());
  const quickDevPatchRef = useRef<Partial<Adjustments>>({});
  const quickDevTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const quickDevRunRef = useRef(0);

  useEffect(() => () => clearTimeout(quickDevTimerRef.current), []);

  const fanOutDocumentChange = useCallback(async (
    change: (document: PhotoDocument) => PhotoDocument,
    targets: PhotoView[],
  ) => {
    const runId = ++quickDevRunRef.current;
    setQuickDevProgress({ done: 0, total: targets.length });
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < targets.length) {
        const photo = targets[next++];
        if (quickDevRunRef.current !== runId) return;
        try {
          const hash = photo.contentHash ?? await ensureContentHash(photo);
          if (!hash) continue;
          const master = repos.edits.getMaster(hash);
          const base = master?.document && isPhotoDocument(master.document)
            ? master.document
            : adjustmentsToDocument({ ...defaultAdjustments, ...(master?.adjustments ?? {}) });
          const document = change(base);
          const adjusted = documentToAdjustments(document);
          repos.edits.upsert({
            contentHash: hash,
            copyIndex: 0,
            copyName: master?.copyName,
            adjustments: adjusted,
            document,
            history: master?.history ?? [],
            documentHistory: master?.documentHistory ?? [],
          });
          queueEditThumbnail(hash, adjusted, document);
        } catch (error) {
          console.warn(`[DocumentFanOut] ${photo.name} failed:`, error);
        } finally {
          done++;
          if (quickDevRunRef.current === runId) {
            setQuickDevProgress({ done, total: targets.length });
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(QUICK_DEV_FANOUT_CONCURRENCY, targets.length) }, worker),
    );
    if (quickDevRunRef.current === runId) setQuickDevProgress(null);
  }, [ensureContentHash, repos]);

  const handleQuickDevChange = useCallback((patch: Partial<Adjustments>) => {
    // Now the hash earns its row: an edited photo needs a durable identity so
    // the tile can find its developed thumbnail again after a restart. Doing it
    // here rather than on selection keeps the rebuild - and, for a remote
    // library, the download of the original - off the browsing path.
    //
    // Until that identity exists, usePhotoEdits has nothing to write to and
    // reloads its document the moment the hash arrives. So this first edit
    // does not go through setAdjustments at all: runFirstEdit writes it onto
    // the master row and only then hands the hash over.
    if (selectedPhoto && !contentHash) {
      setQuickDevIdentifying(true);
      void runFirstEdit(selectedPhoto, patch, firstEditRef.current, {
        ensureContentHash: (photo) => ensureContentHash(photo, selectedFile),
        getMaster: (hash) => repos.edits.getMaster(hash),
        upsertMaster: (args) => repos.edits.upsert(args),
        queueThumbnail: queueEditThumbnail,
        handOverHash: setContentHash,
      })
        .then((hash) => {
          if (!hash) toast.push({ kind: 'warning', message: t('uiShell.libraryPanel.identifyFailed') });
        })
        .finally(() => setQuickDevIdentifying(false));
    } else {
      setAdjustments({ ...adjustmentsRef.current, ...patch });
    }
    const targets = photos.filter((p) => selectedIds.has(p.id!) && p.id !== selectedPhoto?.id);
    if (targets.length === 0) return;
    quickDevPatchRef.current = { ...quickDevPatchRef.current, ...patch };
    clearTimeout(quickDevTimerRef.current);
    quickDevTimerRef.current = setTimeout(() => {
      const pending = quickDevPatchRef.current;
      quickDevPatchRef.current = {};
      void fanOutDocumentChange((document) => patchBaseAdjustments(document, pending), targets);
    }, QUICK_DEV_FANOUT_DELAY_MS);
  }, [contentHash, ensureContentHash, fanOutDocumentChange, photos, repos, selectedFile, selectedIds, selectedPhoto, setAdjustments, t, toast]);

  // Library panel content
  const libraryPanelContent = useLibraryPanelContent({
    selectedPhotos,
    selectedPhoto,
    imageUrl: selectedDisplayUrl,
    adjustments: selectedPhoto ? adjustments : null,
    onQuickDevChange: handleQuickDevChange,
    quickDevProgress,
    quickDevIdentifying,
    exif: selectedExif,
    allKeywords,
    onAddKeywords: addKeywords,
    onRemoveKeyword: removeKeyword,
    onKeywordFilter: setKeywordFilter,
    keywordFilter,
  });

  const [gridFlow, setGridFlow] = usePersistedState<GridFlow>('gridFlow.v2', 'fill');
  const [pendingPairOpen, setPendingPairOpen] = useState<RawPair | null>(null);
  const [benchOpen, setBenchOpen] = useState(false);
  // Photos the user took off the bench, and photos they vouched for despite
  // what the file records. Both are per-visit judgements about this selection,
  // not facts about the photos, so they live here and are not persisted.
  const [benchExcluded, setBenchExcluded] = useState<Set<number>>(new Set());
  const [benchAccepted, setBenchAccepted] = useState<Set<number>>(new Set());
  // Camera and lens are two different measurements of two different objects,
  // so the pane works on one at a time rather than showing both sets of
  // controls and leaving the user to work out which button belongs to which.
  const [benchTarget, setBenchTarget] = useState<'camera' | 'lens'>('camera');
  const [benchAdjustments, setBenchAdjustments] = useState<Adjustments>(defaultAdjustments);
  const [presetBenchAdjustments, setPresetBenchAdjustments] = useState<Adjustments>(defaultAdjustments);
  const [lensCoefficients, setLensCoefficients] = useState<LensCoefficients>(NEUTRAL_LENS_COEFFICIENTS);
  const [lensGrid, setLensGrid] = useState(false);
  // Session-scoped, so a remembered choice never becomes a setting the user has
  // to hunt down later.
  const [pairOpenPreference, setPairOpenPreference] = useState<'ask' | 'display' | 'raw'>('ask');

  // Filter + sort photos (extracted to hook)
  const filteredPhotos = usePhotoFilter({
    photos, search, sort, hiddenSources, folderFilter,
    ratingFilter, flagFilter, labelFilter, keywordFilter, cameraFilter, lensFilter,
    activeCollectionId, collections,
    rawPairIndex,
    stackIndex, expandedStacks,
  });

  // The slideshow follows the selection once the user has made one: from two
  // photos onward it shows exactly those, otherwise the whole filtered library
  // starting at the selected photo (user decision 2026-09-12).
  const slideshow = useMemo(
    () => slideshowSelection(filteredPhotos, selectedIds, selectedPhoto),
    [filteredPhotos, selectedIds, selectedPhoto],
  );

  // Every bench works on what the gallery has selected. Picking photos for the
  // user would mean judging a profile against whichever nine happened to sort
  // first - and a base development is only worth what it does to the frames
  // they actually care about.
  //
  // Opening a photo collapses the selection to that one - a double-click's
  // first click is an ordinary single selection - and the preset bench is
  // reachable only from inside the editor. So the last multi-selection the
  // gallery held is remembered and used once the live one has shrunk to a
  // single photo. Without it, "works on your selection" would mean "works on
  // whichever photo you double-clicked".
  const lastGallerySelection = useRef<number[]>([]);
  useEffect(() => {
    if (view === 'grid' && selectedIds.size >= 2) lastGallerySelection.current = [...selectedIds];
  }, [view, selectedIds]);

  const benchPhotos = useMemo(() => {
    // In the gallery, what is selected is what the bench uses - including a
    // single photo, which the grid then shows with eight empty places. Only
    // inside the editor, where opening collapsed the selection, does the
    // remembered one take over.
    const ids = view === 'grid' ? [...selectedIds] : lastGallerySelection.current;
    const wanted = new Set(ids);
    return photos
      .filter((p) => wanted.has(p.id) && !benchExcluded.has(p.id))
      .slice(0, BENCH_MAX_PHOTOS);
    // `view` is read above: leaving the gallery is what makes the remembered
    // selection take over from the live one.
  }, [photos, selectedIds, view, benchExcluded]);
  // A different selection is a different question; last visit's exclusions and
  // vouchers would silently shape it.
  const selectionKey = [...selectedIds].sort((a, b) => a - b).join(',');
  useEffect(() => {
    setBenchExcluded(new Set());
    setBenchAccepted(new Set());
  }, [selectionKey]);

  const benchSelection = useMemo(
    () => analyseBenchSelection(benchPhotos, benchAccepted),
    [benchPhotos, benchAccepted],
  );
  const benchHint = useMemo(() => benchSelectionHint(benchSelection), [benchSelection]);

  // The camera JPEGs beside the RAWs, from the ungated index, so the
  // comparison is available even with RAW+JPEG grouping switched off.
  const benchPartners = useMemo(
    () => benchPhotos.map((photo) => allRawPairs.get(photo.id)?.display ?? null),
    [benchPhotos, allRawPairs],
  );

  const cameraProfileInForce = useMemo(() => (
    benchSelection.camera
      ? developProfiles.find((p) => p.scope === 'camera' && p.key === benchSelection.camera!.key
          && p.isoFrom === null && p.isoTo === null)
      : undefined
  ), [developProfiles, benchSelection.camera]);

  const lensProfileInForce = useMemo(() => (
    benchSelection.lens ? lensProfiles.find((p) => p.key === benchSelection.lens!.key) : undefined
  ), [lensProfiles, benchSelection.lens]);

  // Opening the pane on a selection whose lens already has a profile starts
  // from that measurement, so the next visit refines it instead of beginning
  // from flat glass.
  const cameraSeedKey = cameraProfileInForce
    ? `${cameraProfileInForce.id}:${cameraProfileInForce.updatedAt}` : '';
  useEffect(() => {
    setBenchAdjustments({
      ...defaultAdjustments,
      ...(cameraProfileInForce?.adjustments ?? {}),
    } as Adjustments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraSeedKey]);

  const lensSeedKey = lensProfileInForce ? `${lensProfileInForce.id}:${lensProfileInForce.updatedAt}` : '';
  useEffect(() => {
    setLensCoefficients(lensProfileInForce
      ? { k1: lensProfileInForce.k1, k2: lensProfileInForce.k2, k3: lensProfileInForce.k3,
          v1: lensProfileInForce.v1, v2: lensProfileInForce.v2, v3: lensProfileInForce.v3,
          caR: lensProfileInForce.caR, caB: lensProfileInForce.caB }
      : NEUTRAL_LENS_COEFFICIENTS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lensSeedKey]);

  // The RAW-development bench, rendered inside the settings pane rather than
  // over it. What it offers to save follows the selection: a camera profile
  // describes one sensor and a lens profile one piece of glass, so each is
  // only on the table when every selected photo came through that one thing.
  const cameraAvailable = !!benchSelection.camera && benchSelection.rawCount > 0;
  const lensAvailable = !!benchSelection.lens && benchSelection.rawCount > 0;
  useEffect(() => {
    if (benchTarget === 'camera' && !cameraAvailable && lensAvailable) setBenchTarget('lens');
    if (benchTarget === 'lens' && !lensAvailable && cameraAvailable) setBenchTarget('camera');
  }, [benchTarget, cameraAvailable, lensAvailable]);

  const workingOnLens = benchTarget === 'lens';

  /**
   * The profile the current selection would produce, plus the others of its
   * kind to start from. The first entry is the answer to "what am I making
   * here", which is otherwise only implied by the header.
   */
  const benchProfileOptions = useMemo(() => {
    const subject = workingOnLens ? benchSelection.lens : benchSelection.camera;
    if (!subject) return [];
    const inForce = workingOnLens ? lensProfileInForce : cameraProfileInForce;
    const others = workingOnLens
      ? lensProfiles.filter((p) => p.key !== subject.key)
      : developProfiles.filter((p) => !(p.scope === 'camera' && p.key === subject.key));
    return [
      { value: '', label: `${subject.label} — ${inForce ? 'vorhanden, wird ersetzt' : 'neu'}` },
      ...others.map((p) => ({ value: String(p.id), label: `von „${p.name}" übernehmen` })),
    ];
  }, [workingOnLens, benchSelection, lensProfileInForce, cameraProfileInForce, lensProfiles, developProfiles]);

  const benchToolbar = (
    <>
      <span className="bench-toolbar-sep" />
      <div className="bench-modes">
        {([
          ['camera', 'Kamera', cameraAvailable, 'Die Auswahl deckt mehr als eine Kamera ab.'],
          ['lens', 'Objektiv', lensAvailable, 'Die Auswahl deckt mehr als ein Objektiv ab.'],
        ] as const).map(([value, label, available, why]) => (
          <button
            key={value}
            className={`bench-mode-btn ${benchTarget === value ? 'active' : ''}`}
            data-testid={`bench-target-${value}`}
            disabled={!available}
            title={available ? undefined : why}
            onClick={() => setBenchTarget(value)}
          >{label}</button>
        ))}
      </div>
      <span className="bench-toolbar-sep" />
      <span className="bench-toolbar-label">Profil</span>
      <select
        className="bench-load-select"
        data-testid="bench-profile"
        value=""
        disabled={benchProfileOptions.length === 0}
        onChange={(e) => {
          if (!e.target.value) return;
          if (workingOnLens) {
            const found = lensProfiles.find((p) => String(p.id) === e.target.value);
            if (found) setLensCoefficients({
              k1: found.k1, k2: found.k2, k3: found.k3,
              v1: found.v1, v2: found.v2, v3: found.v3, caR: found.caR, caB: found.caB,
            });
          } else {
            const found = developProfiles.find((p) => String(p.id) === e.target.value);
            if (found) setBenchAdjustments({ ...defaultAdjustments, ...found.adjustments } as Adjustments);
          }
        }}
      >
        {benchProfileOptions.length === 0
          ? <option value="">kein Ziel — Auswahl klären</option>
          : benchProfileOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span className="bench-toolbar-sep" />
      <button
        className="bench-reset-btn"
        data-testid="bench-reset"
        onClick={() => {
          if (workingOnLens) setLensCoefficients(NEUTRAL_LENS_COEFFICIENTS);
          else setBenchAdjustments(defaultAdjustments);
        }}
        title="Die Regler dieses Ziels auf neutral - speichert nichts"
      >Zurücksetzen</button>
    </>
  );

  const rawDevBench = (
    <AlignmentBench
      open
      variant="inline"
      onClose={() => {}}
      title="RAW-Entwicklung"
      scopeLabel={[benchSelection.camera?.label, benchSelection.lens?.label]
        .filter(Boolean).join(' · ') || undefined}
      photos={benchPhotos}
      partners={benchPartners}
      emptyHint="Wähle in der Galerie Bilder aus — die Werkbank arbeitet mit deiner Auswahl."
      oddPhotos={benchSelection.odd}
      onExcludePhoto={(id) => setBenchExcluded((prev) => new Set(prev).add(id))}
      onAcceptPhoto={(id) => setBenchAccepted((prev) => new Set(prev).add(id))}
      toolbarExtra={benchToolbar}
      // The sliders ARE the profile here, so the stored one must not run as
      // well: it would show every value twice.
      applyStoredBase={false}
      // While the lens is what is being measured, the tiles show the sliders
      // and not what the catalog holds. While the camera is, they show the
      // lens profile in force, because that is what the frame will look like.
      lensProfileOverride={lensAvailable ? lensCoefficients : undefined}
      gridOverlay={workingOnLens}
      adjustments={benchAdjustments}
      onAdjustmentsChange={setBenchAdjustments}
      panelIds={workingOnLens ? LENS_PANELS : RAWDEV_PANELS}
      initiallyOpen={workingOnLens ? LENS_OPEN : RAWDEV_OPEN}
      extraPanels={workingOnLens ? [{
        id: 'lenscoeff',
        title: 'Objektiv',
        content: (
          <LensCoefficientsPanel
            value={lensCoefficients}
            onChange={setLensCoefficients}
            gridOverlay={lensGrid}
            onGridOverlayChange={setLensGrid}
          />
        ),
      }] : undefined}
      blockedHint={benchHint}
      saveActions={workingOnLens
        ? [{
          id: 'lens',
          label: 'Objektivkorrektur speichern',
          onSave: lensAvailable
            ? () => { void saveLensProfile({
                name: benchSelection.lens!.label,
                key: benchSelection.lens!.key,
                focalFrom: null,
                focalTo: null,
                coefficients: lensCoefficients,
              }); }
            : null,
        }]
        : [{
          id: 'camera',
          label: 'Kamera-Parameter speichern',
          onSave: cameraAvailable
            ? (adj) => { void saveProfile({
                name: benchSelection.camera!.label,
                scope: 'camera',
                key: benchSelection.camera!.key,
                adjustments: toBaseProfileAdjustments(adj, defaultAdjustments),
              }); }
            : null,
        }]}
    />
  );

  const libraryContextTitle = useMemo(() => {
    const collectionName = activeCollectionId === null
      ? null
      : collections.find((collection) => collection.id === activeCollectionId)?.name;
    if (collectionName) return collectionName;
    if (folderFilter) {
      if (folderFilter === '/') return t('grid.rootFolder');
      return folderFilter.split('/').filter(Boolean).pop() ?? folderFilter;
    }
    return t('uiShell.phoneLibrary.allPhotos');
  }, [activeCollectionId, collections, folderFilter, t]);

  const handleLibraryScrollCapture = useCallback((event: React.UIEvent<HTMLElement>) => {
    if (adaptiveLayout.screen !== 'phone' || view !== 'grid' || multiSelect) return;
    const scroller = event.target as HTMLElement;
    if (!scroller.classList?.contains('photo-grid')) return;

    const currentTop = scroller.scrollTop;
    const state = phoneLibraryScrollRef.current;
    const delta = currentTop - state.top;
    state.top = currentTop;

    if (currentTop <= 8) {
      state.accumulated = 0;
      setPhoneTopbarHidden(false);
      return;
    }
    if (delta === 0) return;
    if (Math.sign(delta) !== Math.sign(state.accumulated)) state.accumulated = delta;
    else state.accumulated += delta;

    if (state.accumulated > 20) {
      state.accumulated = 0;
      setPhoneTopbarHidden(true);
    } else if (state.accumulated < -8) {
      state.accumulated = 0;
      setPhoneTopbarHidden(false);
    }
  }, [adaptiveLayout.screen, multiSelect, view]);

  useEffect(() => {
    phoneLibraryScrollRef.current = { top: 0, accumulated: 0 };
    setPhoneTopbarHidden(false);
  }, [adaptiveLayout.screen, adaptiveLayout.orientation, view, libraryViewMode, gridMode, groupMode, activeCollectionId, folderFilter]);

  const lastSelectedIndex = useRef<number>(-1);

  const handleSelect = useCallback((photo: PhotoView, multi: boolean, shift?: boolean) => {
    const currentIndex = filteredPhotos.findIndex((p) => p.id === photo.id);
    if (shift && lastSelectedIndex.current >= 0 && currentIndex >= 0) {
      const start = Math.min(lastSelectedIndex.current, currentIndex);
      const end = Math.max(lastSelectedIndex.current, currentIndex);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (let i = start; i <= end; i++) next.add(filteredPhotos[i].id!);
        return next;
      });
    } else if (multi) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(photo.id!)) next.delete(photo.id!);
        else next.add(photo.id!);
        return next;
      });
      lastSelectedIndex.current = currentIndex;
    } else {
      setSelectedPhoto(photo);
      setSelectedIds(new Set([photo.id!]));
      lastSelectedIndex.current = currentIndex;
    }
  }, [filteredPhotos]);

  const openPhotoInEditor = useCallback((photo: PhotoView) => {
    perfLog.start('image-load');
    pauseThumbnailQueue();
    setSelectedPhoto(photo);
    setLastPhotoId(photo.id ?? null);
    setView('editor');
    setMultiSelect(false);
    perfLog.mark('image-load', 'view set to editor');

    // Set cached contentHash synchronously if available.
    // If not cached, PhotoEditor will compute it after loading the file
    // (to avoid parallel File System API access which causes contention).
    const cachedHash = photo.contentHash;
    if (cachedHash) {
      setContentHash(cachedHash);
      perfLog.mark('image-load', 'contentHash set (cached, sync)');
    } else {
      setContentHash(null);
      perfLog.mark('image-load', 'contentHash deferred (no cache)');
    }
  }, [setLastPhotoId, setView]);

  /**
   * Opening a grouped photo asks which half of the pair to work on — the two
   * files keep separate edit stacks, so this is a real fork, not a preference.
   */
  const handleOpen = useCallback((photo: PhotoView) => {
    const pair = rawPairIndex.get(photo.id);
    if (!pair) { openPhotoInEditor(photo); return; }
    if (pairOpenPreference === 'display') { openPhotoInEditor(pair.display); return; }
    if (pairOpenPreference === 'raw') { openPhotoInEditor(pair.raw); return; }
    setPendingPairOpen(pair);
  }, [openPhotoInEditor, pairOpenPreference, rawPairIndex]);

  /**
   * Stepping through the filmstrip keeps the kind of file that is already open,
   * so a RAW session stays a RAW session instead of re-asking on every step.
   */
  const handleEditorPhotoChange = useCallback((photo: PhotoView) => {
    const pair = rawPairIndex.get(photo.id);
    if (!pair) { openPhotoInEditor(photo); return; }
    const stayOnRaw = selectedPhoto ? isRawName(selectedPhoto.name) : false;
    openPhotoInEditor(stayOnRaw ? pair.raw : pair.display);
  }, [openPhotoInEditor, rawPairIndex, selectedPhoto]);

  const editorPairPartner = useMemo(
    () => (selectedPhoto ? pairPartner(selectedPhoto, rawPairIndex) : null),
    [selectedPhoto, rawPairIndex],
  );

  /** The exit itself. Whether it may happen is requestLeaveEditor's question. */
  const leaveEditor = useCallback(() => {
    setView('grid');
    setContentHash(null);
  }, [setView]);

  // ─── Context menu + source-delete ───
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; photo: PhotoView } | null>(null);
  // Carries the photos the menu was opened on, the way `pendingDelete` does:
  // the selection can move on while the dialog is up.
  const [pendingCollectionAdd, setPendingCollectionAdd] = useState<{ photoIds: number[] } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ photos: PhotoView[] } | null>(null);
  // Taking photos out of the catalog, once the count asked for a confirmation.
  const [pendingRemove, setPendingRemove] = useState<{ ids: number[] } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{ done: number; total: number } | null>(null);
  const [batchAutoStatus, setBatchAutoStatus] = useState<BatchAutoOptimizeStatus | null>(null);
  const batchAutoCancelRef = useRef(false);
  const batchAutoControllerRef = useRef<AbortController | null>(null);
  const batchAutoRunningRef = useRef(false);

  const handleContextMenu = useCallback((photo: PhotoView, e: React.MouseEvent) => {
    // Standard pattern: right-click on an unselected photo replaces the
    // selection with just that photo; right-click on a selected photo keeps
    // the full multi-selection so the menu acts on all of them.
    if (!selectedIds.has(photo.id!)) {
      setSelectedIds(new Set([photo.id!]));
      setSelectedPhoto(photo);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, photo });
  }, [selectedIds]);

  const cancelBatchAutoOptimize = useCallback(() => {
    batchAutoCancelRef.current = true;
    batchAutoControllerRef.current?.abort();
    setBatchAutoStatus((previous) => previous
      ? { ...previous, cancelRequested: true }
      : previous);
  }, []);

  const resetPhotoEdits = useCallback(async (selected: PhotoView[]) => {
    for (const photo of selected) {
      if (!photo.contentHash) continue;
      const existing = repos.edits.getMaster(photo.contentHash);
      if (!existing) continue;

      // Keep an explicit, freshly timestamped neutral edit so an older
      // sidecar cannot resurrect the adjustments on the next open.
      const neutralDocument = adjustmentsToDocument(defaultAdjustments);
      repos.edits.upsert({
        contentHash: photo.contentHash,
        copyIndex: 0,
        adjustments: { ...defaultAdjustments },
        document: neutralDocument,
        history: [],
        documentHistory: [],
      });
      await repos.thumbnails.delete(editThumbnailKey(photo.contentHash, thumbnailStampFor(photo)));
      if (photo.id) thumbMemCache.remove(photo.id);
    }
  }, [repos]);

  const runBatchAutoOptimize = useCallback(async (selected: PhotoView[]) => {
    if (batchAutoRunningRef.current || selected.length === 0) return;
    batchAutoRunningRef.current = true;
    batchAutoCancelRef.current = false;
    const controller = new AbortController();
    batchAutoControllerRef.current = controller;

    const queue = orderForEtaCalibration(selected);
    const estimator = new AutoOptimizeEtaEstimator();
    let done = 0;
    let failed = 0;
    let embeddedJpeg = 0;
    setBatchAutoStatus({
      done: 0,
      total: queue.length,
      currentName: queue[0]?.name ?? null,
      etaMs: estimator.estimateRemaining(queue.map(autoOptimizeFileType)),
      failed: 0,
      embeddedJpeg: 0,
      running: true,
      cancelRequested: false,
      cancelled: false,
    });

    try {
      for (let index = 0; index < queue.length; index++) {
        if (batchAutoCancelRef.current) break;
        const photo = queue[index];
        const type = autoOptimizeFileType(photo);
        const remainingWithCurrent = queue.slice(index).map(autoOptimizeFileType);
        setBatchAutoStatus((previous) => previous ? {
          ...previous,
          currentName: photo.name,
          etaMs: estimator.estimateRemaining(remainingWithCurrent),
        } : previous);

        const startedAt = performance.now();
        try {
          const source = sourceManager.get(photo.sourceId);
          if (!source) throw new Error(`Source ${photo.sourceId} is not connected`);
          const file = await source.getFile({
            sourcePhotoId: photo.sourcePhotoId,
            sourceId: photo.sourceId,
            name: photo.name,
            mimeType: photo.mimeType ?? undefined,
            sizeBytes: photo.sizeBytes ?? undefined,
          }, controller.signal);
          if (!file) throw new Error(`Could not load ${photo.name}`);

          const [contentHashValue, analysis] = await Promise.all([
            ensureContentHash(photo, file),
            analyzeFileForAutoOptimize(file, {
              sourceType: source.type,
              rawIdentity: photo,
            }),
          ]);
          if (!contentHashValue) throw new Error(`Could not identify ${photo.name}`);
          // The RAW ladder fell back to the camera's own JPEG; the dialog says
          // so at the end, because it changes what was measured (F039).
          if (analysis.rawDecodeSource === 'embedded-jpeg') embeddedJpeg++;
          const autoResult = analysis.result;

          const existing = repos.edits.getMaster(contentHashValue);
          const legacyAdjustments = {
            ...defaultAdjustments,
            ...(existing?.adjustments ?? {}),
          };
          const currentDocument = existing?.document && isPhotoDocument(existing.document)
            ? existing.document
            : adjustmentsToDocument(legacyAdjustments);
          const currentAdjustments = documentToAdjustments(currentDocument);
          const optimizedAdjustments = applyAutoResult(currentAdjustments, autoResult);
          const hasBaseLayer = currentDocument.layers.some((layer) => layer.type === 'base');
          const optimizedDocument = hasBaseLayer ? {
            ...currentDocument,
            layers: currentDocument.layers.map((layer) => layer.type !== 'base' ? layer : ({
              ...layer,
              adjustments: {
                ...layer.adjustments,
                exposure: optimizedAdjustments.exposure,
                contrast: optimizedAdjustments.contrast,
                highlights: optimizedAdjustments.highlights,
                shadows: optimizedAdjustments.shadows,
                whites: optimizedAdjustments.whites,
                blacks: optimizedAdjustments.blacks,
                temperature: optimizedAdjustments.temperature,
                vibrance: optimizedAdjustments.vibrance,
                saturation: optimizedAdjustments.saturation,
                clarity: optimizedAdjustments.clarity,
                dehaze: optimizedAdjustments.dehaze,
              },
            })),
          } : adjustmentsToDocument(optimizedAdjustments);
          const priorDocumentHistory = existing?.documentHistory?.filter(isPhotoDocument)
            ?? existing?.history?.map((item) => adjustmentsToDocument({ ...defaultAdjustments, ...item }))
            ?? [];
          const documentHistory = [...priorDocumentHistory, currentDocument].slice(-50);

          repos.edits.upsert({
            contentHash: contentHashValue,
            copyIndex: 0,
            copyName: existing?.copyName,
            adjustments: optimizedAdjustments,
            document: optimizedDocument,
            ...historyForPersistence(documentHistory),
          });
          try {
            await renderEditThumbnailNow(contentHashValue, optimizedAdjustments, optimizedDocument, {
              rawPixels: analysis.rawPixels,
              previewBlob: analysis.previewBlob,
            });
          } catch (thumbnailError) {
            // The edit is already persisted; a thumbnail failure must not
            // incorrectly count the whole optimization as failed.
            console.warn(`[BatchAutoOptimize] thumbnail for ${photo.name} failed:`, thumbnailError);
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          failed++;
          console.error(`[BatchAutoOptimize] ${photo.name} failed:`, error);
        }

        estimator.record(type, performance.now() - startedAt);
        done++;
        const remaining = queue.slice(index + 1);
        setBatchAutoStatus((previous) => previous ? {
          ...previous,
          done,
          failed,
          embeddedJpeg,
          currentName: remaining[0]?.name ?? null,
          etaMs: remaining.length > 0
            ? estimator.estimateRemaining(remaining.map(autoOptimizeFileType))
            : 0,
        } : previous);

        // Give React a paint opportunity between source decodes.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    } finally {
      const cancelled = batchAutoCancelRef.current;
      batchAutoRunningRef.current = false;
      if (batchAutoControllerRef.current === controller) {
        batchAutoControllerRef.current = null;
      }
      setBatchAutoStatus((previous) => previous ? {
        ...previous,
        done,
        failed,
        embeddedJpeg,
        currentName: null,
        etaMs: 0,
        running: false,
        cancelRequested: false,
        cancelled,
      } : previous);
      refreshPhotos();
    }
  }, [ensureContentHash, refreshPhotos, repos]);

  const performSourceDelete = useCallback(async (toDelete: PhotoView[]) => {
    setDeleting(true);
    setDeleteProgress({ done: 0, total: toDelete.length });
    const CHUNK = 50;
    try {
      const bySource = new Map<string, PhotoView[]>();
      for (const p of toDelete) {
        const list = bySource.get(p.sourceId) ?? [];
        list.push(p);
        bySource.set(p.sourceId, list);
      }
      const deletedPhotoIds: number[] = [];
      const failures: string[] = [];
      let progressDone = 0;

      for (const [sourceId, group] of bySource) {
        const source = sourceManager.get(sourceId);
        if (!source || !source.deletePhotos) {
          failures.push(`${source?.label ?? sourceId}: ${t('errors.deleteNotSupported')}`);
          progressDone += group.length;
          setDeleteProgress({ done: progressDone, total: toDelete.length });
          continue;
        }
        // Chunk per source so progress + UI feedback updates frequently for large batches.
        for (let i = 0; i < group.length; i += CHUNK) {
          const chunk = group.slice(i, i + CHUNK);
          const refs = chunk.map((p) => ({
            sourceId: p.sourceId,
            sourcePhotoId: p.sourcePhotoId,
            name: p.name,
          }));
          const result = await source.deletePhotos(refs);
          const succeeded = new Set(result.succeededIds);
          for (const p of chunk) {
            if (succeeded.has(p.sourcePhotoId)) deletedPhotoIds.push(p.id!);
          }
          for (const f of result.failed) {
            failures.push(`${source.label}: ${f.sourcePhotoId} — ${f.error}`);
          }
          progressDone += chunk.length;
          setDeleteProgress({ done: progressDone, total: toDelete.length });
        }
      }

      // Remove successfully deleted photos from local index immediately.
      if (deletedPhotoIds.length > 0) {
        removePhotosFromIndex(deletedPhotoIds);
        setSelectedIds(new Set());
      }
      if (failures.length > 0) {
        const head = t('errors.deletePartialHeader');
        const more = failures.length > 10 ? '\n' + t('errors.deletePartialMore', { count: failures.length - 10 }) : '';
        alert(`${head}\n${failures.slice(0, 10).join('\n')}${more}`);
      }

      // Re-scan touched sources so the local index reflects the server state
      // (catches ghost rows, picks up any side-effects, etc.).
      for (const sourceId of bySource.keys()) {
        try { await rescanSource(sourceId); } catch { /* best-effort */ }
      }
    } finally {
      setDeleting(false);
      setDeleteProgress(null);
      setPendingDelete(null);
    }
  }, [removePhotosFromIndex, rescanSource, t]);

  /**
   * User-triggered reconciliation with a source. Unlike the periodic sync this
   * walks the full listing and drops photos the source no longer has, which is
   * how deletions made outside UnifyRAW reach the library.
   */
  const handleRefreshSource = useCallback(async (sourceId: string) => {
    const label = sources.find((s) => s.id === sourceId)?.label ?? sourceId;
    try {
      const result = await refreshSourceFull(sourceId);
      if (!result) {
        toast.push({ kind: 'warning', message: t('sources.refreshUnavailable', { source: label }) });
        return;
      }
      // A part the user can act on gets named: an album the server carries
      // without a name is skipped whole, and nothing tells them so otherwise.
      // Photos this walk took back in are named on the same toast - a second
      // one would push the first off the screen.
      toast.push({
        kind: result.complete ? 'info' : 'warning',
        message: refreshToastMessage(t, label, {
          added: result.added,
          removed: result.removed,
          revived: result.revived,
          complete: result.complete,
          namelessAlbums: countAlbumsWithoutName(result.skipped),
          failedParts: countFailedParts(result.skipped),
        }),
      });
    } catch (error) {
      toast.push({
        kind: 'error',
        message: t('sources.refreshFailed', {
          source: label,
          error: error instanceof Error ? error.message : String(error),
        }),
      });
    }
  }, [refreshSourceFull, sources, t, toast]);

  // ─── Sidecar management ───
  const sidecar = useSidecarManager(sources, photos, dialogs.showSettings);


  const handleMultiSelectToggle = useCallback(() => {
    setMultiSelect((prev) => {
      if (prev) setSelectedIds(new Set());
      return !prev;
    });
  }, []);

  const toggleSourceVisibility = useCallback((id: string) => {
    setHiddenSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, [setHiddenSources]);

  /**
   * Take photos out of the catalog. The row is only soft-deleted, so the toast
   * can hand the removal back for ten seconds and a rescan of the source
   * revives whatever it still lists.
   */
  const removeFromCatalog = useCallback((ids: number[]) => {
    if (ids.length === 0) return;
    removePhotosFromIndex(ids);
    setSelectedIds(new Set());
    setMultiSelect(false);
    toast.push({
      kind: 'info',
      message: t('library.removedFromCatalog', { count: ids.length }),
      timeoutMs: REMOVE_UNDO_MS,
      action: { label: t('common.undo'), onClick: () => restorePhotosToIndex(ids) },
    });
  }, [removePhotosFromIndex, restorePhotosToIndex, t, toast]);

  // One photo goes immediately, with the undo toast as the way back; from two
  // upwards the question comes first, because Ctrl+A and one Backspace would
  // otherwise empty the visible library in a single keystroke.
  const requestRemoveFromCatalog = useCallback((ids: number[]) => {
    if (ids.length === 0) return;
    if (ids.length === 1) { removeFromCatalog(ids); return; }
    setPendingRemove({ ids });
  }, [removeFromCatalog]);

  // Global keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Global library shortcuts must never consume text-entry keystrokes.
      // This is especially important for the compact phone search, where
      // rating/flag keys (0-9, P, X, U, ...) are ordinary query characters.
      const target = e.target;
      if (
        target instanceof HTMLElement
        && (
          target.matches('input, textarea, select')
          || target.isContentEditable
          || target.closest('[contenteditable]:not([contenteditable="false"])')
        )
      ) return;

      // Export shortcut: Ctrl+Shift+E
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'e') {
        e.preventDefault();
        dialogs.openExport();
        return;
      }

      if (view !== 'grid') return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
        e.preventDefault();
        setSelectedIds(new Set(filteredPhotos.map((p) => p.id!)));
        setMultiSelect(true);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIds.size > 0 && !e.metaKey) {
        e.preventDefault();
        requestRemoveFromCatalog(Array.from(selectedIds));
      }
      if (e.key === 'Escape') {
        setSelectedIds(new Set());
        setMultiSelect(false);
      }
      if (selectedIds.size > 0 && !e.metaKey && !e.ctrlKey && '012345'.includes(e.key)) {
        e.preventDefault();
        rateSelection(Array.from(selectedIds), Number(e.key));
      }
      if (selectedIds.size > 0 && !e.metaKey && !e.ctrlKey) {
        if (e.key === 'b' || e.key === 'B') { e.preventDefault(); toggleQuickCollection(Array.from(selectedIds)); }
        if (e.key === 'p' || e.key === 'P') { e.preventDefault(); flagSelection(Array.from(selectedIds), 'pick'); }
        if (e.key === 'x' || e.key === 'X') { e.preventDefault(); flagSelection(Array.from(selectedIds), 'reject'); }
        if (e.key === 'u' || e.key === 'U') { e.preventDefault(); flagSelection(Array.from(selectedIds), null); }
      }
      if (selectedIds.size > 0 && !e.metaKey && !e.ctrlKey) {
        const labelMap = { '6': 'red', '7': 'yellow', '8': 'green', '9': 'blue' } as const;
        if (e.key in labelMap) { e.preventDefault(); labelSelection(Array.from(selectedIds), labelMap[e.key as keyof typeof labelMap]); }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view, filteredPhotos, selectedIds, requestRemoveFromCatalog, rateSelection, flagSelection, labelSelection, toggleQuickCollection, dialogs]);

  const handleRemoveSelected = useCallback(() => {
    requestRemoveFromCatalog(Array.from(selectedIds));
  }, [selectedIds, requestRemoveFromCatalog]);

  const handleAddSource = useCallback(() => {
    dialogs.openAddSource();
  }, [dialogs]);

  const handleAddLocal = useCallback(async () => {
    // Try File System Access API first (Chrome/Edge)
    if (hasNativeFSAccess()) {
      try {
        const added = await addLocalSource();
        if (added) return; // Success — don't fall through
      } catch {
        // User cancelled or permission denied — fall through to input
      }
    }
    // Fallback: webkitdirectory input (works everywhere)
    folderInputRef.current?.click();
  }, [addLocalSource]);

  const handleAddImmich = useCallback(async (
    serverUrl: string,
    apiKey: string,
    label: string,
    albumIds?: string[],
    transport?: import('./platform/sourceTransport').SourceTransportMode,
  ) => {
    return await addImmichSource({ serverUrl, apiKey, albumIds, transport }, label);
  }, [addImmichSource]);

  const handleAddImmichV3 = useCallback(async (
    serverUrl: string,
    apiKey: string,
    label: string,
    albumIds?: string[],
    transport?: import('./platform/sourceTransport').SourceTransportMode,
  ) => {
    return await addImmichV3Source({ serverUrl, apiKey, albumIds, transport }, label);
  }, [addImmichV3Source]);

  const handleAddPhotoLibLibrary = useCallback(async (
    request: import('@photolib/shared').CreatePhotoLibraryRequest,
    files: File[],
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
  ) => addPhotoLibLibrarySource(request, files, onProgress, signal), [addPhotoLibLibrarySource]);

  // Source handlers for all provider types
  const handleAddServerPath = useCallback(async (serverUrl: string, rootPath: string, label: string) => {
    const source = await (await import('./sources')).sourceManager.addServerPathSource({ serverUrl, rootPath }, label);
    if (!source) return false;
    await refreshPhotos();
    return true;
  }, [refreshPhotos]);

  const handleAddWebDAV = useCallback(async (
    url: string,
    username: string,
    password: string,
    label: string,
    transport?: import('./platform/sourceTransport').SourceTransportMode,
    selectedPaths?: string[],
  ) => {
    return await addWebDAVSource({
      url,
      username,
      password,
      transport,
      selectedPaths,
    }, label);
  }, [addWebDAVSource]);

  const handleAddS3 = useCallback(async (endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string, region: string, prefix: string, label: string) => {
    const source = await (await import('./sources')).sourceManager.addS3Source({ endpoint, bucket, accessKeyId, secretAccessKey, region, prefix }, label);
    if (!source) return false;
    await refreshPhotos();
    return true;
  }, [refreshPhotos]);

  const handleAddDropbox = useCallback(async (accessToken: string, rootPath: string, label: string) => {
    const source = await (await import('./sources')).sourceManager.addDropboxSource({ accessToken, rootPath }, label);
    if (!source) return false;
    await refreshPhotos();
    return true;
  }, [refreshPhotos]);

  const handleAddGoogleDrive = useCallback(async (accessToken: string, folderId: string, label: string) => {
    const source = await (await import('./sources')).sourceManager.addGoogleDriveSource({ accessToken, folderId }, label);
    if (!source) return false;
    await refreshPhotos();
    return true;
  }, [refreshPhotos]);

  const handleAddGeneric = useCallback(async (type: string, config: Record<string, string>, label: string) => {
    const sm = (await import('./sources')).sourceManager;
    const source = await sm.addSourceByType(type, config, label);
    if (!source) return false;
    await refreshPhotos();
    await scanSource(source);
    return true;
  }, [refreshPhotos, scanSource]);

  const handleFolderInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) addLocalSourceFromFiles(files);
    e.target.value = '';
  }, [addLocalSourceFromFiles]);

  // The originals an export would render. The dialog reads the same list for
  // its 16-bit offer, so it can never offer a depth the export cannot deliver.
  const exportTargets = useMemo(() => (
    view === 'editor' && selectedPhoto
      ? [selectedPhoto]
      : filteredPhotos.filter((p) => selectedIds.has(p.id!))
  ), [view, selectedPhoto, filteredPhotos, selectedIds]);

  const canExport16Bit = useMemo(() => canExportAllAt16Bit(exportTargets), [exportTargets]);

  // The dialog prices its estimate on the same originals it offers depths for.
  const exportTargetSizes = useMemo(
    () => exportTargets.map((photo) => ({ width: photo.width, height: photo.height })),
    [exportTargets],
  );

  // Can this selection be written back to its source? Asked about the exact
  // photos the export would push, so the grid selection gets the same answer
  // as the open photo. The rules live in decidePushToSource; here we only say
  // what one source id means.
  const pushToSourceCaps = useMemo(() => decidePushToSource(exportTargets, (sourceId) => {
    const src = sourceManager.get(sourceId);
    if (!src) return null;
    return {
      writable: typeof src.exportAsset === 'function' && !!src.exportCapabilities?.canWrite,
      label: src.label,
      allowedFormats: src.exportCapabilities?.allowedFormats,
    };
  }), [exportTargets]);

  // ─── Leaving the editor with an edit the source has never seen ───
  //
  // Every exit out of the editor is funnelled through requestLeaveEditor, so
  // the question exists once. What it asks is decided by
  // shouldWarnUnexportedEdit (src/export/unexportedEdit.ts); the facts come
  // from the export ledger, which is the only record of what left the app.
  const pendingLeaveRef = useRef<(() => void) | null>(null);

  const requestLeaveEditor = useCallback((leave: () => void) => {
    if (view !== 'editor' || !selectedPhoto) { leave(); return; }
    const hash = contentHash ?? selectedPhoto.contentHash ?? null;
    if (!hash) { leave(); return; }
    void (async () => {
      // The edit row lands 500 ms after the last change, so the open history
      // is what carries "edited and left again straight away".
      const hasEdit = !!repos.edits.getCopy(hash, copyIndex) || history.length > 0;
      const lastExport = repos.exports.latestFor(hash, copyIndex, selectedPhoto.sourceId);
      let stackHash: string | null = null;
      if (hasEdit) {
        try {
          stackHash = await editStackHash(editStackFingerprint(photoDocument, adjustments));
        } catch { stackHash = null; }
      }
      const warn = shouldWarnUnexportedEdit({
        reminderEnabled: uiPrefs.prefs.exportReminder,
        sourceWritable: pushToSourceCaps.canPush,
        hasEdit,
        editStackHash: stackHash,
        lastExportedStackHash: lastExport?.editStackHash ?? null,
      });
      if (!warn) { leave(); return; }
      pendingLeaveRef.current = leave;
      dialogs.openUnexportedEdit();
    })();
  }, [
    adjustments, contentHash, copyIndex, dialogs, history.length, photoDocument,
    pushToSourceCaps.canPush, repos, selectedPhoto, uiPrefs.prefs.exportReminder, view,
  ]);

  const handleBack = useCallback(
    () => requestLeaveEditor(leaveEditor),
    [leaveEditor, requestLeaveEditor],
  );

  /** Sidebar and drawer navigation: away from the editor counts as leaving. */
  const handleViewChange = useCallback((nextView: ViewMode) => {
    const go = () => { setView(nextView); setNavigationDrawerOpen(false); };
    if (nextView === 'editor') { go(); return; }
    requestLeaveEditor(go);
  }, [requestLeaveEditor, setView]);

  /** The modal's three answers, plus its "do not ask again" box. */
  const dismissLeavePrompt = useCallback((): (() => void) | null => {
    dialogs.closeUnexportedEdit();
    const leave = pendingLeaveRef.current;
    pendingLeaveRef.current = null;
    return leave;
  }, [dialogs]);

  // Map UI format → exportAsset format (webp is not allowed on source, falls back to jpg).
  const exportFormatForSource = (f: ExportOptions['format']): 'jpg' | 'tif' | 'png' | 'dng' => {
    if (f === 'png') return 'png';
    if (f === 'tiff') return 'tif';
    if (f === 'dng') return 'dng';
    return 'jpg';
  };

  /**
   * Everything a render of one photo needs, collected once.
   *
   * Export and print both start here, so a printed photo is the same picture
   * as an exported one: its own stored document (not the open editor's), its
   * camera base development, its lens profile, and for a RAW the native
   * 16-bit pixels. The colour space stays the caller's choice - the export
   * dialog offers one, a print is always sRGB.
   *
   * `wantBits` is what the caller intends to WRITE, not what it gets: only a
   * 16-bit export makes the HEIF branch below read the original again. A RAW
   * takes its 16-bit route regardless, because its 8-bit renders come out of
   * the same linear pixels.
   */
  const collectRenderInput = useCallback(async (
    photo: PhotoView,
    maxLongEdge: number | null = null,
    wantBits: 8 | 16 = 8,
  ): Promise<Omit<RenderPhotoInput, 'colorSpace'> | null> => {
    const url = await getDisplayUrl(photo);
    if (!url) return null;

    const { adjustments: adj, document: doc } = exportEditsFor(
      photo,
      { photoId: selectedPhoto?.id, adjustments, document: photoDocument },
      (hash) => repos.edits.getMaster(hash),
    );

    const bound = capRenderLongEdge(maxLongEdge, photo.width, photo.height);

    // RAW photos: load 16-bit pixel data so the render keeps highlight
    // headroom. Unbounded (the export) that is the native sensor resolution;
    // bounded (a print cell) it is the one loading ladder at exactly that
    // size, which a cached preview can answer without decoding 61 MP again.
    // Falls back silently to the URL-based path if the RAW route isn't
    // available or fails.
    let fullResRaw = null;
    const { RawDecoder } = await import('./engine/RawDecoder');
    if (RawDecoder.isRawFile(photo.name)) {
      try {
        const { sourceManager } = await import('./sources');
        const src = sourceManager.get(photo.sourceId);
        const ref = { sourcePhotoId: photo.sourcePhotoId, sourceId: photo.sourceId, name: photo.name };
        if (src && bound === null) {
          const file = await src.getFile(ref);
          if (file) {
            const { loadFullResRawPixels } = await import('./engine/raw');
            const cacheKey = makeRawCacheKey(photo);
            fullResRaw = await loadFullResRawPixels(file, cacheKey, src.type);
          }
        } else if (src && bound !== null) {
          const { loadRawPixels } = await import('./engine/raw');
          // The file is a loader, not a File: the ladder only reaches for it
          // once every cheaper rung has missed.
          const decoded = await loadRawPixels({
            identity: photo,
            size: bound,
            sourceType: src.type,
            wantPreview: false,
            file: (signal) => src.getFile(ref, signal),
          });
          fullResRaw = decoded?.rawPixels ?? null;
        }
      } catch (e) {
        console.warn('[render] RAW pixel load failed, using URL fallback:', e);
      }
    } else if (wantBits === 16 && bound === null && HeifDecoder.isHeifFile(photo.name)) {
      // A HEIC carries up to 10 bits, and only the file itself still has
      // them: `url` is the 8-bit display blob the editor made. This is the
      // one non-RAW source that can feed the 16-bit exporter at all.
      try {
        const src = sourceManager.get(photo.sourceId);
        const file = await src?.getFile({
          sourcePhotoId: photo.sourcePhotoId,
          sourceId: photo.sourceId,
          name: photo.name,
        });
        if (file) {
          const { loadFullResHeifPixels } = await import('./engine/raw');
          fullResRaw = await loadFullResHeifPixels(file);
        }
      } catch (e) {
        console.warn('[render] HEIF 16-bit load failed, falling back to 8 bit:', e);
      }
    }

    return {
      imageUrl: url,
      adjustments: adj,
      document: doc,
      baseAdjustments: baseAdjustmentsFor(photo),
      lensProfile: lensCoefficientsFor(photo),
      fullResRaw,
      // The 16-bit path renders at the pixels it was handed; this bounds the
      // <img> path, which every non-RAW photo takes.
      maxWidth: bound ?? undefined,
      maxHeight: bound ?? undefined,
    };
  }, [getDisplayUrl, selectedPhoto?.id, adjustments, photoDocument, repos]);

  /**
   * One photo, rendered for the print page. sRGB because both the preview
   * canvas and the print window's data URL are read back as sRGB.
   *
   * `maxLongEdge` is the dialog's resolution choice: the pixels the cell on
   * the paper can show, or null for the photo's native pixels. Printing
   * always native made a 61-MP photo a 241 MB frame, and the dialog holds
   * every frame until it closes.
   */
  const renderForPrint = useCallback(async (
    photo: PhotoView,
    maxLongEdge: number | null,
  ): Promise<RenderedFrame> => {
    const input = await collectRenderInput(photo, maxLongEdge);
    if (!input) throw new Error(`No display URL for ${photo.name}`);
    try {
      return await renderPhoto({ ...input, colorSpace: 'srgb' });
    } finally {
      if (input.imageUrl.startsWith('blob:')) URL.revokeObjectURL(input.imageUrl);
    }
  }, [collectRenderInput]);

  // Export handler
  const handleExport = useCallback(async (options: ExportOptions & { exportXmp?: boolean; destination?: ExportDestination }) => {
    if (exportTargets.length === 0) return;

    dialogs.setExporting(true);
    dialogs.setExportProgress({ done: 0, total: exportTargets.length });

    for (let i = 0; i < exportTargets.length; i++) {
      const photo = exportTargets[i];
      try {
        const input = await collectRenderInput(photo, null, options.bitDepth ?? 8);
        if (!input) continue;
        const { imageUrl: url, adjustments: adj, document: doc } = input;

        // transferRaw: the 16-bit buffer is not read again after this call,
        // so the render worker may take it rather than get a copy (F132).
        const onExportWarning = (warning: ExportWarning) => {
          options.onWarning?.(warning);
          toast.push(exportWarningToast(warning, t));
        };
        // The dialog offers 16 bit from what the FILE can hold; this is where
        // that meets the pixels a decoder actually produced. A HEIF that
        // stayed 8-bit is exported at 8 bit and says so; everything else keeps
        // the exporter's hard error.
        const depth = planExportDepth({
          requested: options.bitDepth,
          pixels: input.fullResRaw,
          mayFallBack: HeifDecoder.isHeifFile(photo.name),
        });
        if (depth.warning) onExportWarning(depth.warning);
        // The hash identifies what was RENDERED, so it follows the document
        // (layers, masks, preset looks), not the flattened adjustments. It
        // names the file for a source export AND goes into the file itself.
        const fullHash = await editStackHash(editStackFingerprint(doc, adj));
        // Only a checksum that is already known: reading the original just to
        // stamp it would turn every download into a full fetch. Unknown means
        // the field is absent, not wrong.
        const knownContentHash = photo.contentHash
          ?? (photo.id === selectedPhoto?.id ? contentHash : null);
        const { adjustmentsToXMP, originalSourceUri } = await import('./data/xmp');
        const blob = await exportPhoto(
          url, adj, {
            ...options,
            bitDepth: depth.bitDepth,
            transferRaw: true,
            onWarning: onExportWarning,
            metadata: {
              dateTaken: photo.dateTaken,
              software: getBrand().name,
              xmp: adjustmentsToXMP(adj, {
                source: originalSourceUri(photo.sourceId, photo.sourcePhotoId),
                editStackHash: fullHash,
                originalChecksum: knownContentHash,
              }),
            },
          }, input.fullResRaw, doc,
          input.baseAdjustments, input.lensProfile,
        );

        if (options.destination === 'source') {
          const src = sourceManager.get(photo.sourceId);
          if (!src?.exportAsset) {
            console.warn('[export→source] source has no exportAsset:', photo.sourceId);
          } else {
            const fmt = exportFormatForSource(options.format);
            const filename = buildExportFilename(photo.name, fmt, shortEditStackHash(fullHash));
            const exportContentHash = knownContentHash ?? await ensureContentHash(photo);
            if (!exportContentHash) throw new Error(`Could not identify ${photo.name}`);
            const exportAsset = src.exportAsset.bind(src);
            const result = await retryExport(() => exportAsset({
              original: { sourcePhotoId: photo.sourcePhotoId, sourceId: photo.sourceId, name: photo.name },
              renderedBlob: blob,
              format: fmt,
              filename,
              editStackHash: fullHash,
            }));
            repos.exports.record({
              contentHash: exportContentHash,
              copyIndex: photo.id === selectedPhoto?.id ? copyIndex : 0,
              targetSourceId: photo.sourceId,
              targetAssetId: result.assetId,
              targetUrl: result.url ?? null,
              format: fmt,
              editStackHash: fullHash,
              filename,
              bytes: blob.size,
              status: 'ok',
              uploadedAt: Date.now(),
              deletedAt: null,
            });
          }
        } else {
          const fileName = generateFileName(photo.name, options.fileNameTemplate, options.format);
          // Browser: the same download as before. Capacitor shell: written and
          // offered to the share sheet, because an <a download> click inside a
          // WebView leaves the file where the user cannot reach it
          // (platform/nativeShell.ts).
          await deliverFile(blob, fileName);
        }

        // XMP sidecar
        if (options.exportXmp) {
          const { downloadXMP } = await import('./data/xmp');
          await downloadXMP(adj, photo.name);
        }

        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      } catch (e) {
        if (isExportError(e)) {
          toast.push(exportErrorToast(e, (key) => t(key), () => dialogs.openSettings('sources')));
        } else {
          toast.push({
            title: t('dialogs.export.errors.title'),
            message: t('dialogs.export.errors.unknown'),
            kind: 'error',
          });
        }
      }
      dialogs.setExportProgress({ done: i + 1, total: exportTargets.length });
    }

    dialogs.setExporting(false);
    dialogs.closeExport();
  }, [exportTargets, selectedPhoto, collectRenderInput, dialogs, contentHash, copyIndex, ensureContentHash, repos, t, toast]);

  // Get file for EXIF reading in editor
  const getFile = useCallback(async (
    photo: PhotoView,
    signal?: AbortSignal,
  ): Promise<File | null> => {
    const source = (await import('./sources')).sourceManager.get(photo.sourceId);
    if (!source) return null;
    return source.getFile({
      sourcePhotoId: photo.sourcePhotoId,
      sourceId: photo.sourceId,
      name: photo.name,
    }, signal);
  }, []);

  // The editor hides the sidebar for screen real estate, but without a photo
  // there would be no navigation left at all — keep it as the way back.
  const showSidebar = view !== 'editor' || !selectedPhoto;
  const compactNavigation = adaptiveLayout.screen !== 'desktop' && showSidebar;

  useEffect(() => {
    if (adaptiveLayout.screen === 'desktop' || !showSidebar) setNavigationDrawerOpen(false);
  }, [adaptiveLayout.screen, showSidebar]);

  const openNavigationDrawer = useCallback((section: NavigationSection) => {
    setNavigationDrawerSection(section);
    setNavigationDrawerOpen(true);
  }, []);
  const closeNavigationDrawer = useCallback(() => setNavigationDrawerOpen(false), []);

  const sourceContextValue = useMemo(() => ({
    sources,
    getDisplayUrl,
    getFile,
    scanning,
    disconnectedIds,
    reconnectSource,
  }), [sources, getDisplayUrl, getFile, scanning, disconnectedIds, reconnectSource]);

  const settingsContextValue = useMemo(() => ({
    histogramStyle,
    setHistogramStyle,
  }), [histogramStyle, setHistogramStyle]);

  return (
    <SourceProvider value={sourceContextValue}>
    <SettingsProvider value={settingsContextValue}>
    <RawPairProvider value={rawPairIndex}>
    <StackProvider value={stackContextValue}>
    <div
      className={`app app-${adaptiveLayout.screen} ${adaptiveLayout.primaryInput === 'touch' ? 'app-touch' : 'app-pointer'}`}
      data-testid="adaptive-app-shell"
    >
      {showSidebar && adaptiveLayout.screen === 'desktop' && <Sidebar
        view={view}
        onViewChange={setView}
        photoCount={photos.length}
        sources={sources}
        onAddSource={handleAddSource}
        onRescanSource={handleRefreshSource}
        onToggleSourceVisibility={toggleSourceVisibility}
        hiddenSources={hiddenSources}
        scanning={scanning}
        photoCountBySource={photoCountBySource}
        folderTree={folderTree}
        folderFilter={folderFilter}
        onFolderFilterChange={setFolderFilter}
        collections={collections}
        activeCollectionId={activeCollectionId}
        onSelectCollection={setActiveCollectionId}
        onAddCollection={addCollection}
        onDeleteCollection={deleteCollection}
        onRenameCollection={renameCollection}
        onUpdateSmartRules={updateSmartRules}
        disconnectedIds={disconnectedIds}
        onReconnectSource={reconnectSource}
        presets={presets}
        onApplyPreset={(preset) => {
          const targets = selectedPhotos.length > 0 ? selectedPhotos : (selectedPhoto ? [selectedPhoto] : []);
          if (targets.length > 0) {
            void fanOutDocumentChange(
              (document) => applyPresetAsLayer(document, preset, DEFAULT_PRESET_STRENGTH),
              targets,
            );
          }
        }}
        onSavePreset={(name, cat) => savePreset(name, adjustments, cat)}
        onDeletePreset={deletePreset}
        onExportPreset={(p) => {
          const blob = new Blob([exportPreset(p)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = `${p.name}.json`; a.click();
          URL.revokeObjectURL(url);
        }}
        onImportPreset={importPreset}
        onOpenBench={() => setBenchOpen(true)}
        onShowAbout={() => dialogs.openAbout()}
        onShowSettings={() => dialogs.openSettings()}
      />}

      {compactNavigation && (
        <AdaptiveNavigation
          screen={adaptiveLayout.screen as 'phone' | 'tablet'}
          photoCount={photos.length}
          drawerOpen={navigationDrawerOpen}
          drawerSection={navigationDrawerSection}
          onOpenDrawer={openNavigationDrawer}
          onCloseDrawer={closeNavigationDrawer}
          phoneChromeHidden={phoneTopbarHidden}
          phoneLibrary={adaptiveLayout.screen === 'phone' && view === 'grid' ? {
            title: libraryContextTitle,
            totalCount: photos.length,
            filteredCount: filteredPhotos.length,
            search,
            onSearchChange: setSearch,
            sort,
            onSortChange: setSort,
            gridMode,
            onGridModeChange: setGridMode,
            groupMode,
            onGroupModeChange: setGroupMode,
            tileSize,
            onTileSizeChange: setTileSize,
            libraryViewMode,
            onLibraryViewModeChange: (mode) => {
              setLibraryViewMode(mode);
              setPhoneTopbarHidden(false);
            },
            multiSelect,
            selectedCount: selectedIds.size,
            onMultiSelectToggle: () => {
              setPhoneTopbarHidden(false);
              handleMultiSelectToggle();
            },
            onExport: () => dialogs.openExport(),
            onRemoveSelected: handleRemoveSelected,
            showOriginals,
            onToggleOriginals: () => setShowOriginals((previous) => !previous),
            onSyncAdjustments: selectedIds.size > 0 && contentHash ? syncAdjustmentsToSelected : undefined,
            onPrint: handlePrint,
            onSlideshow: () => dialogs.openSlideshow(),
            onSetRating: (rating) => rateSelection(Array.from(selectedIds), rating),
            onSetFlag: (flag) => flagSelection(Array.from(selectedIds), flag),
            onSetColorLabel: (colorLabel) => labelSelection(Array.from(selectedIds), colorLabel),
            pairRawJpeg,
            onPairRawJpegToggle: () => setPairRawJpeg((previous) => !previous),
            ratingFilter,
            onRatingFilterChange: setRatingFilter,
            flagFilter,
            onFlagFilterChange: setFlagFilter,
            labelFilter,
            onLabelFilterChange: setLabelFilter,
            availabilityFilter,
            onAvailabilityFilterChange: setAvailabilityFilter,
            keywordFilter,
            onKeywordFilterChange: setKeywordFilter,
            cameraFilter,
            onCameraFilterChange: setCameraFilter,
            cameras,
            lensFilter,
            onLensFilterChange: setLensFilter,
            lenses,
          } : undefined}
          sidebar={
            <Sidebar
              view={view}
              onViewChange={handleViewChange}
              photoCount={photos.length}
              sources={sources}
              onAddSource={() => { setNavigationDrawerOpen(false); handleAddSource(); }}
              onRescanSource={handleRefreshSource}
              onToggleSourceVisibility={toggleSourceVisibility}
              hiddenSources={hiddenSources}
              scanning={scanning}
              photoCountBySource={photoCountBySource}
              folderTree={folderTree}
              folderFilter={folderFilter}
              onFolderFilterChange={(path) => { setFolderFilter(path); setNavigationDrawerOpen(false); }}
              collections={collections}
              activeCollectionId={activeCollectionId}
              onSelectCollection={(id) => { setActiveCollectionId(id); setNavigationDrawerOpen(false); }}
              onAddCollection={addCollection}
              onDeleteCollection={deleteCollection}
              onRenameCollection={renameCollection}
              onUpdateSmartRules={updateSmartRules}
              disconnectedIds={disconnectedIds}
              onReconnectSource={reconnectSource}
              presets={presets}
              onApplyPreset={(preset) => {
                const targets = selectedPhotos.length > 0 ? selectedPhotos : (selectedPhoto ? [selectedPhoto] : []);
                if (targets.length > 0) {
                  void fanOutDocumentChange(
                    (document) => applyPresetAsLayer(document, preset, DEFAULT_PRESET_STRENGTH),
                    targets,
                  );
                }
              }}
              onSavePreset={(name, cat) => savePreset(name, adjustments, cat)}
              onDeletePreset={deletePreset}
              onExportPreset={(p) => {
                const blob = new Blob([exportPreset(p)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a'); a.href = url; a.download = `${p.name}.json`; a.click();
                URL.revokeObjectURL(url);
              }}
              onImportPreset={importPreset}
              onOpenBench={() => setBenchOpen(true)}
              onShowAbout={() => { setNavigationDrawerOpen(false); dialogs.openAbout(); }}
              onShowSettings={() => { setNavigationDrawerOpen(false); dialogs.openSettings(); }}
              focusSection={navigationDrawerSection}
            />
          }
        />
      )}

      <main className="main-content" onScrollCapture={handleLibraryScrollCapture}>
        {view === 'grid' && (
          <PanelSystem
            layout={panelLayout.layout}
            panels={PANEL_MAP}
            panelContent={libraryPanelContent}
            onTogglePanel={panelLayout.togglePanel}
            onTogglePin={panelLayout.togglePin}
            onFloatPanel={panelLayout.floatPanel}
            onDockPanel={panelLayout.dockPanel}
            onUpdateFloatingPos={panelLayout.updateFloatingPos}
            onResizeZone={panelLayout.resizeZone}
            onDropPanel={panelLayout.dropPanel}
            isLibrary
            toolbar={
              <GridToolbar
                search={search}
                onSearchChange={setSearch}
                sort={sort}
                onSortChange={setSort}
                gridMode={gridMode}
                groupMode={groupMode}
                onGroupModeChange={setGroupMode}
                multiSelect={multiSelect}
                onMultiSelectToggle={handleMultiSelectToggle}
                pairRawJpeg={pairRawJpeg}
                onPairRawJpegToggle={() => setPairRawJpeg((previous) => !previous)}
                selectedCount={selectedIds.size}
                onRemoveSelected={handleRemoveSelected}
                totalCount={photos.length}
                ratingFilter={ratingFilter}
                onRatingFilterChange={setRatingFilter}
                flagFilter={flagFilter}
                onFlagFilterChange={setFlagFilter}
                labelFilter={labelFilter}
                onLabelFilterChange={setLabelFilter}
                availabilityFilter={availabilityFilter}
                onAvailabilityFilterChange={setAvailabilityFilter}
                keywordFilter={keywordFilter}
                onKeywordFilterChange={setKeywordFilter}
                cameraFilter={cameraFilter}
                onCameraFilterChange={setCameraFilter}
                lensFilter={lensFilter}
                onLensFilterChange={setLensFilter}
                filteredCount={filteredPhotos.length}
                onExport={() => dialogs.openExport()}
                showOriginals={showOriginals}
                onToggleOriginals={() => setShowOriginals((p) => !p)}
                onSyncAdjustments={selectedIds.size > 0 && contentHash ? syncAdjustmentsToSelected : undefined}
                onPrint={handlePrint}
                onSlideshow={() => dialogs.openSlideshow()}
                cameras={cameras}
                lenses={lenses}
              />
            }
            statusBar={
              <ViewModeBar
                mode={libraryViewMode}
                onModeChange={setLibraryViewMode}
                photoCount={filteredPhotos.length}
                selectedCount={selectedIds.size}
                gridMode={gridMode}
                onGridModeChange={setGridMode}
                tileSize={tileSize}
                onTileSizeChange={setTileSize}
              />
            }
          >
            {/* Legacy "no catalog opened" banner is superseded by the Storage tab
                + FirstLaunchModal (Phase 3+4). */}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <IndexingStatus
                totalPhotos={sidecar.sidecarPhotoCount}
                cachedThumbs={sidecar.cachedThumbCount}
                blurHashCount={photos.filter((p) => !!p.blurHash).length}
                generating={sidecar.cachedThumbCount < sidecar.sidecarPhotoCount && !scanning}
                sidecarBusy={sidecar.sidecarBusy}
                scanning={scanning}
                syncing={false}
                syncError={null}
              />
            </div>
            {libraryViewMode === 'grid' ? (
              <PhotoGrid
                photos={filteredPhotos}
                selectedIds={selectedIds}
                multiSelect={multiSelect}
                getDisplayUrl={getDisplayUrl}
                gridMode={gridMode}
                groupMode={groupMode}
                tileSize={tileSize}
                gridFlow={gridFlow}
                onTileSizeChange={setTileSize}
                onSelect={handleSelect}
                onOpen={handleOpen}
                onContextMenu={handleContextMenu}
                canLoadMore={canLoadMore}
                onLoadMore={loadMore}
                scanning={scanning}
                thumbnailMode={showOriginals ? 'source' : 'auto'}
              />
            ) : (
              <LibrarySpecialView
                mode={libraryViewMode}
                photos={filteredPhotos}
                selectedPhoto={selectedPhoto}
                selectedIds={selectedIds}
                onSelect={handleSelect}
                onOpen={handleOpen}
                getDisplayUrl={getDisplayUrl}
              />
            )}
          </PanelSystem>
        )}
        {view === 'editor' && selectedPhoto && (
          <Suspense fallback={<div className="app-splash"><span>{t('app.splash.opening')}</span></div>}>
            <PhotoEditor
            key={selectedPhoto.id}
            photo={selectedPhoto}
            pairPartner={editorPairPartner}
            onSwitchPairPartner={openPhotoInEditor}
            adjustments={adjustments}
            photoDocument={photoDocument}
            onDocumentChange={setPhotoDocument}
            onAdjustmentsChange={setAdjustments}
            onBack={handleBack}
            saving={saving}
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={undo}
            onRedo={redo}
            history={history}
            restoreToIndex={restoreToIndex}
            presets={presets}
            activePresetSyncId={findPresetLayer(photoDocument)?.presetSyncId ?? null}
            presetStrength={Math.round((findPresetLayer(photoDocument)?.opacity ?? 1) * 100)}
            onApplyPreset={(preset, strength) => setPhotoDocument((prev) => applyPresetAsLayer(prev, preset, strength))}
            onPresetStrengthChange={(strength) => setPhotoDocument((prev) => setPresetLayerStrength(prev, strength))}
            onSavePreset={(name, cat, groups) => {
              savePreset(name, adjustmentsForPanels(adjustments, groups) as Adjustments, cat);
            }}
            onDeletePreset={deletePreset}
            onExportPreset={(p) => {
              const json = exportPreset(p);
              const blob = new Blob([json], { type: 'application/json' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a'); a.href = url; a.download = `${p.name}.json`; a.click();
              URL.revokeObjectURL(url);
            }}
            onImportPreset={importPreset}
            onExport={() => dialogs.openExport()}
            photos={filteredPhotos}
            onSelectPhoto={handleEditorPhotoChange}
            onFileLoaded={async (p, file) => {
              if (p.contentHash) return; // Already have hash
              perfLog.mark('image-load', 'ensureContentHash start (reusing file)');
              const hash = await ensureContentHash(p, file);
              perfLog.mark('image-load', 'ensureContentHash done');
              if (hash) {
                setContentHash(hash);
                refreshPhotos();
              }
            }}
            onSourceBitsMeasured={(p, bits) => {
              if (!p.id || p.sourceBits === bits) return;
              repos.photos.update(p.id, { sourceBits: bits });
              refreshPhotos();
            }}
            />
          </Suspense>
        )}
        {view === 'editor' && !selectedPhoto && (
          <div className="no-selection">
            <span>{t('app.selectFromLibrary')}</span>
            <button onClick={handleBack}>{t('app.library')}</button>
          </div>
        )}
      </main>

      <StaleAssetBanner />
      <CatalogReadOnlyBanner />
      {hasOpenDialog && (
        <Suspense fallback={null}>
          <AppDialogs
        dialogs={dialogs}
        onAddLocal={handleAddLocal}
        onAddImmich={handleAddImmich}
        onAddImmichV3={handleAddImmichV3}
        onAddServerPath={handleAddServerPath}
        onAddWebDAV={handleAddWebDAV}
        onAddS3={handleAddS3}
        onAddDropbox={handleAddDropbox}
        onAddGoogleDrive={handleAddGoogleDrive}
        onAddGeneric={handleAddGeneric}
        onAddPhotoLibLibrary={handleAddPhotoLibLibrary}
        onExport={handleExport}
        onRenderPrintTarget={renderForPrint}
        exportSelectedCount={view === 'editor' ? 1 : selectedIds.size}
        canExport16Bit={canExport16Bit}
        canPushToSource={pushToSourceCaps.canPush}
        pushBlockedReason={pushToSourceCaps.canPush ? undefined : pushToSourceCaps.reason}
        sourceLabel={pushToSourceCaps.canPush ? pushToSourceCaps.label : undefined}
        onLeaveWithoutExport={() => dismissLeavePrompt()?.()}
        onExportBeforeLeaving={() => {
          // Exporting is not leaving: the pending exit is dropped and the
          // dialog opens on the source. Back again afterwards finds the
          // ledger current and says nothing.
          dismissLeavePrompt();
          dialogs.openExport('source');
        }}
        onCancelLeave={() => { dismissLeavePrompt(); }}
        onSuppressExportReminder={(suppressed) => uiPrefs.update({ exportReminder: !suppressed })}
        allowedSourceFormats={pushToSourceCaps.canPush ? pushToSourceCaps.allowedFormats : undefined}
        exportTargetSizes={exportTargetSizes}
        slideshowPhotos={slideshow.photos}
        slideshowStartIndex={slideshow.startIndex}
        getDisplayUrl={getDisplayUrl}
        sources={sources}
        onRemoveSource={handleRemoveSource}
        onRescanSource={handleRefreshSource}
        onOpenAddSourceFromSettings={() => { dialogs.closeSettings(); handleAddSource(); }}
        scanning={scanning}
        photoCountBySource={photoCountBySource}
        getAutoRefresh={getAutoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        autoPushMetadata={autoPushMetadata}
        onAutoPushMetadataChange={setAutoPushMetadata}
        histogramStyle={histogramStyle}
        onHistogramStyleChange={setHistogramStyle}
        gridFlow={gridFlow}
        onGridFlowChange={setGridFlow}
        uiPrefs={uiPrefs.prefs}
        onUiPrefsChange={uiPrefs.update}
        onUiPrefsReset={uiPrefs.reset}
        rawDevSelected={benchPhotos}
        rawDevProfiles={developProfiles}
        rawDevLensProfiles={lensProfiles}
        onDeleteRawDevProfile={(id) => { void deleteProfile(id); }}
        onDeleteLensProfile={(id) => { void deleteLensProfile(id); }}
        rawDevBench={rawDevBench}
        importPreset={importSettings.preset}
        onImportPresetChange={importSettings.setPreset}
        onImportPresetReset={importSettings.resetPreset}
        presetNames={presets.map((p) => p.name)}
        sidecarSources={sidecar.sidecarSources}
        sidecarBusy={sidecar.sidecarBusy}
        onRegenerateSidecarThumbs={sidecar.handleRegenerateSidecarThumbs}
        onDeleteSidecarThumbs={sidecar.handleDeleteSidecarThumbs}
        hasNativeFSSidecar={hasNativeFSAccess()}
        // Deliberately the build, not hasBackend(): these tabs describe the
        // selfhost build itself (pipeline, licence, white-label branding). A
        // backend URL entered under Settings does not turn this bundle into
        // one (AP21, decision 4).
        selfHosted={platformConfig.mode === 'hosted'}
          />
        </Suspense>
      )}

      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        multiple
        onChange={handleFolderInput}
        style={{ display: 'none' }}
      />
    {contextMenu && (() => {
      const selectionSize = selectedIds.size;
      const anchorIsSelected = selectedIds.has(contextMenu.photo.id!);
      const targets: PhotoView[] = (anchorIsSelected && selectionSize > 1)
        ? filteredPhotos.filter((p) => selectedIds.has(p.id!))
        : [contextMenu.photo];
      const targetIds = targets.map((p) => p.id!).filter((id) => id != null);
      const sm = sourceManager;
      const deleteSupported = targets.every((p) => {
        const s = sm.get(p.sourceId);
        return s ? writeCapabilitiesOf(s).canDelete : false;
      });
      const deleteLabel = targets.length === 1
        ? t('common.delete')
        : t('app.deleteSelected', { count: targets.length });
      // No render needed, so the whole selection can go at once.
      const pushSupported = targets.some((p) => canPushMetadata(sm.get(p.sourceId)));
      const pushLabel = targets.length === 1
        ? t('metadataPush.menu')
        : t('metadataPush.menuMany', { count: targets.length });
      const resetLabel = targets.length === 1
        ? t('galleryContext.resetEdits')
        : t('galleryContext.resetSelectedEdits', { count: targets.length });
      const hasEdits = targets.some((photo) =>
        !!photo.contentHash && !!repos.edits.getMaster(photo.contentHash));
      // Stacking acts on whole stacks: a folded head in the selection brings
      // the members it hides along.
      const stackTargetIds = expandAcrossStacks(targets.map((p) => p.id));
      const stackedTargets = targets.filter((p) => stackIndex.has(p.id));
      // Offering "stack these" for one existing stack would plan nothing, so
      // the entry only appears where it really merges something.
      const stackGroups = new Set(targets.map((p) => stackIndex.get(p.id)?.id ?? `photo:${p.id}`));
      const canStack = stackGroups.size > 1;
      const canSetHead = targets.length === 1
        && stackIndex.has(targets[0].id)
        && !isStackHead(targets[0].id, stackIndex);
      const stackCount = new Set(stackedTargets.map((p) => stackIndex.get(p.id)!.id)).size;
      return (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={[
            { label: t('common.open'), onClick: () => handleOpen(contextMenu.photo) },
            {
              render: (close: () => void) => (
                <PhotoMetaControls
                  count={targetIds.length}
                  onSetRating={(rating) => rateSelection(targetIds, rating)}
                  onSetFlag={(flag) => flagSelection(targetIds, flag)}
                  onSetColorLabel={(colorLabel) => labelSelection(targetIds, colorLabel)}
                  onAfterApply={close}
                />
              ),
            },
            ...(targets.length > 1 ? [{
              label: t('batchAutoOptimize.menu'),
              onClick: () => { void runBatchAutoOptimize(targets); },
            }] : []),
            {
              label: targets.length === 1
                ? t('galleryContext.addToCollection')
                : t('galleryContext.addSelectedToCollection', { count: targets.length }),
              onClick: () => setPendingCollectionAdd({ photoIds: targetIds }),
            },
            {
              label: pushLabel,
              disabled: !pushSupported,
              onClick: () => { void pushMetadataToSource(targets); },
            },
            {
              label: resetLabel,
              disabled: !hasEdits,
              onClick: () => { void resetPhotoEdits(targets); },
            },
            ...(canStack ? [{
              label: t('galleryContext.stackSelected', { count: stackTargetIds.length }),
              onClick: () => { stackPhotos(stackTargetIds); },
            }] : []),
            ...(stackCount > 0 ? [{
              label: stackCount === 1
                ? t('galleryContext.unstack')
                : t('galleryContext.unstackSelected', { count: stackCount }),
              onClick: () => { unstackPhotos(stackTargetIds); },
            }] : []),
            ...(canSetHead ? [{
              label: t('galleryContext.setStackHead'),
              onClick: () => { setStackHead(targets[0].id); },
            }] : []),
            {
              label: t('galleryContext.autoStack'),
              onClick: () => {
                const created = autoStack();
                toast.push({
                  kind: created > 0 ? 'info' : 'warning',
                  message: t('app.autoStackResult', { count: created }),
                });
              },
            },
            {
              label: deleteLabel,
              destructive: true,
              disabled: !deleteSupported,
              onClick: () => setPendingDelete({ photos: targets }),
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      );
    })()}
    {pendingDelete && (() => {
      const sources = new Set(pendingDelete.photos.map((p) => sourceManager.get(p.sourceId)?.label).filter(Boolean));
      const label = sources.size === 1 ? Array.from(sources)[0] as string : undefined;
      const moveToTrash = pendingDelete.photos.every(
        (photo) => sourceManager.get(photo.sourceId)?.type === 'photolib-library',
      );
      return (
        <ConfirmDeleteDialog
          count={pendingDelete.photos.length}
          sourceLabel={label}
          moveToTrash={moveToTrash}
          busy={deleting}
          progress={deleteProgress ?? undefined}
          onConfirm={() => performSourceDelete(pendingDelete.photos)}
          onCancel={() => setPendingDelete(null)}
        />
      );
    })()}
    {pendingRemove && (
      <ConfirmRemoveDialog
        count={pendingRemove.ids.length}
        onConfirm={() => { removeFromCatalog(pendingRemove.ids); setPendingRemove(null); }}
        onCancel={() => setPendingRemove(null)}
      />
    )}
    {pendingCollectionAdd && (
      <AddToCollectionDialog
        photoIds={pendingCollectionAdd.photoIds}
        collections={collections}
        onAdd={(collectionId) => addPhotosToCollection(collectionId, pendingCollectionAdd.photoIds)}
        onCreate={(name, parentId) => addCollection(name, 'manual', parentId ?? undefined)}
        onClose={() => setPendingCollectionAdd(null)}
      />
    )}
    {batchAutoStatus && (
      <BatchAutoOptimizeDialog
        status={batchAutoStatus}
        onCancel={cancelBatchAutoOptimize}
        onClose={() => setBatchAutoStatus(null)}
      />
    )}
    <AlignmentBench
      open={benchOpen}
      onClose={() => setBenchOpen(false)}
      title="Preset-Werkbank"
      photos={benchPhotos}
      emptyHint="Wähle in der Galerie Bilder aus — ein Preset zeigt erst an mehreren Motiven, was es tut."
      panelIds={BENCH_PRESET_PANELS}
      initiallyOpen={BENCH_PRESET_OPEN}
      adjustments={presetBenchAdjustments}
      onAdjustmentsChange={setPresetBenchAdjustments}
      saveActions={[{
        id: 'preset',
        label: 'Als Preset speichern',
        onSave: benchPhotos.length > 0 ? (adj, name) => savePreset(name, adj) : null,
        unavailableReason: 'Wähle Bilder in der Galerie aus.',
      }]}
      namePlaceholder="Preset-Name"
    />
    {pendingPairOpen && (
      <RawPairOpenDialog
        display={pendingPairOpen.display}
        raw={pendingPairOpen.raw}
        onCancel={() => setPendingPairOpen(null)}
        onPick={(photo, remember) => {
          if (remember) setPairOpenPreference(isRawName(photo.name) ? 'raw' : 'display');
          setPendingPairOpen(null);
          openPhotoInEditor(photo);
        }}
      />
    )}
    </div>
    </StackProvider>
    </RawPairProvider>
    </SettingsProvider>
    </SourceProvider>
  );
}


export default App;
