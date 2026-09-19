import type { ListingSkip } from './IncompleteListingError';

export interface PhotoRef {
  /** Stable within one source (path, object key, asset id) */
  sourcePhotoId: string;
  sourceId: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  dateTaken?: number;
  dateModified?: number;
  /** Source-provided fast content identity, when compatible with PhotoLib's hash format. */
  contentHash?: string | null;
  /** Display-only path relative to the source root. Never an absolute server path. */
  sourcePath?: string;
  /** Current availability reported by a reconciled source. */
  availability?: 'online' | 'offline' | 'error' | 'trashed' | 'importing';
  /** Monotone source-side revision for this asset. */
  sourceRevision?: number;
  width?: number | null;
  height?: number | null;
  /** Exact encoded source precision reported by the provider, when known. */
  sourceBits?: number | null;
  camera?: string | null;
  lens?: string | null;
  iso?: number | null;
  focalLength?: number | null;
  aperture?: number | null;
  shutterSpeed?: string | null;
}

/**
 * What a source can write. Never declared by hand: `writeCapabilitiesOf()`
 * derives every flag from the presence of the matching method, so the contract
 * cannot claim something the provider does not implement.
 */
export interface WriteCapabilities {
  canWriteSidecar: boolean;
  canSetFavorite: boolean;
  canSetRating: boolean;
  canSetTags: boolean;
  canSetTitle: boolean;
  canUpload: boolean;
  canCreateAlbum: boolean;
  canAddToAlbum: boolean;
  /** Permanently remove the asset on the source (and the file on disk where applicable) */
  canDelete: boolean;
}

export interface SourceMetadata {
  camera?: string | null;
  lens?: string | null;
  iso?: number | null;
  focalLength?: number | null;
  aperture?: number | null;
  shutterSpeed?: string | null;
  width?: number | null;
  height?: number | null;
  sourceBits?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  keywords?: string[];
  rating?: number | null;
  favorite?: boolean;
  title?: string | null;
  description?: string | null;
}

/** Browsable item for album/folder selection during import */
export interface SourceBrowseItem {
  id: string;
  name: string;
  type: 'folder' | 'album' | 'category' | 'collection' | 'photoset';
  photoCount?: number;
  children?: SourceBrowseItem[];
}

export interface PhotoPage {
  photos: PhotoRef[];
  hasMore: boolean;
  total?: number;
  /**
   * Parts of the source this page had to leave out. A page can answer in full
   * and still not be whole - an Immich album the server carries without a name
   * contributes no folder to the map every page of that walk is filed under -
   * so a walk over such pages must never count as a finished listing.
   */
  skipped?: readonly ListingSkip[];
}

export interface SourceChangePage {
  photos: PhotoRef[];
  nextRevision: number;
  hasMore: boolean;
  sourceRevision: number;
}

export interface SourceProvider {
  readonly id: string;
  readonly label: string;
  readonly type: string;

  connect(): Promise<boolean>;
  /** Detailed failure from the latest connection probe, when available. */
  getConnectionError?(): Error | null;
  disconnect(): Promise<void>;
  /** `signal` aborts the listing; sources that honour it pass it to their requests. */
  listPhotos(path?: string, signal?: AbortSignal): AsyncIterable<PhotoRef>;
  /** Paginated listing for large sources. Returns null if not supported. */
  listPhotosPage?(page: number, pageSize: number, signal?: AbortSignal): Promise<PhotoPage | null>;
  /** Monotone source-side change feed, used for index reconciliation. */
  listChanges?(afterRevision: number, limit: number, signal?: AbortSignal): Promise<SourceChangePage>;
  getDisplayUrl(ref: PhotoRef): Promise<string>;
  /** Read a source thumbnail. A supplied signal owns this one read. */
  getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null>;
  /** Read the original file. A supplied signal owns this one read. */
  getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null>;
  /** Write sidecar JSON next to the original. Returns false if not supported. */
  writeSidecar?(ref: PhotoRef, data: string): Promise<boolean>;
  /** Read sidecar JSON from next to the original. Returns null if not found. */
  readSidecar?(ref: PhotoRef): Promise<string | null>;

  // ─── Extended capabilities ───

  /**
   * May only switch derived capabilities OFF, for state a method's existence
   * cannot express (a library without a trash, say); never on.
   */
  writeRestrictions?(): Partial<WriteCapabilities>;

  /** Fetch EXIF/metadata from source API (richer than PhotoRef) */
  getMetadata?(ref: PhotoRef): Promise<SourceMetadata | null>;

  /** List albums, folders, or categories for import filtering */
  listAlbumsOrFolders?(): Promise<SourceBrowseItem[]>;

  /** Set favorite/starred status */
  setFavorite?(ref: PhotoRef, favorite: boolean): Promise<boolean>;

  /** Set rating (1-5, 0 to clear) */
  setRating?(ref: PhotoRef, rating: number): Promise<boolean>;

