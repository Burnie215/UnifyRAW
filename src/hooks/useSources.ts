import { useState, useEffect, useCallback, useRef } from 'react';
import { sourceManager } from '../sources';
import type { ImmichConfig, ImmichV3Config, WebDAVConfig } from '../sources';
import { computeContentHash } from '../data/contentHash';
import type { SourceProvider, PhotoRef } from '../sources';
import { dedupeSkips, IncompleteListingError, type ListingSkip } from '../sources/IncompleteListingError';
import { activityCounter } from './activityCounter';
import { useRepos, useStorageRevisions } from '../contexts/StorageContext';
import { libraryListingKey } from '../contexts/storageRevisions';
import type { PhotoRepository, PhotoView, SourceRow } from '../storage/repos';
import type { PhotoRow } from '../storage/repos';
import type { PhotoPage } from '../sources/types';
import type { CreatePhotoLibraryRequest } from '@photolib/shared';
import { serializePerKey } from './serializePerKey';
import { useImportPresetApply } from './useImportPresetApply';
import type { AddedPhoto } from './importPresetPlan';

const FIRST_GLANCE_SIZE = 200;
const FULL_REFRESH_PAGE_SIZE = 500;
const FULL_REFRESH_MAX_PAGES = 200; // safety cap (~100k photos)
const PAGE_WALK_SIZE = 1000;
const SCAN_WALK_PAGES = 1;
const SCAN_BATCH_SIZE = 100;
const PROGRESS_INTERVAL = 500;

/**
 * Where a page walk continues.
 *
 * Page and size belong together: with page/size pagination page 2 of size 1000
 * begins at item 1000, so a walk that changes size half way through skips or
 * repeats a whole range. A scan used to ask page 1 at size 200 and page 2 at
 * size 1000 - items 200..999 reached the grid only when a full refresh ran.
 */
export interface PageWalk {
  page: number;
  size: number;
}

/** What a paginated walk left behind. */
export interface PagedWalk {
  /** The source answered at least one page, so it can page at all. */
  paginated: boolean;
  /** Where a later page continues, or null once the source reported the end. */
  next: PageWalk | null;
  /** The source reported the end of its listing. */
  complete: boolean;
  /**
   * Parts the answered pages left out. Reaching the end of a listing that
   * skipped something is not the same as having seen everything, so a refresh
   * may only prune when this is empty as well.
   */
  skipped: readonly ListingSkip[];
}

/**
 * Walk at most `pages` pages of a paginated listing, every one of them at the
 * same `size`.
 *
 * A page that does not come back (null) ends the walk, but not as a finished
 * listing: null means "this source cannot answer paginated right now" (Immich
 * answers it for album-filtered configs), never "empty library". Only a page
 * that reported no more leaves `next` empty.
 */
export async function walkPages(
  listPage: (page: number, size: number) => Promise<PhotoPage | null>,
  take: (page: PhotoPage) => void,
  size: number,
  pages: number,
): Promise<PagedWalk> {
  let paginated = false;
  let next: PageWalk | null = null;
  const skipped: ListingSkip[] = [];
  for (let page = 1; page <= pages; page++) {
    const result = await listPage(page, size);
    if (!result) {
      // A FIRST page that does not answer means the source cannot page at all
      // and the caller falls back to the generator listing - nothing was
      // skipped. A later one is a page that failed, and the toast must be able
      // to say so instead of blaming the page cap.
      if (paginated) skipped.push({ kind: 'other', detail: `page ${page}` });
      break;
    }
    paginated = true;
    take(result);
    if (result.skipped) skipped.push(...result.skipped);
    next = result.hasMore ? { page: page + 1, size } : null;
    if (!next) break;
  }
  return { paginated, next, complete: paginated && next === null, skipped: dedupeSkips(skipped) };
}

/**
 * The pages a scan takes: a small first glance so the grid paints early, then
 * the walk that "load more" continues.
 *
 * The glance is deliberately not the walk's first page - it has its own size,
 * and a page number means nothing without one. Its items therefore arrive a
 * second time inside the walk; that is the price for a gap-free scan.
 */
