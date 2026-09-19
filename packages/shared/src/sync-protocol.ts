/** Wire contract of /api/sync, shared by the sync hub and the client. */

export const SYNC_LIMITS = {
  /** Largest JSON body the hub parses on /api/sync. */
  bodyBytes: 8 * 1024 * 1024,
  /** Largest single row the hub accepts in a push. */
  rowBytes: 4 * 1024 * 1024,
  pushBatchBytes: 2 * 1024 * 1024,
  pushBatchRows: 500,
  pullPageRows: 500,
  pullPageRowsMax: 1000,
} as const;

export type SyncPullResponse<TKey extends string, TRow> =
  Record<TKey, TRow[]> & { nextRevision: number; hasMore: boolean };

export interface SyncPushResponse {
  merged: number;
  skipped: number;
  errors?: Array<{ key: string; code: 'row-too-large' | 'invalid' }>;
}

export interface SyncErrorResponse {
  error: string;
  code: string;
}

/** Columns the hub adds to every sync table on top of the shared catalog schema. */
export const BACKEND_OVERLAY = ['userId', 'revision'] as const;

export type BackendOverlayColumn = (typeof BACKEND_OVERLAY)[number];

/**
 * Columns the client adds to every sync table on top of the shared catalog
 * schema. localSeq orders local writes for push: > 0 written here, 0 already
 * pushed (or older than the overlay), < 0 written by a pull.
 */
export const CLIENT_OVERLAY = ['localSeq'] as const;

export type ClientOverlayColumn = (typeof CLIENT_OVERLAY)[number];