  /** Set tags/keywords (replaces existing) */
  setTags?(ref: PhotoRef, tags: string[]): Promise<boolean>;

  /** Set title and/or description */
  setTitle?(ref: PhotoRef, title: string, description?: string): Promise<boolean>;

  /** Upload an edited photo as a new asset. */
  uploadEdit?(ref: PhotoRef, blob: Blob): Promise<boolean>;

  /** Write-back capabilities — see plans/EXPORT_WRITEBACK_PLAN.md. */
  exportCapabilities?: SourceExportCapabilities;

  /**
   * Push an edited render back to the source as a NEW asset (never overwrite).
   * Returns the target asset id (and optional URL) so the caller can persist
   * an `exports[]` entry in the sidecar for the original.
   * Implementations MUST check for an existing asset with the same filename
   * (which carries the edit-stack hash) and skip re-upload in that case —
   * `alreadyExisted=true` signals an idempotent hit.
   */
  exportAsset?(input: ExportAssetInput): Promise<ExportAssetResult>;

  /** Create a new album/folder */
  createAlbum?(name: string, parentId?: string): Promise<string | null>;

  /** Add photos to an album */
  addToAlbum?(albumId: string, refs: PhotoRef[]): Promise<boolean>;

  /** Remove assets according to source policy (managed sources may use a trash). */
  deletePhotos?(refs: PhotoRef[]): Promise<DeleteResult>;

  /** Import original files into a source that owns managed storage. */
  importFiles?(
    files: readonly File[],
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;

  /** Invalidate any internal caches (album maps, photo metadata) before a fresh listing. */
  refresh?(): Promise<void> | void;

  /**
   * Optional: return everything the backend needs to fetch the original
   * file on its own, skipping the source-bytes round-trip through the
   * user's browser. RAW files are typically 25-50 MB — on a 10 Mbps
   * upstream that's 20-40 s of pure transport per open. With this:
   *   - Selfhost (Immich next to PhotoLib on the same Docker host):
   *     backend fetches over the Docker-internal network → instant.
   *   - SaaS (user's Immich on a remote box): backend still benefits
   *     because server-to-server upstream is normally much wider than
   *     the client's home internet, and the user pays for ONE
   *     download (~6 MB resized TIFF) instead of TWO 25-50 MB hops.
   *
   * Sources whose access depends on client-only state (LocalSource via
   * FileSystemAccess, FileList, OAuth SDKs without server-side refresh)
   * return null and the legacy upload path is used.
   */
  getRemoteFetchHint?(ref: PhotoRef): { url: string; headers: Record<string, string>; method?: string } | null;

  /**
   * Optional authenticated backend endpoint that prepares the RAW directly
   * from source-owned storage and returns a 16-bit TIFF. This avoids routing
   * a server-local original through the browser and back to the backend.
   */
  getRawPreviewHint?(ref: PhotoRef): { url: string } | null;
}

export interface SourceExportCapabilities {
  canWrite: boolean;
  supportsStacking: 'native-id' | 'filename-stem' | false;
  /**
   * What this target accepts on upload, not what UnifyRAW can encode. `dng` is
   * the linear negative from `encodeDng` - half-float, `PhotometricInterpretation
   * = LinearRaw` - so a target only belongs in the list if it accepts a `.dng`
   * upload at all. A source that declares nothing keeps the old default
   * (`jpg`, `tif`, `png`); DNG is never granted by omission.
   */
  allowedFormats: Array<'jpg' | 'tif' | 'png' | 'dng'>;
  filenameStrategy: 'free' | 'stem-must-match' | 'auto-id';
  albumPlacement: 'same' | 'configurable' | 'fixed';
}

export interface ExportAssetInput {
  /** Original asset reference — for stacking + same-album placement. */
  original: PhotoRef;
  /** Already-rendered export bytes (from engine/Exporter.exportPhoto). */
  renderedBlob: Blob;
  format: 'jpg' | 'tif' | 'png' | 'dng';
  /** Already built per buildExportFilename — contains the edit-stack hash. */
  filename: string;
  /** Full edit-stack hash (hex). Used as logical id (e.g. Immich deviceAssetId). */
  editStackHash: string;
  /** Optional override; default is same album/folder as the original. */
  targetAlbumId?: string;
}

export interface ExportAssetResult {
  assetId: string;
  url?: string;
  /** True if the target file already existed (idempotent re-export). */
  alreadyExisted: boolean;
}

export interface DeleteResult {
  /**
   * The `sourcePhotoId` of every ref that is gone upstream — exactly the value
   * the caller passed in, not a provider-internal id derived from it. The
   * catalog drops its rows by matching this, so a translated id leaves the
   * deleted photo visible in the library.
   */
  succeededIds: string[];
  failed: { sourcePhotoId: string; error: string }[];
}
