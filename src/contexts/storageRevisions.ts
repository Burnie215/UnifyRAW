import { LOCAL_ONLY_TABLES, SYNC_TABLES, type SyncTableName } from '@photolib/shared';
import type { RevisionTable } from '../storage/repos/types';

/**
 * A catalog table a write can belong to. It is owned by the storage layer,
 * which may not name this module (import direction), and derived from the
 * shared register rather than a list of its own — so a new table is a type
 * error at the repository that writes it, not a counter nobody bumps.
 */
export type { RevisionTable };

/**
 * One write counter per table, plus `all` for every write whatever its table.
 *
 * The point of the split is that a consumer only re-runs for the tables it
 * actually reads: a slider stop in the editor writes `edits` every 500 ms, and
 * the library's photo listing must not re-query, re-sort and re-render for it.
 */
export type StorageRevisions = Readonly<Record<RevisionTable | 'all', number>>;

const REVISION_TABLES: readonly RevisionTable[] = [...SYNC_TABLES, ...LOCAL_ONLY_TABLES];

export function createRevisions(): StorageRevisions {
  const state = { all: 0 } as Record<RevisionTable | 'all', number>;
  for (const table of REVISION_TABLES) state[table] = 0;
  return state;
}

/**
 * A new state in which only `table` and `all` have moved. Every other counter
 * keeps its value, so a consumer keyed on one of them does not re-run.
 */
export function bumpRevision(state: StorageRevisions, table: RevisionTable): StorageRevisions {
  return { ...state, [table]: state[table] + 1, all: state.all + 1 };
}

/**
 * The same for a sync pull, which merges rows into several tables in one go.
 * An empty list changes nothing: a cycle that merged no row leaves every
 * consumer where it was.
 */
export function bumpRevisions(state: StorageRevisions, tables: Iterable<RevisionTable>): StorageRevisions {
  let next = state;
  for (const table of tables) next = bumpRevision(next, table);
  return next;
}

/**
 * The tables a finished sync pull actually put rows in.
 *
 * `SyncedStorage` reports a count per table and writes a zero for every table
 * it merely asked about, so the zeros have to go: bumping a table nothing
 * landed in wakes its consumers for nothing, and dropping a non-zero one
 * leaves them showing rows the pull has already replaced.
 */
export function pulledTables(merged: Partial<Record<SyncTableName, number>>): SyncTableName[] {
  return SYNC_TABLES.filter((table) => (merged[table] ?? 0) > 0);
}

/**
 * The revisions the library's photo listing depends on, as one comparable
 * value.
 *
 * `repos.photos.list()` answers with a PhotoView: photo rows LEFT JOINed with
 * `photoMeta` (rating, flag, colour label, keywords), listed alongside the
 * sources they belong to. Those three tables are the only ones that can change
 * the result. An edit, a preset, a profile or a face cannot - and must not make
 * the library re-read, re-sort and re-render.
 */
export function libraryListingKey(revisions: StorageRevisions): string {
  return `${revisions.sources}.${revisions.photos}.${revisions.photoMeta}`;
}
