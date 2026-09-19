import initSqlJs, { type Database } from 'sql.js';
import { CATALOG_SCHEMA_SQL, type SyncTableName } from '@photolib/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { mergeRemoteRow, reconcileCollectionReferences, selectLocalSince } from './SyncedStorage';
import { applyClientOverlay } from './sqljs-init';
import { EditRepository } from './repos/EditRepository';
import { ExportRepository } from './repos/ExportRepository';
import type { CatalogStorage } from './CatalogStorage';
import type { Adjustments } from '../types';
import { createDocument, type PhotoDocument } from '../engine/DocumentModel';

let createDatabase: () => Database;

beforeAll(async () => {
  const SQL = await initSqlJs();
  createDatabase = () => {
    const db = new SQL.Database();
    db.exec(CATALOG_SCHEMA_SQL);
    applyClientOverlay(db);
    return db;
  };
});

describe('sync wire format', () => {
  it('round-trips a persisted crop in the edit document', () => {
    const source = createDatabase();
    const document = createDocument();
    document.transform.crop = { x: 0.1, y: 0.2, width: 0.7, height: 0.6 };
    new EditRepository({ db: source, flush: () => {} } as unknown as CatalogStorage, () => {}).upsert({
      contentHash: 'cropped',
      adjustments: {} as Adjustments,
      document,
    });

    const [wire] = selectLocalSince(source, 'edits', 0);
    expect(wire.document).toMatchObject({ transform: { crop: document.transform.crop } });

    const target = createDatabase();
    expect(mergeRemoteRow(target, 'edits', wire)).toBe(true);
    const stored = new EditRepository(
      { db: target, flush: () => {} } as unknown as CatalogStorage,
      () => {},
    ).getMaster('cropped');
    expect(stored?.document?.transform.crop).toEqual(document.transform.crop);
    source.close();
    target.close();
  });

  it('redacts source credentials and preserves device-local secrets on pull', () => {
    const db = createDatabase();
    db.run(
      `INSERT INTO sources (id, type, label, config, addedAt, updatedAt, deletedAt)
       VALUES ('source', 'webdav', 'DAV', ?, 1, 10, NULL)`,
      [JSON.stringify({ url: 'https://old.example', username: 'alice', password: 'local-secret' })],
    );

    const outgoing = selectLocalSince(db, 'sources', 0);
    expect(outgoing[0].config).toEqual({ url: 'https://old.example', username: 'alice' });

    expect(mergeRemoteRow(db, 'sources', {
      id: 'source',
      type: 'webdav',
      label: 'DAV',
      config: { url: 'https://new.example', username: 'alice' },
      addedAt: 1,
      updatedAt: 20,
      deletedAt: null,
    })).toBe(true);
    const config = JSON.parse(String(db.exec("SELECT config FROM sources WHERE id='source'")[0].values[0][0]));
    expect(config).toEqual({ url: 'https://new.example', username: 'alice', password: 'local-secret' });
    db.close();
  });

  it('transports stable collection and photo references instead of local IDs', () => {
    const source = createDatabase();
    source.run(
      `INSERT INTO sources (id, type, label, config, addedAt, updatedAt) VALUES ('source', 'local', 'Source', '{}', 1, 1)`,
    );
    source.run(
      `INSERT INTO photos
       (sourceId, sourcePhotoId, contentHash, name, availability, sourceRevision, indexedAt, updatedAt)
       VALUES ('source', 'photo-a', NULL, 'a.jpg', 'online', 0, 1, 1)`,
    );
    const photoId = Number(source.exec('SELECT id FROM photos')[0].values[0][0]);
    source.run(
      `INSERT INTO collections
       (syncId, name, type, parentId, rules, photoIds, createdAt, updatedAt, deletedAt)
       VALUES ('root-sync', 'Root', 'manual', NULL, NULL, '[]', 1, 10, NULL)`,
    );
    const rootId = Number(source.exec("SELECT id FROM collections WHERE syncId='root-sync'")[0].values[0][0]);
    source.run(
      `INSERT INTO collections
       (syncId, name, type, parentId, rules, photoIds, createdAt, updatedAt, deletedAt)
       VALUES ('child-sync', 'Child', 'manual', ?, NULL, ?, 2, 11, NULL)`,
      [rootId, JSON.stringify([photoId])],
    );

    const wire = selectLocalSince(source, 'collections', 0);
    expect(wire).toEqual(expect.arrayContaining([
      expect.objectContaining({
        syncId: 'child-sync',
        parentSyncId: 'root-sync',
        photoRefs: [{ sourceId: 'source', sourcePhotoId: 'photo-a' }],
      }),
    ]));
    expect(wire.find((row) => row.syncId === 'child-sync')).not.toHaveProperty('photoIds');

    const target = createDatabase();
    target.run(`INSERT INTO sources (id, type, label, config, addedAt, updatedAt) VALUES ('dummy', 'local', 'Dummy', '{}', 1, 1)`);
    target.run(`INSERT INTO sources (id, type, label, config, addedAt, updatedAt) VALUES ('source', 'local', 'Source', '{}', 1, 1)`);
    target.run(
      `INSERT INTO photos
       (sourceId, sourcePhotoId, contentHash, name, availability, sourceRevision, indexedAt, updatedAt)
       VALUES ('dummy', 'dummy', NULL, 'dummy.jpg', 'online', 0, 1, 1)`,
    );
    target.run(
      `INSERT INTO photos
       (sourceId, sourcePhotoId, contentHash, name, availability, sourceRevision, indexedAt, updatedAt)
       VALUES ('source', 'photo-a', NULL, 'a.jpg', 'online', 0, 1, 1)`,
    );
    for (const row of wire) mergeRemoteRow(target, 'collections', row);
    reconcileCollectionReferences(target, wire);

    const child = target.exec(
      `SELECT c.parentId, c.photoIds, p.syncId
       FROM collections c LEFT JOIN collections p ON p.id = c.parentId
       WHERE c.syncId = 'child-sync'`,
    )[0].values[0];
    const targetPhotoId = Number(target.exec(
      "SELECT id FROM photos WHERE sourceId='source' AND sourcePhotoId='photo-a'",
    )[0].values[0][0]);
    expect(child[2]).toBe('root-sync');
    expect(JSON.parse(String(child[1]))).toEqual([targetPhotoId]);
    // Resolving references is no local write: nothing of it goes back to the hub.
    expect(selectLocalSince(target, 'collections', 0)).toEqual([]);
    source.close();
    target.close();
  });

  it('does not reconcile references from a collection that lost LWW', () => {
    const db = createDatabase();
    db.run(
      `INSERT INTO sources (id, type, label, config, addedAt, updatedAt)
       VALUES ('source', 'local', 'Source', '{}', 1, 1)`,
    );
    db.run(
      `INSERT INTO photos
       (sourceId, sourcePhotoId, name, availability, sourceRevision, indexedAt, updatedAt)
       VALUES ('source', 'local-photo', 'local.jpg', 'online', 0, 1, 1)`,
    );
    const localPhotoId = Number(db.exec("SELECT id FROM photos WHERE sourcePhotoId='local-photo'")[0].values[0][0]);
    db.run(
      `INSERT INTO collections
       (syncId, name, type, parentId, rules, photoIds, createdAt, updatedAt, deletedAt)
       VALUES ('collection', 'Local winner', 'manual', NULL, NULL, ?, 1, 100, NULL)`,
      [JSON.stringify([localPhotoId])],
    );
    const olderRemote = {
      syncId: 'collection',
      name: 'Remote loser',
      type: 'manual',
      photoRefs: [],
      createdAt: 1,
      updatedAt: 90,
      deletedAt: null,
    };

    expect(mergeRemoteRow(db, 'collections', olderRemote)).toBe(false);
    reconcileCollectionReferences(db, [olderRemote]);

    const row = db.exec("SELECT name, photoIds, updatedAt FROM collections WHERE syncId='collection'")[0].values[0];
    expect(row).toEqual(['Local winner', JSON.stringify([localPhotoId]), 100]);
    db.close();
  });

  it('round-trips all source transport fields', () => {
    const db = createDatabase();
    db.run(
      `INSERT INTO sources (id, type, label, config, addedAt, updatedAt) VALUES ('source', 'local', 'Source', '{}', 1, 1)`,
    );
    db.run(
      `INSERT INTO photos
       (sourceId, sourcePhotoId, contentHash, name, sourcePath, availability, sourceRevision,
        indexedAt, updatedAt)
       VALUES ('source', 'photo', 'hash', 'a.raw', 'folder/a.raw', 'offline', 7, 1, 2)`,
    );

    expect(selectLocalSince(db, 'photos', 0)[0]).toMatchObject({
      sourcePath: 'folder/a.raw', availability: 'offline', sourceRevision: 7,
    });
    db.close();
  });

  it('carries an export ledger entry to the other device under one identity', () => {
    const entry = {
      contentHash: 'content', copyIndex: 0, targetSourceId: 'source', targetAssetId: 'asset',
      targetUrl: 'https://photos.example/asset', format: 'jpg' as const, editStackHash: 'stack',
      filename: 'p_edit_stack.jpg', bytes: 42, status: 'ok' as const, uploadedAt: 500, deletedAt: null,
    };
    const source = createDatabase();
    new ExportRepository({ db: source, flush: () => {} } as unknown as CatalogStorage, () => {}).record(entry);

    const [wire] = selectLocalSince(source, 'exports', 0);
    // The row number is this catalog's own; the identity that travels is syncId.
    expect(wire.id).toBeUndefined();
    expect(wire.syncId).toBe('content/0/source/stack/jpg');

    const target = createDatabase();
    expect(mergeRemoteRow(target, 'exports', wire)).toBe(true);
    const pulled = new ExportRepository(
      { db: target, flush: () => {} } as unknown as CatalogStorage,
      () => {},
    );
    expect(pulled.latestFor('content', 0, 'source')).toMatchObject({
      syncId: 'content/0/source/stack/jpg',
      targetAssetId: 'asset',
      editStackHash: 'stack',
      bytes: 42,
    });

    // The same export made here before the pull arrived is the same row, not a second one.
    pulled.record({ ...entry, targetAssetId: 'asset-made-here', uploadedAt: 900 });
    expect(pulled.listForHash('content')).toHaveLength(1);
    source.close();
    target.close();
  });
});

