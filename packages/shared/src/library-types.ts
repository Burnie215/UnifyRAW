export const LIBRARY_MODES = ['external', 'managed'] as const;
export type LibraryMode = (typeof LIBRARY_MODES)[number];

export const LIBRARY_STATUSES = ['idle', 'scanning', 'error', 'unavailable'] as const;
export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];

/**
 * An opaque, server-configured filesystem root that may be selected by a
 * client. Absolute host paths deliberately never cross the API boundary.
 */
export interface AvailableLibraryRoot {
  id: string;
  label: string;
  available: boolean;
  writable: boolean;
}

export interface LibraryRootSelection {
  rootId: string;
  /** Relative to the configured root. Empty or omitted means the root itself. */
  relativePath?: string;
}

export interface PhotoLibraryRoot {
  id: string;
  label: string;
  writable: boolean;
}

export interface PhotoLibraryCapabilities {
  canScan: boolean;
  canWatch: boolean;
  canImport: boolean;
  canWriteSidecars: boolean;
  canTrash: boolean;
}

export interface PhotoLibrary {
  id: string;
  name: string;
  mode: LibraryMode;
  readOnly: boolean;
  exclusionPatterns: string[];
  includeHidden: boolean;
  watchEnabled: boolean;
  scanIntervalMinutes: number;
  revision: number;
  status: LibraryStatus;
  lastScanAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  roots: PhotoLibraryRoot[];
  capabilities: PhotoLibraryCapabilities;
}

export interface CreatePhotoLibraryRequest {
  name: string;
  mode: LibraryMode;
  roots?: LibraryRootSelection[];
  exclusionPatterns?: string[];
  includeHidden?: boolean;
}

export interface UpdatePhotoLibraryRequest {
  name?: string;
  exclusionPatterns?: string[];
  includeHidden?: boolean;
  scanIntervalMinutes?: number;
}

export interface PhotoLibrarySourceConfig {
  libraryId: string;
}

export const LIBRARY_ASSET_STATUSES = [
  'online',
  'offline',
  'error',
  'trashed',
  'importing',
] as const;
export type LibraryAssetStatus = (typeof LIBRARY_ASSET_STATUSES)[number];

export interface PhotoLibraryAssetMetadata {
  camera?: string | null;
  lens?: string | null;
  iso?: number | null;
  focalLength?: number | null;
  aperture?: number | null;
  shutterSpeed?: string | null;
}

export interface PhotoLibraryAsset {
  id: string;
  libraryId: string;
  rootId: string;
  relativePath: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
  dateModified: number;
  dateTaken: number | null;
  quickHash: string | null;
  width: number | null;
  height: number | null;
  metadata?: PhotoLibraryAssetMetadata | null;
  status: LibraryAssetStatus;
  revision: number;
}

export interface PhotoLibraryAssetPage {
  assets: PhotoLibraryAsset[];
  nextCursor: string | null;
  hasMore: boolean;
  libraryRevision: number;
}

export interface PhotoLibraryAssetChanges {
  assets: PhotoLibraryAsset[];
  nextAfterRevision: number;
  hasMore: boolean;
  libraryRevision: number;
}

export interface PhotoLibraryStats {
  total: number;
  online: number;
  offline: number;
  error: number;
  trashed: number;
  importing: number;
  onlineBytes: number;
  libraryRevision: number;
}

export const LIBRARY_IMPORT_STATUSES = [
  'pending',
  'uploading',
  'uploaded',
  'committed',
  'failed',
  'cancelled',
] as const;
export type LibraryImportStatus = (typeof LIBRARY_IMPORT_STATUSES)[number];

/** Metadata for one resumable, server-side managed-library import. */
export interface PhotoLibraryImport {
  id: string;
  libraryId: string;
  fileName: string;
  sizeBytes: number;
  receivedBytes: number;
  checksumSha256: string | null;
  dateModified: number | null;
  status: LibraryImportStatus;
  assetId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreatePhotoLibraryImportRequest {
  fileName: string;
  sizeBytes: number;
  checksumSha256?: string;
  dateModified?: number;
}

export interface PhotoLibraryImportCommit {
  import: PhotoLibraryImport;
  asset: PhotoLibraryAsset;
  duplicate: boolean;
}

export interface PhotoLibraryIntegrityIssue {
  assetId: string;
  code: 'MISSING' | 'CHECKSUM_MISMATCH' | 'UNREADABLE';
}

export interface PhotoLibraryIntegrityReport {
  libraryId: string;
  checked: number;
  valid: number;
  initialized: number;
  missing: number;
  changed: number;
  unreadable: number;
  issues: PhotoLibraryIntegrityIssue[];
  startedAt: number;
  finishedAt: number;
}

export const LIBRARY_SCAN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type LibraryScanStatus = (typeof LIBRARY_SCAN_STATUSES)[number];

export interface PhotoLibraryScan {
  id: string;
  libraryId: string;
  status: LibraryScanStatus;
  generation: number;
  discovered: number;
  added: number;
  updated: number;
  offline: number;
  restored: number;
  errors: number;
  currentPath: string | null;
  cancelRequested: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  errorSummary: string | null;
}
