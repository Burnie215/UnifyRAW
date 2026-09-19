export {
  CATALOG_SCHEMA_SQL,
  CATALOG_SCHEMA_VERSION,
  SYNC_TABLES,
  LOCAL_ONLY_TABLES,
} from './catalog-schema.js';

export type { SyncTableName, LocalOnlyTableName } from './catalog-schema.js';

export {
  SYNC_LIMITS,
  BACKEND_OVERLAY,
  CLIENT_OVERLAY,
} from './sync-protocol.js';

export type {
  SyncPullResponse,
  SyncPushResponse,
  SyncErrorResponse,
  BackendOverlayColumn,
} from './sync-protocol.js';

export {
  isSensitiveSourceConfigKey,
  mergeSourceConfigFromSync,
  redactSourceConfigForSync,
} from './source-config-sync.js';

export {
  LIBRARY_MODES,
  LIBRARY_STATUSES,
  LIBRARY_ASSET_STATUSES,
  LIBRARY_SCAN_STATUSES,
  LIBRARY_IMPORT_STATUSES,
} from './library-types.js';

export type {
  LibraryMode,
  LibraryStatus,
  AvailableLibraryRoot,
  LibraryRootSelection,
  PhotoLibraryRoot,
  PhotoLibraryCapabilities,
  PhotoLibrary,
  CreatePhotoLibraryRequest,
  UpdatePhotoLibraryRequest,
  PhotoLibrarySourceConfig,
  LibraryAssetStatus,
  PhotoLibraryAssetMetadata,
  PhotoLibraryAsset,
  PhotoLibraryAssetPage,
  PhotoLibraryAssetChanges,
  PhotoLibraryStats,
  LibraryImportStatus,
  PhotoLibraryImport,
  CreatePhotoLibraryImportRequest,
  PhotoLibraryImportCommit,
  PhotoLibraryIntegrityIssue,
  PhotoLibraryIntegrityReport,
  LibraryScanStatus,
  PhotoLibraryScan,
} from './library-types.js';

export {
  SMART_PREVIEW_HALF_SIZE_MAX_PX,
  SMART_PREVIEW_MAX_PX,
  smartPreviewVersion,
  smartPreviewFileName,
  parseSmartPreviewFileName,
  isCurrentSmartPreviewSlot,
} from './smart-preview.js';

export type { SmartPreviewVersion, SmartPreviewExt, SmartPreviewSlot } from './smart-preview.js';
