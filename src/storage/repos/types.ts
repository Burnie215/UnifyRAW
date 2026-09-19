/**
 * Repository row types. These are the frontend's catalog row definitions and
 * mirror packages/shared/src/catalog-schema.sql 1:1 (camelCase columns).
 */

import type { SourceType as KnownSourceType } from '../../sources/capabilities';
import type { Adjustments } from '../../types';
import type { PhotoDocument } from '../../engine/DocumentModel';
import type { LocalOnlyTableName, SyncTableName } from '@photolib/shared';

/**
 * The catalog table a repository write landed in. Every repository reports its
 * own, so a consumer can reload for just the tables it actually reads; the
 * counters themselves live in `contexts/storageRevisions`, which is the upper
 * layer and may not be named from here.
 */
export type RevisionTable = SyncTableName | LocalOnlyTableName;

/**
 * Rows can carry a type this build no longer knows (an older catalog, a
 * removed source), so the string escape hatch stays. The known names come
 * from the capability table — this list had drifted (`googledrive`,
 * `nextcloud`) into names no factory ever produced.
 */
export type SourceType = KnownSourceType | (string & {});

export interface SourceRow {
  id: string;
  type: SourceType;
  label: string;
  config: Record<string, unknown>;
  addedAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type PhotoFlag = 'pick' | 'reject' | null;
export type PhotoColorLabel = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null;

export interface PhotoRow {
  id: number;
  sourceId: string;
  sourcePhotoId: string;
  contentHash: string | null;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  dateTaken: number | null;
  dateModified: number | null;
  sourcePath: string | null;
  availability: 'online' | 'offline' | 'error' | 'trashed' | 'importing';
  sourceRevision: number;
  indexedAt: number;
  updatedAt: number;
  deletedAt: number | null;
  width: number | null;
  height: number | null;
  /** Exact encoded source precision once known (currently HEIF). */
  sourceBits: number | null;
  camera: string | null;
  lens: string | null;
  iso: number | null;
  focalLength: number | null;
  aperture: number | null;
  shutterSpeed: string | null;
  latitude: number | null;
  longitude: number | null;
  blurHash: string | null;
  stackId: string | null;
  stackPosition: number | null;
}

export interface PhotoMetaRow {
  contentHash: string;
  rating: number | null;
  flag: PhotoFlag;
  colorLabel: PhotoColorLabel;
  keywords: string[];
  updatedAt: number;
  deletedAt: number | null;
}

export interface EditRow {
  contentHash: string;
  copyIndex: number;
  copyName: string | null;
  adjustments: Adjustments;
  document: PhotoDocument | null;
  history: Adjustments[];
  documentHistory: PhotoDocument[] | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ExportRow {
  id: number;
  /** The five identity columns as one string; see `exportSyncId`. */
  syncId: string;
  contentHash: string;
  copyIndex: number;
  targetSourceId: string;
  targetAssetId: string;
  targetUrl: string | null;
  format: 'jpg' | 'tif' | 'png' | 'dng';
  editStackHash: string;
  filename: string;
  bytes: number;
  status: 'ok' | 'missing';
  uploadedAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface PresetRow {
  id: number;
  syncId: string;
  name: string;
  adjustments: Partial<Adjustments>;
  category: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface CollectionRule {
  field: 'rating' | 'flag' | 'colorLabel' | 'camera' | 'lens' | 'date' | 'iso' | 'focalLength' | 'keywords' | 'mimeType';
  operator: 'equals' | 'greaterThan' | 'lessThan' | 'contains' | 'between';
  value: string | number;
  value2?: string | number;
}

export interface CollectionRow {
  id: number;
  syncId: string;
  name: string;
  type: 'manual' | 'smart' | string;
  parentId: number | null;
  rules: CollectionRule[] | null;
  photoIds: number[] | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

/**
 * Photo row joined with its photoMeta fields. This is the type most UI code
 * touches — read paths default to PhotoView so that consumers can keep
 * doing `photo.rating` / `photo.flag` / etc. Meta writes go through the
 * dedicated PhotoMetaRepository.
 */
export interface PhotoView extends PhotoRow {
  rating: number | null;
  flag: PhotoFlag;
  colorLabel: PhotoColorLabel;
  keywords: string[];
}

export interface FaceRow {
  id: number;
  photoId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  embedding: number[] | null;
  clusterId: number | null;
  name: string | null;
  createdAt: number;
}