describe('the undo stack stays on this device', () => {
  /** Fifty documents, the depth persistToDb keeps locally. */
  const deepHistory = Array.from({ length: 50 }, (_, index) => ({ version: index + 1 }));

  function editsRepo(db: Database): EditRepository {
    return new EditRepository({ db, flush: () => {} } as unknown as CatalogStorage, () => {});
  }

  it('writes the full local history but sends a row without the key', () => {
    const db = createDatabase();
    editsRepo(db).upsert({
      contentHash: 'hash',
      adjustments: {} as Adjustments,
      document: { version: 9 } as unknown as PhotoDocument,
      history: [],
      documentHistory: deepHistory as unknown as PhotoDocument[],
    });

    // Local read-back keeps every step; undo in the app is untouched.
    expect(editsRepo(db).getMaster('hash')?.documentHistory).toHaveLength(50);

    const [wire] = selectLocalSince(db, 'edits', 0);
    expect(Object.keys(wire)).not.toContain('documentHistory');
    expect(wire.documentHistory).toBeUndefined();
    expect(JSON.stringify(wire)).not.toContain('documentHistory');
    // The rest of the row still goes out.
    expect(wire).toMatchObject({ contentHash: 'hash', copyIndex: 0, document: { version: 9 } });
    db.close();
  });

  it('keeps the local history when an older client pushes its own', () => {
    const db = createDatabase();
    editsRepo(db).upsert({
      contentHash: 'hash',
      adjustments: {} as Adjustments,
      document: { version: 1 } as unknown as PhotoDocument,
      documentHistory: deepHistory as unknown as PhotoDocument[],
    });

    expect(mergeRemoteRow(db, 'edits', {
      contentHash: 'hash',
      copyIndex: 0,
      adjustments: { exposure: 1 },
      document: { version: 2 },
      history: [],
      documentHistory: [{ version: 99 }],
      createdAt: 1,
      updatedAt: Date.now() + 60_000,
    })).toBe(true);

    const stored = editsRepo(db).getMaster('hash');
    expect(stored?.document).toEqual({ version: 2 });
    expect(stored?.documentHistory).toEqual(deepHistory);
    db.close();
  });

  it('leaves a pulled row without an undo stack instead of adopting a foreign one', () => {
    const db = createDatabase();
    expect(mergeRemoteRow(db, 'edits', {
      contentHash: 'fresh',
      copyIndex: 0,
      adjustments: {},
      document: { version: 1 },
      documentHistory: [{ version: 42 }],
      createdAt: 1,
      updatedAt: 10,
    })).toBe(true);

    expect(editsRepo(db).getMaster('fresh')?.documentHistory).toBeNull();
    db.close();
  });
});

