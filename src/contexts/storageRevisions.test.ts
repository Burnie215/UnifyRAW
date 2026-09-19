import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_ONLY_TABLES, SYNC_TABLES } from '@photolib/shared';
import { MemoryStorage } from '../storage/MemoryStorage';
import { buildRepositories, type Repositories } from '../storage/repos';
import type { PhotoRow } from '../storage/repos';
import { defaultAdjustments } from '../types';
import {
  bumpRevision,
  bumpRevisions,
  createRevisions,
  libraryListingKey,
  pulledTables,
  type StorageRevisions,
} from './storageRevisions';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

describe('bumpRevision', () => {
  it('moves one table and `all`, and leaves every other counter untouched', () => {
    const before = createRevisions();
    const after = bumpRevision(before, 'edits');

    expect(after.edits).toBe(before.edits + 1);
    expect(after.all).toBe(before.all + 1);
    expect(after.photos).toBe(before.photos);
    expect(after.photoMeta).toBe(before.photoMeta);
    expect(after.sources).toBe(before.sources);
    expect(after.presets).toBe(before.presets);
  });

  it('gives every catalog table a counter of its own', () => {
    const state = createRevisions();
    for (const table of [...SYNC_TABLES, ...LOCAL_ONLY_TABLES]) {
      expect(state[table], table).toBe(0);
    }
  });
});

describe('bumpRevisions', () => {
  it('moves each pulled table once and leaves the rest alone', () => {
    const after = bumpRevisions(createRevisions(), ['photos', 'edits']);

    expect(after.photos).toBe(1);
    expect(after.edits).toBe(1);
    expect(after.presets).toBe(0);
    expect(after.all).toBe(2);
  });

  it('changes nothing when a cycle merged no row', () => {
    const before = createRevisions();
    expect(bumpRevisions(before, [])).toBe(before);
  });
});

describe('pulledTables', () => {
  it('names the tables the pull put rows in, and only those', () => {
    expect(pulledTables({ photos: 3, presets: 0, edits: 12 })).toEqual(['photos', 'edits']);
  });

  it('names nothing when every table answered empty', () => {
    expect(pulledTables({ photos: 0, edits: 0 })).toEqual([]);
  });
});

/**
 * The library's reload effect without React: a key derived from the revisions,
 * and a re-read of the photo table whenever that key changes. `photos.list()`
 * is the query F086 is about - a write that must not reach the library shows
 * up here as zero reads.
 */
function libraryConsumer(
  repos: Repositories,
  keyOf: (revisions: StorageRevisions) => string,
  from: StorageRevisions,
) {
  let key = keyOf(from);
  const counted = { reads: 0 };
  return {
    counted,
    apply(revisions: StorageRevisions): void {
      const next = keyOf(revisions);
      if (next === key) return;
      key = next;
      repos.sources.list();
      repos.photos.list();
      counted.reads++;
    },
  };
}

function listed(): Omit<PhotoRow, 'id' | 'updatedAt' | 'deletedAt'> {
  return {
    sourceId: 'local-1',
    sourcePhotoId: 'IMG_0001.CR3',
    contentHash: 'c0ffee',
    name: 'IMG_0001.CR3',
    mimeType: 'image/x-canon-cr3',
    sizeBytes: 25_000_000,
    dateTaken: 1_700_000_000_000,
    dateModified: 1_700_000_000_000,
    sourcePath: null,
    availability: 'online',
    sourceRevision: 0,
    indexedAt: 1_000,
    width: null, height: null, sourceBits: null,
    camera: null, lens: null, iso: null, focalLength: null, aperture: null, shutterSpeed: null,
    latitude: null, longitude: null, blurHash: null, stackId: null, stackPosition: null,
  };
}

describe('what a write costs the library listing', () => {
  let storage: MemoryStorage;
  let repos: Repositories;
  let revisions: StorageRevisions;
  /** How the single counter behaved before the split: every write, every table. */
  let oneCounter: ReturnType<typeof libraryConsumer>;
  let perTable: ReturnType<typeof libraryConsumer>;
  let photoId: number;

  beforeEach(async () => {
    storage = await MemoryStorage.create();
    revisions = createRevisions();
    const listeners: Array<(revisions: StorageRevisions) => void> = [];
    repos = buildRepositories(storage, (table) => {
      revisions = bumpRevision(revisions, table);
      for (const notify of listeners) notify(revisions);
    });

    photoId = repos.photos.add(listed());

    oneCounter = libraryConsumer(repos, (r) => String(r.all), revisions);
    perTable = libraryConsumer(repos, libraryListingKey, revisions);
    listeners.push((r) => oneCounter.apply(r), (r) => perTable.apply(r));
  });

  afterEach(async () => {
    await storage.close();
  });

  it('ten slider stops write ten edits and the library reads nothing', () => {
    for (let index = 0; index < 10; index++) {
      repos.edits.upsert({ contentHash: 'c0ffee', copyIndex: 0, adjustments: defaultAdjustments });
    }

    // One counter for the whole catalog meant ten full re-reads of the photo
    // table, each with its sort, its aggregations and a filmstrip render.
    expect(oneCounter.counted.reads).toBe(10);
    expect(perTable.counted.reads).toBe(0);
  });

  it('a photo write still reaches the library', () => {
    repos.photos.update(photoId, { name: 'IMG_0002.CR3' });
    expect(perTable.counted.reads).toBe(1);
  });

  it('a rating still reaches the library, because PhotoView joins photoMeta', () => {
    repos.photoMeta.set('c0ffee', { rating: 3 });
    expect(perTable.counted.reads).toBe(1);
  });

  it('a source write still reaches the library', () => {
    repos.sources.put({ id: 'local-2', type: 'local', label: 'Bilder', config: {}, addedAt: 1 });
    expect(perTable.counted.reads).toBe(1);
  });

  it('presets and collections leave the library alone', () => {
    repos.presets.add({ name: 'Kontrast', adjustments: {} });
    repos.collections.add({ name: 'Reise', type: 'manual' });

    expect(oneCounter.counted.reads).toBe(2);
    expect(perTable.counted.reads).toBe(0);
  });

  it('a pull that merged photo rows still reaches the library', () => {
    // SyncedStorage merges pulled rows straight into sql.js, past the repos;
    // StorageContext.onAfterPull bumps the tables the pull touched.
    perTable.apply(bumpRevisions(revisions, pulledTables({ photos: 4, edits: 0 })));
    expect(perTable.counted.reads).toBe(1);
  });

  it('a pull that merged only edits leaves the library alone', () => {
    perTable.apply(bumpRevisions(revisions, pulledTables({ photos: 0, edits: 7 })));
    expect(perTable.counted.reads).toBe(0);
  });
});
