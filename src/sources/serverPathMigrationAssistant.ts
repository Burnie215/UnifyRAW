/**
 * The three steps of the Phase-8 migration assistant, kept out of React so
 * the dialog stays a view over them.
 *
 * Nothing here decides anything: the decision is
 * [planServerPathMigration](serverPathMigration.ts), which runs on the
 * library's assets and the catalog's rows and is shown to the user before
 * `commitPreparedMigration` writes a single row.
 *
 * The legacy source is never converted in place and never removed. It keeps
 * its configuration, keeps serving the rows that found no asset, and the user
 * removes it themselves - with the button that has always been there - once
 * they are satisfied. See INTEGRATED_LIBRARIES_IMPLEMENTATION_PLAN.md
 * Phase 8 ("Keine bestehende Quelle wird automatisch oder destruktiv
 * konvertiert").
 */

import type { PhotoLibraryScan } from '@photolib/shared';
import {
  listPhotoLibraryAssets,
  locateLibraryRoot,
  scanPhotoLibrary,
} from '../platform/libraryApi';
import type { Repositories, SourceRow } from '../storage/repos';
import { sourceManager } from './SourceManager';
import {
  applyServerPathMigration,
  planServerPathMigration,
  type MigrationTargetAsset,
  type ServerPathMigrationPlan,
} from './serverPathMigration';

/** Guard against an unbounded asset walk; 500 per page. */
const MAX_ASSET_PAGES = 2000;

/** What the assistant can say before it has touched anything at all. */
export interface ServerPathMigrationPreview {
  sourceId: string;
  sourceLabel: string;
  /** The absolute server path the legacy source was configured with. */
  rootPath: string;
  /** The opaque configured root that holds it, as the backend names it. */
  rootId: string;
  rootLabel: string;
  /** Where the source's root sits below the configured root; '' means at it. */
  relativePath: string;
  /** Catalog rows on the legacy source, rows the user removed included. */
  rowCount: number;
  /** The name the new library will carry. */
  libraryName: string;
}

export interface PreparedServerPathMigration {
  preview: ServerPathMigrationPreview;
  libraryId: string;
  targetSourceId: string;
  plan: ServerPathMigrationPlan;
}

export function serverPathRootPath(source: SourceRow): string {
  return typeof source.config.rootPath === 'string' ? source.config.rootPath : '';
}

export function serverPathServerUrl(source: SourceRow): string {
  return typeof source.config.serverUrl === 'string' ? source.config.serverUrl : '';
}

/**
 * Step 1 - read only. Asks the backend which configured library root holds
 * the legacy source's directory and counts the rows that would be affected.
 * Throws a `LibraryApiError` (code `ROOT_NOT_ALLOWED`) when this backend does
 * not offer that directory as a library root.
 */
export async function previewServerPathMigration(
  source: SourceRow,
  repos: Repositories,
): Promise<ServerPathMigrationPreview> {
  const rootPath = serverPathRootPath(source);
  const located = await locateLibraryRoot(rootPath);
  return {
    sourceId: source.id,
    sourceLabel: source.label,
    rootPath,
    rootId: located.root.id,
    rootLabel: located.root.label,
    relativePath: located.relativePath,
    rowCount: repos.photos.listRaw({ sourceId: source.id, includeDeleted: true }).length,
    libraryName: source.label,
  };
}

/**
 * Step 2 - creates the library and indexes it on the server, then works out
 * the move plan. The catalog is read, never written: the rows still belong to
 * the legacy source when this returns.
 *
 * A failure here takes the half-built library back out, so a retry starts
 * from the same state as the first attempt.
 */
export async function prepareServerPathMigration(
  preview: ServerPathMigrationPreview,
  repos: Repositories,
  onScanProgress?: (scan: PhotoLibraryScan) => void,
): Promise<PreparedServerPathMigration> {
  const target = await sourceManager.addPhotoLibLibrarySource({
    name: preview.libraryName,
    mode: 'external',
    roots: [{
      rootId: preview.rootId,
      ...(preview.relativePath ? { relativePath: preview.relativePath } : {}),
    }],
  });
  if (!target) throw new Error('The integrated library source could not be created');

  try {
    const libraryId = repos.sources.get(target.id)?.config.libraryId;
    if (typeof libraryId !== 'string' || !libraryId) {
      throw new Error('The created library source carries no library id');
    }

    await scanPhotoLibrary(libraryId, onScanProgress);
    const assets = await collectLibraryAssets(libraryId);
    const rows = repos.photos.listRaw({ sourceId: preview.sourceId, includeDeleted: true });

    return {
      preview,
      libraryId,
      targetSourceId: target.id,
      plan: planServerPathMigration({
        sourceId: preview.sourceId,
        targetSourceId: target.id,
        rows: rows.map((row) => ({
          id: row.id,
          sourcePhotoId: row.sourcePhotoId,
          name: row.name,
          sizeBytes: row.sizeBytes,
          contentHash: row.contentHash,
          deletedAt: row.deletedAt,
        })),
        assets,
      }),
    };
  } catch (error) {
    await sourceManager.removeSource(target.id).catch(() => undefined);
    throw error;
  }
}

/**
 * Step 3 - the only step that writes. One transaction over the confirmed
 * plan; the rows keep their ids and their content hashes, so collections,
 * ratings, keywords and edits stay attached.
 */
export function commitPreparedMigration(
  prepared: PreparedServerPathMigration,
  repos: Repositories,
): number {
  return applyServerPathMigration(repos.photos, prepared.plan);
}

/**
 * Take back step 2. Removes the library this run created - its index and its
 * thumbnails; originals in an external root are never touched - and the
 * source row that pointed at it. The legacy source is untouched either way.
 */
export async function discardPreparedMigration(
  prepared: PreparedServerPathMigration,
): Promise<void> {
  await sourceManager.removeSource(prepared.targetSourceId);
}

async function collectLibraryAssets(libraryId: string): Promise<MigrationTargetAsset[]> {
  const assets: MigrationTargetAsset[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_ASSET_PAGES; page++) {
    const result = await listPhotoLibraryAssets(libraryId, { cursor, limit: 500 });
    for (const asset of result.assets) {
      assets.push({
        id: asset.id,
        relativePath: asset.relativePath,
        name: asset.name,
        sizeBytes: asset.sizeBytes,
        quickHash: asset.quickHash,
        status: asset.status,
        revision: asset.revision,
      });
    }
    cursor = result.nextCursor;
    if (!cursor) return assets;
  }
  throw new Error('The library holds more assets than the migration assistant can plan in one pass');
}