export async function scanPages(
  listPage: (page: number, size: number) => Promise<PhotoPage | null>,
  take: (page: PhotoPage) => void,
): Promise<PagedWalk> {
  const glance = await listPage(1, FIRST_GLANCE_SIZE);
  if (!glance) return { paginated: false, next: null, complete: false, skipped: [] };
  take(glance);

  const walk = await walkPages(listPage, take, PAGE_WALK_SIZE, SCAN_WALK_PAGES);
  const skipped = dedupeSkips([...(glance.skipped ?? []), ...walk.skipped]);
  if (walk.paginated) return { ...walk, skipped };
  // The glance answered, so the source can page: its first page is one to
  // retry, not a reason to fall back to the generator listing.
  const next = glance.hasMore ? { page: 1, size: PAGE_WALK_SIZE } : null;
  return { paginated: true, next, complete: next === null, skipped };
}

/**
 * The rows a full refresh may drop.
 *
 * Pruning is only safe on a listing the source declared finished: bailing out
 * at the page cap means "there is more we have not seen", and so does a
 * source that skipped a failing part. A listing that yielded nothing at all
 * is far more likely a broken source than an emptied library, so it drops
 * nothing either.
 *
 * A row the user already took out of the catalog is not dropped again: the
 * snapshot carries soft-deleted rows so a listing can revive them, and
 * counting them as "vanished" would report a removal per refresh.
 */
export function photosToPrune(
  existing: Iterable<PhotoRow>,
  seen: ReadonlySet<string>,
  complete: boolean,
): PhotoRow[] {
  if (!complete || seen.size === 0) return [];
  return Array.from(existing)
    .filter((photo) => photo.deletedAt === null)
    .filter((photo) => !seen.has(photo.sourcePhotoId));
}

/**
 * Hands a generator listing to `take` in batches and resolves to whether it is
 * complete, plus what it had to skip. A source that had to skip something
 * throws IncompleteListingError after its last photo: what arrived is still
 * taken, but the walk is not complete. Every other error propagates.
 */
export async function walkListing(
  listing: AsyncIterable<PhotoRef>,
  take: (refs: PhotoRef[]) => void,
  batchSize = SCAN_BATCH_SIZE,
): Promise<{ complete: boolean; skipped: readonly ListingSkip[] }> {
  let batch: PhotoRef[] = [];
  let complete = true;
  let skipped: readonly ListingSkip[] = [];
  try {
    for await (const ref of listing) {
      batch.push(ref);
      if (batch.length >= batchSize) { take(batch); batch = []; }
    }
  } catch (error) {
    if (!(error instanceof IncompleteListingError)) throw error;
    complete = false;
    skipped = error.skips;
  }
  if (batch.length > 0) take(batch);
  return { complete, skipped };
}

/**
 * The `hasMore` map after one "load more" step for `sourceId`. Every step
 * writes the flag — a source that cannot page at all (removed meanwhile, or
 * without `listPhotosPage`) answers like a page that did not come back, so no
 * flag stays armed behind a button nothing can serve.
 */
export function hasMoreAfterPage(
  current: Readonly<Record<string, boolean>>,
  sourceId: string,
  page: { hasMore: boolean } | null,
): Record<string, boolean> {
  return { ...current, [sourceId]: page?.hasMore ?? false };
}

/**
 * The snapshot a user-triggered scan compares a listing against.
 *
 * Rows the user removed from the catalog are part of it: a listing that still
 * carries such a photo revives it (see `planIngest`) instead of asking for a
 * second row under the same (sourceId, sourcePhotoId).
 */
export function scanSnapshot(
  photos: Pick<PhotoRepository, 'listRaw'>,
  sourceId: string,
): Map<string, PhotoRow> {
  return new Map(
    photos.listRaw({ sourceId, includeDeleted: true }).map((photo) => [photo.sourcePhotoId, photo]),
  );
}

export interface IngestPlan {
  additions: Array<Omit<PhotoRow, 'id' | 'updatedAt' | 'deletedAt'>>;
  updates: Array<{ id: number; patch: Partial<Omit<PhotoRow, 'id'>> }>;
}

export type IngestRemovalPolicy = 'revive' | 'preserve-removal';

/**
 * How many of a plan's updates take a photo the user removed back into the
 * catalog. `deletedAt: null` in a patch is the revival and nothing else writes
 * it (`planIngest`), so counting those patches counts reactivated rows.
 *
 * The user has to be told: a rescan silently undoing a removal is the same
 * mistake as a silent removal, only in the other direction.
 */
export function revivedCount(plan: IngestPlan): number {
  return plan.updates.filter((update) => update.patch.deletedAt === null).length;
}

/**
 * What one listing batch means for the catalog: rows to insert, rows to patch.
 *
 * A photo the user removed from the catalog is in `existingById` too (the
 * snapshot is taken with `includeDeleted`), so a user-triggered listing that
 * still carries it revives it - `deletedAt: null` as part of the patch -
 * instead of asking for a second row under the same (sourceId, sourcePhotoId).
 * Background ingest passes `preserve-removal`: it may refresh changed listing
 * metadata, but it neither revives nor rewrites an unchanged removed row.
 */