describe('push selection by localSeq', () => {
  it('selects local rows in write order after the given localSeq, whatever their updatedAt says', () => {
    const db = createDatabase();
    for (const [syncId, updatedAt] of [['first', 300], ['second', 100], ['third', 200]] as const) {
      db.run(
        `INSERT INTO presets (syncId, name, adjustments, createdAt, updatedAt) VALUES (?, ?, '{}', 1, ?)`,
        [syncId, syncId, updatedAt],
      );
    }

    expect(selectLocalSince(db, 'presets', 0).map((row) => [row.syncId, row.localSeq]))
      .toEqual([['first', 1], ['second', 2], ['third', 3]]);
    expect(selectLocalSince(db, 'presets', 2).map((row) => row.syncId)).toEqual(['third']);
    db.close();
  });

  it('still selects a local write stamped before a row pulled from a clock running ahead', () => {
    const db = createDatabase();
    const ahead = 2_000_000;
    mergeRemoteRow(db, 'edits', { contentHash: 'from-ahead', copyIndex: 0, adjustments: {}, updatedAt: ahead });
    db.run(
      `INSERT INTO edits (contentHash, copyIndex, adjustments, createdAt, updatedAt)
       VALUES ('local', 0, '{}', 1, ?)`,
      [ahead - 30 * 60 * 1000],
    );

    expect(selectLocalSince(db, 'edits', 0).map((row) => row.contentHash)).toEqual(['local']);
    db.close();
  });
});

