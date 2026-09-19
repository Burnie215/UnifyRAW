import type { Database } from 'sql.js';

export type ThumbSize = 'small' | 'large';

export type StorageKind = 'memory' | 'filesystem' | 'opfs';

export interface CatalogStorageInfo {
  kind: StorageKind;
  /** Human-readable label. For folder storages this is the folder name. */
  label: string;
  /** True if data persists across page reloads. */
  persistent: boolean;
  /** Approximate on-disk size of catalog.sqlite (bytes), best-effort. */
  catalogSize?: number;
  /** Timestamp of the last successful flush (ms). */
  lastFlushAt?: number;
  /** True if this instance never writes: another tab holds the catalog. */
  readOnly?: boolean;
  readOnlyReason?: 'locked';
}

export interface CompactResult {
  startedAt: number;
  finishedAt: number;
  binsTouched: number;
  binsSkipped: number;
  bytesBefore: number;
  bytesAfter: number;
  errors: string[];
}

export interface CatalogStorage {
  readonly info: CatalogStorageInfo;

  /** Live sql.js Database. Callers run their own statements. */
  readonly db: Database;

  /** Read a thumb blob; null if not stored locally. */
  readThumb(hash: string, size: ThumbSize): Promise<Blob | null>;

  /** Append a thumb blob to the matching bin file and update thumbIndex. */
  writeThumb(hash: string, size: ThumbSize, blob: Blob): Promise<void>;

  /** Remove a thumbnail index entry. Bin storage is reclaimed by compaction. */
  deleteThumb(hash: string, size: ThumbSize): Promise<void>;

  /** Mark for persistence; coalesced via the internal throttle. */
  flush(): void;

  /** Force-flush immediately (awaits the write). Used before close/export. */
  flushNow(): Promise<void>;

  /** Export the catalog.sqlite bytes (snapshot download, manual backup, …). */
  exportDb(): Uint8Array;

  /**
   * Return the folder root that backs this storage, or null for memory.
   * Used by maintenance code that needs to touch the bin files directly
   * (compaction, export-as-tarball, etc.).
   */
  getRootHandle?(): FileSystemDirectoryHandle | null;

  /** Subscribe to storage events; returns the unsubscribe function. */
  on?<K extends keyof CatalogStorageEventMap>(event: K, listener: CatalogStorageListener<K>): () => void;

  /** Rewrite the thumb bins tightly (folder-backed storages only). */
  compactThumbs?(): Promise<CompactResult>;

  /** Persist + release any handles. */
  close(): Promise<void>;
}

export interface CatalogStorageEventMap {
  flush: { at: number; bytes: number };
  error: { error: unknown; op: 'flush' | 'thumb-read' | 'thumb-write' };
}

export type CatalogStorageListener<K extends keyof CatalogStorageEventMap> =
  (ev: CatalogStorageEventMap[K]) => void;