export function planIngest(
  sourceId: string,
  refs: readonly PhotoRef[],
  existingById: ReadonlyMap<string, PhotoRow>,
  now: number,
  removalPolicy: IngestRemovalPolicy = 'revive',
): IngestPlan {
  const additions: IngestPlan['additions'] = [];
  const updates: IngestPlan['updates'] = [];

  for (const ref of refs) {
    const existing = existingById.get(ref.sourcePhotoId);
    if (!existing) {
      additions.push({
        sourceId,
        sourcePhotoId: ref.sourcePhotoId,
        contentHash: ref.contentHash ?? null,
        name: ref.name,
        mimeType: ref.mimeType ?? null,
        sizeBytes: ref.sizeBytes ?? null,
        dateTaken: ref.dateTaken ?? null,
        dateModified: ref.dateModified ?? null,
        sourcePath: ref.sourcePath ?? null,
        availability: ref.availability ?? 'online',
        sourceRevision: ref.sourceRevision ?? 0,
        indexedAt: now,
        width: ref.width ?? null,
        height: ref.height ?? null,
        sourceBits: ref.sourceBits ?? null,
        camera: ref.camera ?? null, lens: ref.lens ?? null,
        iso: ref.iso ?? null, focalLength: ref.focalLength ?? null,
        aperture: ref.aperture ?? null, shutterSpeed: ref.shutterSpeed ?? null,
        latitude: null, longitude: null,
        blurHash: null, stackId: null, stackPosition: null,
      });
      continue;
    }

    const patch: Partial<Omit<PhotoRow, 'id'>> = {};
    if (existing.deletedAt !== null && removalPolicy === 'revive') patch.deletedAt = null;
    assignIfChanged(patch, 'name', existing.name, ref.name);
    assignIfChanged(patch, 'mimeType', existing.mimeType, ref.mimeType ?? null);
    assignIfChanged(patch, 'sizeBytes', existing.sizeBytes, ref.sizeBytes ?? null);
    assignIfChanged(patch, 'dateTaken', existing.dateTaken, ref.dateTaken ?? null);
    assignIfChanged(patch, 'dateModified', existing.dateModified, ref.dateModified ?? null);
    assignIfChanged(patch, 'sourcePath', existing.sourcePath, ref.sourcePath ?? null);
    assignIfChanged(patch, 'availability', existing.availability, ref.availability ?? 'online');
    assignIfChanged(patch, 'sourceRevision', existing.sourceRevision, ref.sourceRevision ?? 0);
    assignIfChanged(patch, 'width', existing.width, ref.width ?? null);
    assignIfChanged(patch, 'height', existing.height, ref.height ?? null);
    if (ref.sourceBits !== undefined) {
      assignIfChanged(patch, 'sourceBits', existing.sourceBits, ref.sourceBits);
    } else if (sourceIdentityChanged(existing, ref)) {
      // A path can be replaced in place. A measured depth belongs to those
      // old bytes and must not survive until the replacement is probed.
      assignIfChanged(patch, 'sourceBits', existing.sourceBits, null);
    }
    if (ref.camera !== undefined) assignIfChanged(patch, 'camera', existing.camera, ref.camera);
    if (ref.lens !== undefined) assignIfChanged(patch, 'lens', existing.lens, ref.lens);
    if (ref.iso !== undefined) assignIfChanged(patch, 'iso', existing.iso, ref.iso);
    if (ref.focalLength !== undefined) assignIfChanged(patch, 'focalLength', existing.focalLength, ref.focalLength);
    if (ref.aperture !== undefined) assignIfChanged(patch, 'aperture', existing.aperture, ref.aperture);
    if (ref.shutterSpeed !== undefined) assignIfChanged(patch, 'shutterSpeed', existing.shutterSpeed, ref.shutterSpeed);
    if (ref.contentHash !== undefined) {
      assignIfChanged(patch, 'contentHash', existing.contentHash, ref.contentHash);
    }
    if (Object.keys(patch).length > 0) updates.push({ id: existing.id, patch });
  }

  return { additions, updates };
}

function sourceIdentityChanged(existing: PhotoRow, ref: PhotoRef): boolean {
  if (existing.contentHash && ref.contentHash && existing.contentHash !== ref.contentHash) return true;
  if (existing.sizeBytes != null && ref.sizeBytes != null && existing.sizeBytes !== ref.sizeBytes) return true;
  return existing.dateModified != null
    && ref.dateModified != null
    && existing.dateModified !== ref.dateModified;
}

