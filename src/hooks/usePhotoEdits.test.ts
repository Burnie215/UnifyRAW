import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../storage/MemoryStorage';
import { buildRepositories, type Repositories } from '../storage/repos';
import { buildSidecar, serializeSidecar } from '../engine/Sidecar';
import { LocalSource } from '../sources/LocalSource';
import { createFakeDirectory, readFakeFile } from '../test/fakeFileSystem';
import { defaultAdjustments, type Adjustments } from '../types';
import {
  createDocument,
  documentToAdjustments,
  applyAdjustmentsToDocument,
} from '../engine/DocumentModel';
import { applySidecar, historyForPersistence, loadEditHistory } from './usePhotoEdits';

// sqljs-init passes the Vite `?url` asset path ('/node_modules/...') as the
// wasm location, which node cannot open; without it sql.js finds its own wasm.
vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  return { ...actual, default: () => actual.default() };
});

const HASH = '3a1f00ddcafe';

/** Hand-written, so the assertion does not depend on the writer being right. */
function sidecarText(updatedAt: number, meta: string): string {
  return `{"version":1,"contentHash":"${HASH}","edits":[],${meta},"updatedAt":${updatedAt}}`;
}

describe('applySidecar', () => {
  let repos: Repositories;

  beforeEach(async () => {
    repos = buildRepositories(await MemoryStorage.create(), () => {});
  });

  it('writes the sidecar metadata into the catalog when the sidecar is the newer side', () => {
    const result = applySidecar(
      sidecarText(2_000, '"rating":4,"flag":"pick","colorLabel":"green","keywords":["Alpen"]'),
      HASH,
      [{ copyIndex: 0, updatedAt: 1_000 }],
      repos,
    );

    expect(result.metaApplied).toBe(true);
    const row = repos.photoMeta.get(HASH);
    expect(row?.rating).toBe(4);
    expect(row?.flag).toBe('pick');
    expect(row?.colorLabel).toBe('green');
    expect(row?.keywords).toEqual(['Alpen']);
  });

  it('leaves the catalog alone when the local edits are newer', () => {
    repos.photoMeta.set(HASH, { rating: 1 });

    const result = applySidecar(
      sidecarText(2_000, '"rating":4'),
      HASH,
      [{ copyIndex: 0, updatedAt: 5_000 }],
      repos,
    );

    expect(result.metaApplied).toBe(false);
    expect(repos.photoMeta.get(HASH)?.rating).toBe(1);
  });

  it('only touches the fields the sidecar carries', () => {
    repos.photoMeta.set(HASH, { rating: 3, flag: 'reject' });

    applySidecar(sidecarText(2_000, '"rating":5'), HASH, [], repos);

    expect(repos.photoMeta.get(HASH)?.rating).toBe(5);
    expect(repos.photoMeta.get(HASH)?.flag).toBe('reject');
  });

  it('ignores a sidecar that belongs to another photo', () => {
    const result = applySidecar(sidecarText(2_000, '"rating":4'), 'a-different-hash', [], repos);

    expect(result).toEqual({ editsApplied: 0, metaApplied: false });
    expect(repos.photoMeta.get('a-different-hash')).toBeNull();
  });

  it('takes the sidecar edits that are newer than the local ones', () => {
    const sidecar = serializeSidecar(
      buildSidecar(HASH, [
        { copyIndex: 0, adjustments: { ...defaultAdjustments, exposure: 42 }, updatedAt: 9_000 },
      ]),
    );

    const result = applySidecar(sidecar, HASH, [{ copyIndex: 0, updatedAt: 1_000 }], repos);

    expect(result.editsApplied).toBe(1);
    expect(repos.edits.getCopy(HASH, 0)?.adjustments.exposure).toBe(42);
  });
});

describe('edit history persistence', () => {
  let repos: Repositories;
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = await MemoryStorage.create();
    repos = buildRepositories(storage, () => {});
  });

  it('stores document history once and restores all 50 retained undo steps', () => {
    const documents = Array.from({ length: 60 }, (_, exposure) => applyAdjustmentsToDocument(
      createDocument(),
      { ...defaultAdjustments, exposure },
    ));
    const persisted = historyForPersistence(documents);

    repos.edits.upsert({
      contentHash: HASH,
      adjustments: documentToAdjustments(documents.at(-1)!),
      document: documents.at(-1),
      ...persisted,
    });

    const raw = repos.edits.getMaster(HASH)!;
    const columns = storage.db.exec(
      'SELECT history, documentHistory FROM edits WHERE contentHash = ?',
      [HASH],
    )[0].values[0];
    const duplicateHistoryBytes = JSON.stringify(
      persisted.documentHistory.map(documentToAdjustments),
    ).length;

    expect(columns[0]).toBe('[]');
    expect(String(columns[0])).toHaveLength(2);
    expect(duplicateHistoryBytes).toBeGreaterThan(50_000);
    expect(JSON.parse(String(columns[1]))).toHaveLength(50);
    expect(loadEditHistory(raw).map((doc) => documentToAdjustments(doc).exposure))
      .toEqual(Array.from({ length: 50 }, (_, index) => index + 10));
  });

  it('still lifts a legacy flat-only history row into documents', () => {
    const legacy = { ...defaultAdjustments, exposure: 37 } as Adjustments;
    repos.edits.upsert({
      contentHash: HASH,
      adjustments: legacy,
      history: [legacy],
      documentHistory: null,
    });

    const row = repos.edits.getMaster(HASH)!;
    expect(row.documentHistory).toBeNull();
    expect(loadEditHistory(row)).toHaveLength(1);
    expect(documentToAdjustments(loadEditHistory(row)[0]).exposure).toBe(37);
  });
});

describe('a LocalSource folder as the sidecar carrier', () => {
  it('stores what buildSidecar produced and hands it back to applySidecar', async () => {
    const root = createFakeDirectory();
    const source = new LocalSource('local-1', 'Bilder', root);
    const ref = { sourcePhotoId: 'Urlaub 2024/DSC_0042.CR3', sourceId: 'local-1', name: 'DSC_0042.CR3' };
    const repos = buildRepositories(await MemoryStorage.create(), () => {});
    repos.photoMeta.set(HASH, { rating: 4, flag: 'pick' });

    const meta = repos.photoMeta.get(HASH)!;
    const written = await source.writeSidecar(
      ref,
      serializeSidecar(buildSidecar(HASH, [], { rating: meta.rating ?? undefined, flag: meta.flag })),
    );
    expect(written).toBe(true);

    // What actually landed on disk, asserted by value.
    await source.store!.flushIndex();
    const index = JSON.parse(await (await readFakeFile(root, '.photolib/index.json'))!.text());
    const stored = JSON.parse(index.entries['Urlaub 2024/DSC_0042.CR3'].e);
    expect(stored.version).toBe(1);
    expect(stored.contentHash).toBe(HASH);
    expect(stored.rating).toBe(4);
    expect(stored.flag).toBe('pick');

    // And the read path a reopened catalog takes.
    const fresh = buildRepositories(await MemoryStorage.create(), () => {});
    const raw = await source.readSidecar(ref);
    expect(raw).not.toBeNull();
    expect(applySidecar(raw!, HASH, [], fresh).metaApplied).toBe(true);
    expect(fresh.photoMeta.get(HASH)?.rating).toBe(4);
    expect(fresh.photoMeta.get(HASH)?.flag).toBe('pick');
  });
});
