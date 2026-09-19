/**
 * Sync API — multi-user LWW state synchronization.
 *
 * Per-user scoping comes from the JWT (TokenPayload.userId). Explicit local
 * AUTH_MODE=disabled resolves to userId='_anon' for single-user development.
 *
 * Each sync table on the backend is the shared catalog schema plus
 * BACKEND_OVERLAY (userId, revision), and each is served by one lwwTable
 * spec below. Pull pages over the hub's revision (?afterRevision=&limit=,
 * answered with nextRevision and hasMore). Push merges a row when its
 * updatedAt beats the stored one: updatedAt decides conflicts, the revision
 * decides what a device still has to pull. Clients from before revisions pull
 * with ?since=<updatedAt>; that path stays for one release.
 *
 * Endpoints: /api/sync/<urlKey> for edits, meta (photoMeta), sources, photos
 * (no binary), presets, developProfiles, lensProfiles, collections, exports.
 */

import { Router, json as expressJson } from 'express';
import { SYNC_LIMITS, redactSourceConfigForSync } from '@photolib/shared';
import { lwwTable } from './lwwTable.js';

export const syncRouter = Router();
syncRouter.use(expressJson({ limit: SYNC_LIMITS.bodyBytes }));

const TIMESTAMPS = ['createdAt', 'updatedAt', 'deletedAt'] as const;

// `documentHistory` is not a sync column: the undo stack is device state. A row
// from an older client may still carry the field - it is accepted and dropped,
// never stored and never handed back out. The table keeps the (now unread)
// column so rows written before this change stay readable.
const edits = lwwTable<SyncEdit>({
  table: 'edits',
  urlKey: 'edits',
  identity: ['contentHash', 'copyIndex'],
  columns: ['contentHash', 'copyIndex', 'copyName', 'adjustments', 'document', 'history', ...TIMESTAMPS],
  createdColumn: 'createdAt',
  json: { adjustments: null, document: null, history: [] },
  validate: (edit) => Boolean(edit.contentHash) && edit.copyIndex != null && Boolean(edit.adjustments),
  toWire: (row) => ({ copyName: row.copyName ?? undefined }),
});

const meta = lwwTable<SyncMeta>({
  table: 'photoMeta',
  urlKey: 'meta',
  identity: ['contentHash'],
  columns: ['contentHash', 'rating', 'flag', 'colorLabel', 'keywords', 'updatedAt', 'deletedAt'],
  json: { keywords: [] },
  validate: (row) => Boolean(row.contentHash),
});

const sources = lwwTable<SyncSource>({
  table: 'sources',
  urlKey: 'sources',
  identity: ['id'],
  columns: ['id', 'type', 'label', 'config', 'addedAt', 'updatedAt', 'deletedAt'],
  createdColumn: 'addedAt',
  validate: (source) => Boolean(source.id && source.type && source.label),
  toWire: (row) => ({ config: redactSourceConfigForSync(row.config) }),
  fromWire: (source) => ({ config: JSON.stringify(redactSourceConfigForSync(source.config)) }),
});

const photos = lwwTable<SyncPhoto>({
  table: 'photos',
  urlKey: 'photos',
  identity: ['sourceId', 'sourcePhotoId'],
  columns: [
    'sourceId', 'sourcePhotoId', 'contentHash', 'name', 'mimeType', 'sizeBytes',
    'dateTaken', 'dateModified', 'sourcePath', 'availability', 'sourceRevision',
    'indexedAt', 'updatedAt', 'deletedAt',
    'width', 'height', 'camera', 'lens', 'iso', 'focalLength', 'aperture', 'shutterSpeed',
    'latitude', 'longitude', 'blurHash', 'stackId', 'stackPosition',
  ],
  validate: (photo) => Boolean(photo.sourceId && photo.sourcePhotoId && photo.name),
  fromWire: (photo) => ({
    availability: photo.availability ?? 'online',
    sourceRevision: photo.sourceRevision ?? 0,
    indexedAt: photo.indexedAt ?? photo.updatedAt,
  }),
});

const presets = lwwTable<SyncPreset>({
  table: 'presets',
  urlKey: 'presets',
  identity: ['syncId'],
  columns: ['syncId', 'name', 'adjustments', 'category', ...TIMESTAMPS],
  createdColumn: 'createdAt',
  json: { adjustments: {} },
  validate: (preset) => Boolean(preset.syncId && preset.name),
});

// Develop and lens profiles sync because they describe a camera or a piece of
// glass, not a device: tuning one on the desktop has to give the same picture
// on the phone.
const developProfiles = lwwTable<SyncDevelopProfile>({
  table: 'developProfiles',
  urlKey: 'developProfiles',
  identity: ['syncId'],
  columns: ['syncId', 'name', 'scope', 'key', 'isoFrom', 'isoTo', 'adjustments', ...TIMESTAMPS],
  createdColumn: 'createdAt',
  json: { adjustments: {} },
  validate: (profile) => Boolean(profile.syncId && profile.name && profile.scope && profile.key),
});

const lensProfiles = lwwTable<SyncLensProfile>({
  table: 'lensProfiles',
  urlKey: 'lensProfiles',
  identity: ['syncId'],
  columns: ['syncId', 'name', 'key', 'focalFrom', 'focalTo', 'coefficients', ...TIMESTAMPS],
  createdColumn: 'createdAt',
  json: { coefficients: {} },
  validate: (profile) => Boolean(profile.syncId && profile.name && profile.key),
});