export interface FullRefreshResult {
  added: number;
  removed: number;
  /**
   * Photos the user had removed from the catalog that this walk took back in.
   * The 10-minute background sync never does this (`syncSourceIncremental`
   * uses the preserve-removal policy); a rescan the user asked for does, and
   * has to say so.
   */
  revived: number;
  /**
   * False when the walk hit the page cap, a page did not answer, or the
   * source reported a skipped part (IncompleteListingError). Nothing was
   * pruned then.
   */
  complete: boolean;
  /**
   * The parts the listing left out, so the refresh can say WHICH of them it
   * was where the user can act on it - an album the server carries without a
   * name, for instance.
   */
  skipped: readonly ListingSkip[];
}

export function useSources() {
  const repos = useRepos();
  const revisions = useStorageRevisions();
  const listingKey = libraryListingKey(revisions);
  // The import tab's preset, applied to the rows an ingest creates and to
  // nothing else.
  const { applyToNewPhotos, organizeNewPhotos } = useImportPresetApply();

  const [sources, setSources] = useState<SourceRow[]>([]);
  const [photos, setPhotos] = useState<PhotoView[]>([]);
  const [scanning, setScanning] = useState(false);
  // Several sources can scan at once; the first one starting and the last
  // one ending are what the UI shows.
  const [scanActivity] = useState(() => activityCounter(setScanning));
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const pageWalk = useRef<Record<string, PageWalk>>({});
  // Every listing of a source takes its "already known" snapshot at the
  // start. Two of them overlapping (a rescan during the periodic sync) each
  // believed the same photos to be new, so they run one after the other.
  const [runExclusive] = useState(() => serializePerKey());

  const [disconnectedIds, setDisconnectedIds] = useState<string[]>([]);
  const [reconnected, setReconnected] = useState(false);

  useEffect(() => {
    // Reconnect saved sources, then mirror sources + photos into state.
    (async () => {
      try { await sourceManager.reconnectAll(); } catch { /* */ }
      setSources(repos.sources.list());
      setPhotos(repos.photos.list());
      const disconnected = await sourceManager.getDisconnectedSources().catch(() => []);
      setDisconnectedIds(disconnected);
      setReconnected(true);
    })();
  }, [repos]);

  // Refresh when a write landed in one of the tables this listing reads. An
  // edit persisted 500 ms after a slider stop is not one of them, so editing
  // no longer re-queries, re-sorts and re-renders the whole library (F086).
  useEffect(() => {
    setSources(repos.sources.list());
    setPhotos(repos.photos.list());
  }, [repos, listingKey]);

  const refreshSources = useCallback(() => {
    setSources(repos.sources.list());
  }, [repos]);

  const refreshPhotos = useCallback(() => {
    setPhotos(repos.photos.list());
  }, [repos]);

  const ingestBatch = useCallback((
    source: SourceProvider,
    refs: PhotoRef[],
    existingById = scanSnapshot(repos.photos, source.id),
    removalPolicy: IngestRemovalPolicy = 'revive',
  ) => {
    if (refs.length === 0) return { added: 0, updated: 0, revived: 0, addedPhotos: [] as AddedPhoto[] };
    const now = Date.now();
    const plan = planIngest(source.id, refs, existingById, now, removalPolicy);
    const { additions, updates } = plan;

    const addedIds = repos.photos.bulkAdd(additions);
    const addedPhotos: AddedPhoto[] = [];
    for (let index = 0; index < additions.length; index++) {
      const addition = additions[index];
      existingById.set(addition.sourcePhotoId, {
        ...addition,
        id: addedIds[index],
        updatedAt: now,
        deletedAt: null,
      });
      addedPhotos.push({ id: addedIds[index], contentHash: addition.contentHash });
    }
    repos.photos.bulkUpdate(updates);
    const replacedIds = updates
      .filter(({ patch }) => patch.sourceBits === null)
      .map(({ id }) => id);
    repos.exifScans.forget(replacedIds);
    // A listed row is back in the catalog; later batches of the same run read
    // this snapshot and must not ask for the revival a second time.
    if (removalPolicy === 'revive') {
      for (const ref of refs) {
        const known = existingById.get(ref.sourcePhotoId);
        if (known) known.deletedAt = null;
      }
    }
    // Import defaults ride on the additions, never on the updates: a rescan
    // that only refreshes listing metadata must leave a rating, a keyword or
    // a develop state the user gave the photo alone.
    applyToNewPhotos(addedPhotos);
    return { added: additions.length, updated: updates.length, revived: revivedCount(plan), addedPhotos };
  }, [applyToNewPhotos, repos]);

  const scanSource = useCallback(async (source: SourceProvider) => {
    scanActivity.begin();
    try {
      await runExclusive(source.id, async () => {
        const existingById = scanSnapshot(repos.photos, source.id);
        // Auto-organize runs once, on what this scan brought in - not per
        // batch, and not over the whole library.
        const imported: AddedPhoto[] = [];
        const ingest = (refs: PhotoRef[]) => {
          imported.push(...ingestBatch(source, refs, existingById).addedPhotos);
        };
        // Invalidate any per-source caches (album maps etc.) so a re-scan
        // picks up new albums on the upstream side.
        try { await source.refresh?.(); } catch { /* best-effort */ }
        let usedPagination = false;
        if (source.listChanges) {
          usedPagination = true;
          let afterRevision = 0;
          for (;;) {
            const changes = await source.listChanges(afterRevision, 500);
            ingest(changes.photos);
            refreshPhotos();
            if (!changes.hasMore || changes.nextRevision <= afterRevision) break;
            afterRevision = changes.nextRevision;
          }
          setHasMore((prev) => ({ ...prev, [source.id]: false }));
        } else if (source.listPhotosPage) {
          const listPage = source.listPhotosPage.bind(source);
          const walk = await scanPages(listPage, (page) => {
            ingest(page.photos);
            refreshPhotos();
            setHasMore((prev) => ({ ...prev, [source.id]: page.hasMore }));
          });
          usedPagination = walk.paginated;
          if (walk.next) pageWalk.current[source.id] = walk.next;
          else if (walk.paginated) delete pageWalk.current[source.id];
        }
        if (!usedPagination) {
          let batch: PhotoRef[] = [];
          let lastRefresh = Date.now();

          try {
            for await (const ref of source.listPhotos()) {
              batch.push(ref);

              if (batch.length >= SCAN_BATCH_SIZE) {
                ingest(batch);
                batch = [];

                const now = Date.now();
                if (now - lastRefresh > PROGRESS_INTERVAL) {
                  refreshPhotos();
                  lastRefresh = now;
                }
              }
            }
          } catch (error) {
            // A scan never prunes, so a listing with a skipped part is simply
            // what arrived.
            if (!(error instanceof IncompleteListingError)) throw error;
          }

          if (batch.length > 0) ingest(batch);
          refreshPhotos();
        }
        organizeNewPhotos(imported);
      });
    } finally {
      scanActivity.end();
    }
  }, [refreshPhotos, ingestBatch, organizeNewPhotos, repos, runExclusive, scanActivity]);

  const loadMore = useCallback(async () => {
    const sourcesWithMore = Object.entries(hasMore).filter(([, v]) => v);
    if (sourcesWithMore.length === 0 || scanning) return;

    scanActivity.begin();
    const imported: AddedPhoto[] = [];
    try {
      for (const [sourceId] of sourcesWithMore) {
        await runExclusive(sourceId, async () => {
          const source = sourceManager.get(sourceId);
          // Without a recorded walk there is no page number that means
          // anything: continuing at page 1 re-lists what is already in the
          // catalog, which is additive, while any later page would leave a gap.
          const walk = pageWalk.current[sourceId] ?? { page: 1, size: PAGE_WALK_SIZE };
          const result = source?.listPhotosPage
            ? await source.listPhotosPage(walk.page, walk.size)
            : null;
          if (source && result) {
            imported.push(...ingestBatch(source, result.photos).addedPhotos);
            pageWalk.current[sourceId] = { page: walk.page + 1, size: walk.size };
          }
          setHasMore((prev) => hasMoreAfterPage(prev, sourceId, result));
        });
      }
      organizeNewPhotos(imported);
      refreshPhotos();
    } finally {
      scanActivity.end();
    }
  }, [hasMore, scanning, refreshPhotos, ingestBatch, organizeNewPhotos, runExclusive, scanActivity]);

  const canLoadMore = Object.values(hasMore).some(Boolean);

  const addLocalSource = useCallback(async (): Promise<boolean> => {
    const source = await sourceManager.addLocalSource();
    if (!source) return false;
    refreshSources();
    await scanSource(source);
    return true;
  }, [scanSource, refreshSources]);

  const addLocalSourceFromFiles = useCallback(async (files: FileList) => {
    const source = await sourceManager.addLocalSourceFromFiles(files);
    refreshSources();
    await scanSource(source);
  }, [scanSource, refreshSources]);

  const addImmichSource = useCallback(async (config: ImmichConfig, label?: string) => {
    const source = await sourceManager.addImmichSource(config, label);
    if (!source) return false;
    refreshSources();
    await scanSource(source);
    return true;
  }, [scanSource, refreshSources]);

  const addImmichV3Source = useCallback(async (config: ImmichV3Config, label?: string) => {
    const source = await sourceManager.addImmichV3Source(config, label);
    if (!source) return false;
    refreshSources();
    await scanSource(source);
    return true;
  }, [scanSource, refreshSources]);

  const addWebDAVSource = useCallback(async (config: WebDAVConfig, label?: string) => {
    const source = await sourceManager.addWebDAVSource(config, label);
    if (!source) return false;
    refreshSources();
    try {
      await scanSource(source);
      return true;
    } catch (error) {
      // A successful Depth: 0 probe alone is not enough: keep the source only
      // when its initial collection listing also works.
      await sourceManager.removeSource(source.id).catch(() => undefined);
      refreshSources();
      refreshPhotos();
      throw error;
    }
  }, [refreshPhotos, refreshSources, scanSource]);

  const addPhotoLibLibrarySource = useCallback(async (
    request: CreatePhotoLibraryRequest,
    files: readonly File[] = [],
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
  ) => {
    const source = await sourceManager.addPhotoLibLibrarySource(request);
    if (!source) return false;
    refreshSources();
    if (files.length > 0) {
      if (!source.importFiles) throw new Error('Managed file import is unavailable');
      await source.importFiles(files, onProgress, signal);
    }
    await scanSource(source);
    return true;
  }, [scanSource, refreshSources]);

  const removeSource = useCallback(async (id: string) => {
    await sourceManager.removeSource(id);
    delete pageWalk.current[id];
    setHasMore((prev) => { const n = { ...prev }; delete n[id]; return n; });
    refreshSources();
    refreshPhotos();
  }, [refreshPhotos, refreshSources]);

  const rescanSource = useCallback(async (id: string) => {
    const source = sourceManager.get(id);
    if (!source) return;
    // Reconcile in place. Stable sourcePhotoIds retain local photo IDs, which
    // preserves collections, selections, metadata and edit associations.
    delete pageWalk.current[id];
    await scanSource(source);
  }, [scanSource]);

  /**
   * Full reconciliation against a source: walks the complete listing, ingests
   * everything and soft-deletes the rows the source no longer returns.
   *
   * Reserved for explicit user refreshes. The periodic sync stays purely
   * additive on purpose — a truncated or failing listing must never be able to
   * empty the library behind the user's back.
   */
  const refreshSourceFull = useCallback(async (id: string): Promise<FullRefreshResult | null> => {
    const source = sourceManager.get(id);
    if (!source) return null;

    scanActivity.begin();
    try {
      return await runExclusive(id, async () => {
        try { await source.refresh?.(); } catch { /* best-effort */ }

        const existingById = scanSnapshot(repos.photos, id);
        const seen = new Set<string>();
        let added = 0;
        let revived = 0;
        let complete = false;
        let skipped: readonly ListingSkip[] = [];

        const imported: AddedPhoto[] = [];
        const take = (refs: PhotoRef[]) => {
          for (const ref of refs) seen.add(ref.sourcePhotoId);
          // `ingestBatch` clears `deletedAt` on its snapshot as it goes, so a
          // photo carried by two batches is counted back in only once.
          const batch = ingestBatch(source, refs, existingById);
          added += batch.added;
          revived += batch.revived;
          imported.push(...batch.addedPhotos);
        };

        let paginated = false;
        let nextWalk: PageWalk | null = null;
        if (source.listChanges) {
          paginated = true;
          let afterRevision = 0;
          for (let page = 0; page < FULL_REFRESH_MAX_PAGES; page++) {
            const changes = await source.listChanges(afterRevision, FULL_REFRESH_PAGE_SIZE);
            take(changes.photos);
            refreshPhotos();
            if (!changes.hasMore || changes.nextRevision <= afterRevision) { complete = true; break; }
            afterRevision = changes.nextRevision;
          }
        } else if (source.listPhotosPage) {
          const listPage = source.listPhotosPage.bind(source);
          const walk = await walkPages(listPage, (page) => {
            take(page.photos);
            refreshPhotos();
          }, FULL_REFRESH_PAGE_SIZE, FULL_REFRESH_MAX_PAGES);
          paginated = walk.paginated;
          // Only a page that reported no more finishes the listing; a page that
          // did not answer and the page cap both leave a continuation behind.
          complete = walk.complete;
          skipped = walk.skipped;
          nextWalk = walk.next;
        }

        if (!paginated) {
          const walk = await walkListing(source.listPhotos(), take);
          complete = walk.complete;
          skipped = walk.skipped;
        }

        // Reaching the end of a listing that left parts out is not the same as
        // having seen everything: the photos behind a skipped part are missing
        // from `seen` for a reason that has nothing to do with the source
        // having dropped them. `complete` stays the walk's own answer, because
        // it is what says whether a "load more" has a page left.
        const whole = complete && skipped.length === 0;
        const vanished = photosToPrune(existingById.values(), seen, whole);
        if (vanished.length > 0) repos.photos.bulkSoftDelete(vanished.map((photo) => photo.id));

        // "Load more" continues this walk, at the size this walk used; a
        // generator listing cut short has nothing to page.
        if (nextWalk) pageWalk.current[id] = nextWalk;
        else delete pageWalk.current[id];
        setHasMore((prev) => ({ ...prev, [id]: paginated && !complete }));
        organizeNewPhotos(imported);
        refreshPhotos();

        return { added, removed: vanished.length, revived, complete: whole, skipped };
      });
    } finally {
      scanActivity.end();
    }
  }, [ingestBatch, organizeNewPhotos, refreshPhotos, repos, runExclusive, scanActivity]);

  const removePhotosFromIndex = useCallback((photoIds: number[]) => {
    repos.photos.bulkSoftDelete(photoIds);
    refreshPhotos();
  }, [refreshPhotos, repos]);

  const restorePhotosToIndex = useCallback((photoIds: number[]) => {
    repos.photos.bulkRestore(photoIds);
    refreshPhotos();
  }, [refreshPhotos, repos]);

  const ensureContentHash = useCallback(async (photo: PhotoView, existingFile?: File | null): Promise<string | null> => {
    if (photo.contentHash) return photo.contentHash;
    const file = existingFile ?? await (async () => {
      const source = sourceManager.get(photo.sourceId);
      if (!source) return null;
      return source.getFile({
        sourcePhotoId: photo.sourcePhotoId,
        sourceId: photo.sourceId,
        name: photo.name,
      });
    })();
    if (!file) return null;
    const hash = await computeContentHash(file);
    repos.photos.update(photo.id, { contentHash: hash });
    photo.contentHash = hash;
    return hash;
  }, [repos]);

  const getDisplayUrl = useCallback(async (photo: PhotoView): Promise<string | null> => {
    const source = sourceManager.get(photo.sourceId);
    if (!source) return null;
    return source.getDisplayUrl({
      sourcePhotoId: photo.sourcePhotoId,
      sourceId: photo.sourceId,
      name: photo.name,
    });
  }, []);

  const reconnectSource = useCallback(async (id: string) => {
    const ok = await sourceManager.reconnectSource(id);
    if (ok) {
      setDisconnectedIds((prev) => prev.filter((d) => d !== id));
      refreshPhotos();
    }
    return ok;
  }, [refreshPhotos]);

  // ─── Auto-import: walks ALL pages (not just 1+2 like the interactive scan),
  //     stopping once a page yields no new IDs. This catches photos in older
  //     albums that aren't in the "top N newest" window.
  // `signal` is checked before every ingest, not only between sources: an
  // abort usually means the catalog behind `repos` is being replaced.
  const syncSourceIncremental = useCallback((id: string, signal?: AbortSignal) => runExclusive(id, async () => {
    signal?.throwIfAborted();
    const source = sourceManager.get(id);
    if (!source) return;
    try { await source.refresh?.(); } catch { /* best-effort */ }

    // The background sync must see removed rows so it does not misclassify
    // them as additions. Its ingest policy keeps them removed; only a scan the
    // user asks for may bring them back into the library.
    const existingById = scanSnapshot(repos.photos, id);
    const SYNC_PAGE_SIZE = 500;
    const MAX_PAGES = 200; // safety cap (~100k photos)

    // The background sync imports photos too, so the import preset applies to
    // them as well - the tab promises every newly imported photo, not every
    // photo a user watched arrive.
    const imported: AddedPhoto[] = [];
    const ingest = (refs: PhotoRef[]) => {
      imported.push(...ingestBatch(source, refs, existingById, 'preserve-removal').addedPhotos);
    };

    if (source.listChanges) {
      let afterRevision = 0;
      for (const photo of existingById.values()) {
        afterRevision = Math.max(afterRevision, photo.sourceRevision);
      }
      for (let page = 0; page < MAX_PAGES; page++) {
        const changes = await source.listChanges(afterRevision, SYNC_PAGE_SIZE, signal);
        signal?.throwIfAborted();
        ingest(changes.photos);
        refreshPhotos();
        if (!changes.hasMore || changes.nextRevision <= afterRevision) break;
        afterRevision = changes.nextRevision;
      }
      organizeNewPhotos(imported);
      return;
    }

    if (source.listPhotosPage) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const result = await source.listPhotosPage(page, SYNC_PAGE_SIZE, signal);
        signal?.throwIfAborted();
        if (!result || result.photos.length === 0) break;
        ingest(result.photos);
        refreshPhotos();
        if (!result.hasMore) break;
      }
      organizeNewPhotos(imported);
      return;
    }

    // Generator path (sources without paginated API).
    let batch: PhotoRef[] = [];
    let consecutiveDupes = 0;
    try {
      for await (const ref of source.listPhotos(undefined, signal)) {
        signal?.throwIfAborted();
        if (existingById.has(ref.sourcePhotoId)) {
          consecutiveDupes++;
          if (consecutiveDupes >= 200) break;
          continue;
        }
        consecutiveDupes = 0;
        batch.push(ref);
        if (batch.length >= SCAN_BATCH_SIZE) {
          ingest(batch);
          batch = [];
        }
      }
    } catch (error) {
      // Additive only: a skipped part of the listing just arrives next time.
      if (!(error instanceof IncompleteListingError)) throw error;
    }
    // An aborted listing ends quietly, without IncompleteListingError.
    signal?.throwIfAborted();
    if (batch.length > 0) ingest(batch);
    organizeNewPhotos(imported);
    refreshPhotos();
  }), [repos, ingestBatch, organizeNewPhotos, refreshPhotos, runExclusive]);

  const getAutoRefresh = useCallback((id: string): boolean => {
    return sourceManager.getAutoRefresh(id);
  }, []);

  const setAutoRefresh = useCallback((id: string, enabled: boolean) => {
    sourceManager.setAutoRefresh(id, enabled);
    refreshSources();
  }, [refreshSources]);

  // After initial reconnect: trigger one background sync per source with autoRefresh.
  // Subsequently re-run every 10 minutes so the library picks up new server-side photos.
  useEffect(() => {
    if (!reconnected) return;
    // Unmount or a catalog switch stops a running sync in the middle of its
    // page walk, down to the request in flight.
    const controller = new AbortController();

    const runSync = async () => {
      const list = repos.sources.list();
      for (const s of list) {
        if (controller.signal.aborted) return;
        if (!sourceManager.getAutoRefresh(s.id)) continue;
        // Skip sources that are currently disconnected — they need user gesture first.
        if (!sourceManager.get(s.id)) continue;
        try { await syncSourceIncremental(s.id, controller.signal); } catch { /* best-effort */ }
      }
    };

    // Initial sweep — short delay so the initial UI mount happens first.
    const initialTimer = setTimeout(runSync, 4000);
    const interval = setInterval(runSync, 10 * 60 * 1000);

    return () => {
      controller.abort();
      clearTimeout(initialTimer);
      clearInterval(interval);
    };
  }, [reconnected, repos, syncSourceIncremental]);

  return {
    sources,
    photos,
    scanning,
    reconnected,
    canLoadMore,
    loadMore,
    addLocalSource,
    addLocalSourceFromFiles,
    addImmichSource,
    addImmichV3Source,
    addWebDAVSource,
    addPhotoLibLibrarySource,
    scanSource,
    removeSource,
    rescanSource,
    refreshSourceFull,
    removePhotosFromIndex,
    restorePhotosToIndex,
    ensureContentHash,
    getDisplayUrl,
    refreshPhotos,
    disconnectedIds,
    reconnectSource,
    getAutoRefresh,
    setAutoRefresh,
  };
}

function assignIfChanged<K extends keyof Omit<PhotoRow, 'id'>>(
  patch: Partial<Omit<PhotoRow, 'id'>>,
  key: K,
  current: Omit<PhotoRow, 'id'>[K],
  next: Omit<PhotoRow, 'id'>[K],
): void {
  if (current !== next) {
    (patch as Record<keyof Omit<PhotoRow, 'id'>, unknown>)[key] = next;
  }
}
