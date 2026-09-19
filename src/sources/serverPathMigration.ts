/**
 * The move plan that carries a legacy `server-path` source into an integrated
 * library (INTEGRATED_LIBRARIES_IMPLEMENTATION_PLAN.md Phase 8).
 *
 * Two rules shape everything here:
 *
 * 1. **A catalog row is never dropped.** A row that finds its asset changes
 *    its source in place - same `photos.id`, same `contentHash` - so
 *    collection membership (which stores photo ids), ratings, keywords and
 *    edits (which hang off the content hash) follow it without being touched.
 *    A row that finds no asset simply stays where it is; the old source keeps
 *    working and nothing about it is deleted.
 * 2. **The plan is decided before anything is written.** Everything in this
 *    file is pure: the UI shows the plan, the user confirms it, and only then
 *    does `applyServerPathMigration` write.
 */

import type { LibraryAssetStatus } from '@photolib/shared';
import type { PhotoRepository } from '../storage/repos';

/** One catalog row of the old `server-path` source. */
export interface MigrationCatalogRow {
  id: number;
  /** For a ServerPath source this is the path relative to its configured root. */
  sourcePhotoId: string;
  name: string;
  sizeBytes: number | null;
  contentHash: string | null;
  /** Rows the user removed from the catalog move along, still removed. */
  deletedAt: number | null;
}

/** One asset of the library the rows are moving to. */
export interface MigrationTargetAsset {
  /** The library's stable asset id; it becomes the row's `sourcePhotoId`. */
  id: string;
  relativePath: string;
  name: string;
  sizeBytes: number;
  quickHash: string | null;
  status: LibraryAssetStatus;
  revision: number;
}

/**
 * How a row found its asset, weakest last.
 *
 * `content-hash` survives a rename, `relative-path` survives a re-encode, and
 * `name-and-size` is the last resort for rows that were indexed before the
 * catalog ever hashed them and whose folder layout the library reports
 * differently.
 */
export type MigrationMatch = 'content-hash' | 'relative-path' | 'name-and-size';

export const MIGRATION_MATCH_ORDER: readonly MigrationMatch[] = [
  'content-hash',
  'relative-path',
  'name-and-size',
];

export interface MigrationMove {
  photoId: number;
  name: string;
  fromSourcePhotoId: string;
  toSourcePhotoId: string;
  matchedBy: MigrationMatch;
  /** The row is soft-deleted and stays that way; it only changes source. */
  removed: boolean;
  /**
   * The asset's quick hash, but only when the row carries none yet. An
   * existing hash is never overwritten: rating, keywords and edits are keyed
   * by it, and rewriting it would cut the row off from them.
   */
  fillContentHash: string | null;
  sourcePath: string;
  availability: LibraryAssetStatus;
  sourceRevision: number;
}

/**
 * Why a row stays on the old source. None of these lose anything - the row
 * keeps its data and the legacy source keeps serving it.
 */
export type MigrationStayReason =
  /** The library has no asset this row could be. */
  | 'no-match'
  /** Several assets fit equally well; picking one would be a guess. */
  | 'ambiguous'
  /** The only fitting asset was already taken by another row. */
  | 'asset-already-claimed';

export interface MigrationStay {
  photoId: number;
  name: string;
  sourcePhotoId: string;
  reason: MigrationStayReason;
  removed: boolean;
}

export interface ServerPathMigrationPlan {
  /** The legacy source the rows come from. It is left in place. */
  sourceId: string;
  /** The integrated library source the rows move to. */
  targetSourceId: string;
  moves: MigrationMove[];
  stays: MigrationStay[];
  totals: {
    rows: number;
    moves: number;
    stays: number;
    /** Assets no row claims. A scan of the new source adds them as new rows. */
    unclaimedAssets: number;
    matchedBy: Record<MigrationMatch, number>;
    stayedBecause: Record<MigrationStayReason, number>;
  };
}

export interface ServerPathMigrationInput {
  sourceId: string;
  targetSourceId: string;
  rows: readonly MigrationCatalogRow[];
  assets: readonly MigrationTargetAsset[];
}

/**
 * Normalise the two sides of a path comparison.
 *
 * `ServerPathSource` builds its id by cutting the root off an absolute path,
 * the library reports a path relative to its root; both can arrive with a
 * leading `./`, a leading slash, doubled separators or Windows separators.
 */
export function normalizeMigrationPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '')
    .replace(/\/$/, '');
}

/** A name cannot hold a newline, so the two parts of the key cannot blur. */
function nameSizeKey(name: string, sizeBytes: number): string {
  return `${name}\n${sizeBytes}`;
}