interface MergeCase {
  table: SyncTableName;
  wire(updatedAt: number): Record<string, unknown>;
}

const MERGE_CASES: MergeCase[] = [
  { table: 'sources', wire: (updatedAt) => ({ id: 's', type: 'local', label: 'S', config: {}, addedAt: 1, updatedAt }) },
  { table: 'photos', wire: (updatedAt) => ({ sourceId: 's', sourcePhotoId: 'p', name: 'p.jpg', updatedAt }) },
  { table: 'photoMeta', wire: (updatedAt) => ({ contentHash: 'h', rating: 2, keywords: [], updatedAt }) },
  { table: 'edits', wire: (updatedAt) => ({ contentHash: 'h', copyIndex: 0, adjustments: {}, updatedAt }) },
  { table: 'presets', wire: (updatedAt) => ({ syncId: 'x', name: 'P', adjustments: {}, updatedAt }) },
  {
    table: 'developProfiles',
    wire: (updatedAt) => ({ syncId: 'x', name: 'D', scope: 'camera', key: 'k', adjustments: {}, updatedAt }),
  },
  { table: 'lensProfiles', wire: (updatedAt) => ({ syncId: 'x', name: 'L', key: 'k', coefficients: {}, updatedAt }) },
  { table: 'collections', wire: (updatedAt) => ({ syncId: 'x', name: 'C', type: 'manual', updatedAt }) },
  {
    table: 'exports',
    wire: (updatedAt) => ({
      syncId: 'h/0/s/e/jpg', contentHash: 'h', copyIndex: 0, targetSourceId: 's',
      targetAssetId: 'a', targetUrl: null, format: 'jpg', editStackHash: 'e',
      filename: 'p.jpg', bytes: 1, status: 'ok', uploadedAt: 1, updatedAt,
    }),
  },
];

describe.each(MERGE_CASES)('mergeRemoteRow into $table', ({ table, wire }) => {
  it('marks inserted and updated rows as pulled, so they are never pushed back, and a later local write as local', () => {
    const db = createDatabase();

    expect(mergeRemoteRow(db, table, wire(100))).toBe(true);
    expect(selectLocalSince(db, table, 0)).toEqual([]);
    // Checked after each update: every one has to move localSeq, or the
    // trigger takes it for a local write.
    expect(mergeRemoteRow(db, table, wire(200))).toBe(true);
    expect(selectLocalSince(db, table, 0)).toEqual([]);
    expect(mergeRemoteRow(db, table, wire(300))).toBe(true);
    expect(selectLocalSince(db, table, 0)).toEqual([]);

    db.run(`UPDATE ${table} SET updatedAt = 400`);
    expect(selectLocalSince(db, table, 0).map((row) => row.updatedAt)).toEqual([400]);
    db.close();
  });
});