// The hub never stores the device-local parentId/photoIds, only the stable
// parentSyncId/photoRefs (migration 005).
const collections = lwwTable<SyncCollection>({
  table: 'collections',
  urlKey: 'collections',
  identity: ['syncId'],
  columns: ['syncId', 'name', 'type', 'parentSyncId', 'rules', 'photoRefs', ...TIMESTAMPS],
  createdColumn: 'createdAt',
  json: { rules: null, photoRefs: [] },
  validate: (collection) => Boolean(collection.syncId && collection.name && collection.type),
  fromWire: (collection) => ({ photoRefs: JSON.stringify(validPhotoRefs(collection.photoRefs)) }),
});

// The export ledger: what has already been written back to a source, so the
// device that did not do it stops asking for it. Its identity column is the
// export itself in string form (exportSyncId), which is why two devices that
// made the same export merge into one row instead of two. `uploadedAt` is not
// a createdColumn: a repeated export of the same identity is the same ledger
// entry with a new upload time.
const exportLedger = lwwTable<SyncExport>({
  table: 'exports',
  urlKey: 'exports',
  identity: ['syncId'],
  columns: [
    'syncId', 'contentHash', 'copyIndex', 'targetSourceId', 'targetAssetId', 'targetUrl',
    'format', 'editStackHash', 'filename', 'bytes', 'status', 'uploadedAt', 'updatedAt', 'deletedAt',
  ],
  validate: (entry) => Boolean(
    entry.syncId && entry.contentHash && entry.targetSourceId && entry.format && entry.filename,
  ),
  fromWire: (entry) => ({
    copyIndex: entry.copyIndex ?? 0,
    targetAssetId: entry.targetAssetId ?? '',
    editStackHash: entry.editStackHash ?? '',
    bytes: entry.bytes ?? 0,
    status: entry.status ?? 'ok',
    uploadedAt: entry.uploadedAt ?? entry.updatedAt,
  }),
});

for (const table of [
  edits, meta, sources, photos, presets, developProfiles, lensProfiles, collections, exportLedger,
]) {
  syncRouter.use(table.router);
}

// ─────────────────────────────────────────────────────────────────────────
// Wire-format types
// ─────────────────────────────────────────────────────────────────────────

interface SyncEdit {
  contentHash: string;
  copyIndex: number;
  copyName?: string;
  adjustments?: unknown;
  document?: unknown;
  history?: unknown[];
  createdAt?: number;
  updatedAt: number;
  deletedAt?: number | null;
}

interface SyncMeta {
  contentHash: string;
  rating?: number | null;
  flag?: string | null;
  colorLabel?: string | null;
  keywords?: string[];
  updatedAt: number;
  deletedAt?: number | null;
}

interface SyncSource {
  id: string;
  type: string;
  label: string;
  config?: Record<string, unknown> | string;
  addedAt?: number;
  updatedAt: number;
  deletedAt?: number | null;
}

interface SyncPhoto {
  sourceId: string;
  sourcePhotoId: string;
  contentHash?: string | null;
  name: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  dateTaken?: number | null;
  dateModified?: number | null;
  sourcePath?: string | null;
  availability?: 'online' | 'offline' | 'error' | 'trashed' | 'importing';
  sourceRevision?: number;
  indexedAt?: number;
  updatedAt: number;
  deletedAt?: number | null;
  width?: number | null;
  height?: number | null;
  camera?: string | null;
  lens?: string | null;
  iso?: number | null;
  focalLength?: number | null;
  aperture?: number | null;
  shutterSpeed?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  blurHash?: string | null;
  stackId?: string | null;
  stackPosition?: number | null;
}

interface SyncPreset {
  syncId: string;
  name: string;
  adjustments?: Record<string, unknown>;
  category?: string | null;
  createdAt?: number;
  updatedAt: number;
  deletedAt?: number | null;
}

interface SyncDevelopProfile {
  syncId: string;
  name: string;
  scope: string;
  key: string;
  isoFrom?: number | null;
  isoTo?: number | null;
  adjustments?: Record<string, unknown>;
  createdAt?: number;
  updatedAt: number;
  deletedAt?: number | null;
}

interface SyncLensProfile {
  syncId: string;
  name: string;
  key: string;
  focalFrom?: number | null;
  focalTo?: number | null;
  coefficients?: Record<string, unknown>;
  createdAt?: number;
  updatedAt: number;
  deletedAt?: number | null;
}

interface SyncCollection {
  syncId: string;
  name: string;
  type: 'manual' | 'smart' | string;
  parentSyncId?: string | null;
  rules?: unknown[];
  photoRefs?: Array<{ sourceId: string; sourcePhotoId: string }>;
  createdAt?: number;
  updatedAt: number;
  deletedAt?: number | null;
}

interface SyncExport {
  syncId: string;
  contentHash: string;
  copyIndex?: number;
  targetSourceId: string;
  targetAssetId?: string;
  targetUrl?: string | null;
  format: string;
  editStackHash?: string;
  filename: string;
  bytes?: number;
  status?: string;
  uploadedAt?: number;
  updatedAt: number;
  deletedAt?: number | null;
}

function validPhotoRefs(value: unknown): Array<{ sourceId: string; sourcePhotoId: string }> {
  if (!Array.isArray(value)) return [];
  const refs: Array<{ sourceId: string; sourcePhotoId: string }> = [];
  for (const item of value.slice(0, 100_000)) {
    if (typeof item !== 'object' || item === null) continue;
    const ref = item as Record<string, unknown>;
    if (
      typeof ref.sourceId === 'string'
      && ref.sourceId.length > 0
      && ref.sourceId.length <= 256
      && typeof ref.sourcePhotoId === 'string'
      && ref.sourcePhotoId.length > 0
      && ref.sourcePhotoId.length <= 2048
    ) {
      refs.push({ sourceId: ref.sourceId, sourcePhotoId: ref.sourcePhotoId });
    }
  }
  return refs;
}