function index<T>(items: readonly T[], key: (item: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * Order the rows so that a contested asset goes to the row that still counts.
 *
 * A live row beats a row the user removed from the catalog, and among equals
 * the lower id wins - so the plan is the same on every device that runs it.
 */
function migrationOrder(rows: readonly MigrationCatalogRow[]): MigrationCatalogRow[] {
  return [...rows].sort((a, b) => {
    const removed = Number(a.deletedAt !== null) - Number(b.deletedAt !== null);
    return removed !== 0 ? removed : a.id - b.id;
  });
}

/**
 * Decide which catalog rows of a `server-path` source move to which library
 * asset, which stay behind, and which assets no row claims.
 *
 * Pure by design: no repository, no fetch, no React. The dialog renders what
 * comes back and `applyServerPathMigration` writes exactly this and nothing
 * more.
 */
export function planServerPathMigration(input: ServerPathMigrationInput): ServerPathMigrationPlan {
  const byHash = index(input.assets, (asset) => asset.quickHash);
  const byPath = index(input.assets, (asset) => normalizeMigrationPath(asset.relativePath));
  const byNameSize = index(input.assets, (asset) => nameSizeKey(asset.name, asset.sizeBytes));

  const moves: MigrationMove[] = [];
  const stays: MigrationStay[] = [];
  const claimed = new Set<string>();
  const matchedBy: Record<MigrationMatch, number> = {
    'content-hash': 0,
    'relative-path': 0,
    'name-and-size': 0,
  };
  const stayedBecause: Record<MigrationStayReason, number> = {
    'no-match': 0,
    'ambiguous': 0,
    'asset-already-claimed': 0,
  };

  for (const row of migrationOrder(input.rows)) {
    const candidates: Array<{ match: MigrationMatch; assets: MigrationTargetAsset[] }> = [
      { match: 'content-hash', assets: (row.contentHash && byHash.get(row.contentHash)) || [] },
      { match: 'relative-path', assets: byPath.get(normalizeMigrationPath(row.sourcePhotoId)) ?? [] },
      {
        match: 'name-and-size',
        assets: row.sizeBytes === null ? [] : byNameSize.get(nameSizeKey(row.name, row.sizeBytes)) ?? [],
      },
    ];

    let move: MigrationMove | null = null;
    let sawAmbiguous = false;
    let sawClaimed = false;

    for (const candidate of candidates) {
      if (candidate.assets.length === 0) continue;
      if (candidate.assets.length > 1) { sawAmbiguous = true; continue; }
      const asset = candidate.assets[0];
      if (claimed.has(asset.id)) { sawClaimed = true; continue; }
      move = {
        photoId: row.id,
        name: row.name,
        fromSourcePhotoId: row.sourcePhotoId,
        toSourcePhotoId: asset.id,
        matchedBy: candidate.match,
        removed: row.deletedAt !== null,
        fillContentHash: row.contentHash === null ? asset.quickHash : null,
        sourcePath: asset.relativePath,
        availability: asset.status,
        sourceRevision: asset.revision,
      };
      break;
    }

    if (move) {
      claimed.add(move.toSourcePhotoId);
      matchedBy[move.matchedBy]++;
      moves.push(move);
      continue;
    }

    const reason: MigrationStayReason = sawClaimed
      ? 'asset-already-claimed'
      : sawAmbiguous ? 'ambiguous' : 'no-match';
    stayedBecause[reason]++;
    stays.push({
      photoId: row.id,
      name: row.name,
      sourcePhotoId: row.sourcePhotoId,
      reason,
      removed: row.deletedAt !== null,
    });
  }

  return {
    sourceId: input.sourceId,
    targetSourceId: input.targetSourceId,
    moves,
    stays,
    totals: {
      rows: input.rows.length,
      moves: moves.length,
      stays: stays.length,
      unclaimedAssets: input.assets.length - claimed.size,
      matchedBy,
      stayedBecause,
    },
  };
}

/**
 * Carry out a confirmed plan.
 *
 * One transaction (`bulkUpdate` opens it and rolls back on error), so a
 * collision leaves the catalog exactly as it was instead of half-moved. The
 * row keeps its id and - unless it had none - its content hash, which is what
 * keeps collections, ratings, keywords and edits attached to it.
 */
export function applyServerPathMigration(
  photos: Pick<PhotoRepository, 'bulkUpdate'>,
  plan: ServerPathMigrationPlan,
): number {
  const updates = plan.moves.map((move) => ({
    id: move.photoId,
    patch: {
      sourceId: plan.targetSourceId,
      sourcePhotoId: move.toSourcePhotoId,
      sourcePath: move.sourcePath,
      availability: move.availability,
      sourceRevision: move.sourceRevision,
      ...(move.fillContentHash === null ? {} : { contentHash: move.fillContentHash }),
    },
  }));
  photos.bulkUpdate(updates);
  return updates.length;
}

/**
 * Whether a legacy source is one this assistant can move at all: a
 * `server-path` source whose backend is the backend this app talks to.
 *
 * An empty `serverUrl` means same-origin, which is what the self-hosted build
 * writes. A source pointing at somebody else's server stays a remote source -
 * its files are not in any root this backend could index.
 */
export function serverPathTargetsOwnBackend(
  serverUrl: string,
  backendUrl: string,
  pageOrigin: string,
): boolean {
  const own = readOrigin(backendUrl || pageOrigin, pageOrigin);
  const source = readOrigin(serverUrl || pageOrigin, pageOrigin);
  return own !== '' && own === source;
}

function readOrigin(value: string, base: string): string {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}
