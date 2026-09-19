import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBackendMigrations } from '../db/migrations.js';
import { LibraryAssetRepository } from './library.asset.repository.js';
import { LibraryRepository } from './library.repository.js';
import { LibraryScanner } from './library.scanner.js';
import { LibraryService } from './library.service.js';

let db: Database;
let temporaryRoot: string;
let externalRoot: string;
let libraries: LibraryRepository;
let assets: LibraryAssetRepository;
let scanner: LibraryScanner;
let service: LibraryService;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  runBackendMigrations(db);
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-scanner-test-'));
  externalRoot = path.join(temporaryRoot, 'photos');
  await fs.mkdir(externalRoot);
  libraries = new LibraryRepository(db);
  assets = new LibraryAssetRepository(db);
  scanner = new LibraryScanner(libraries, assets);
  service = new LibraryService(libraries, { allowedRoots: [externalRoot] });
});

afterEach(async () => {
  db.close();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('LibraryScanner', () => {
  it('indexes supported files while respecting exclusions and hidden files', async () => {
    await fs.mkdir(path.join(externalRoot, 'trip'));
    await fs.mkdir(path.join(externalRoot, 'cache'));
    await fs.writeFile(path.join(externalRoot, 'trip', 'photo.JPG'), 'photo bytes');
    await fs.writeFile(path.join(externalRoot, 'cache', 'ignored.jpg'), 'ignored');
    await fs.writeFile(path.join(externalRoot, '.hidden.jpg'), 'hidden');
    await fs.writeFile(path.join(externalRoot, 'notes.txt'), 'not a photo');
    const library = await createExternalLibrary(['cache/**']);

    const scan = await runScan(library.id);
    const page = assets.listAssets('alice', library.id, null, 100);

    expect(scan).toMatchObject({
      status: 'completed',
      discovered: 1,
      added: 1,
      updated: 0,
      errors: 0,
    });
    expect(page.assets).toHaveLength(1);
    expect(page.assets[0]).toMatchObject({
      relativePath: 'trip/photo.JPG',
      name: 'photo.JPG',
      status: 'online',
      mimeType: 'image/jpeg',
    });
    expect(page.assets[0].quickHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page.assets[0]).not.toHaveProperty('canonicalPath');
  });

  it('does not create revisions for unchanged files and updates changed files', async () => {
    const file = path.join(externalRoot, 'photo.jpg');
    await fs.writeFile(file, 'first version');
    const library = await createExternalLibrary();
    await runScan(library.id);
    const initial = assets.listAssets('alice', library.id, null, 10).assets[0];

    const unchanged = await runScan(library.id);
    const afterUnchanged = assets.listAssets('alice', library.id, null, 10).assets[0];
    expect(unchanged).toMatchObject({ added: 0, updated: 0, restored: 0 });
    expect(afterUnchanged.revision).toBe(initial.revision);

    await fs.writeFile(file, 'second version with a different size');
    const changed = await runScan(library.id);
    const afterChange = assets.listAssets('alice', library.id, null, 10).assets[0];
    expect(changed.updated).toBe(1);
    expect(afterChange.id).toBe(initial.id);
    expect(afterChange.revision).toBeGreaterThan(initial.revision);
    expect(afterChange.quickHash).not.toBe(initial.quickHash);
  });

  it('marks missing files offline and restores the same asset identity', async () => {
    const file = path.join(externalRoot, 'photo.jpg');
    await fs.writeFile(file, 'photo bytes');
    const library = await createExternalLibrary();
    await runScan(library.id);
    const initial = assets.listAssets('alice', library.id, null, 10).assets[0];

    await fs.unlink(file);
    const missing = await runScan(library.id);
    expect(missing.offline).toBe(1);
    expect(assets.listAssets('alice', library.id, null, 10).assets[0].status).toBe('offline');

    await fs.writeFile(file, 'photo bytes');
    const restored = await runScan(library.id);
    const online = assets.listAssets('alice', library.id, null, 10).assets[0];
    expect(restored.restored).toBe(1);
    expect(online.status).toBe('online');
    expect(online.id).toBe(initial.id);
  });

  it('preserves asset identity across an unambiguous rename', async () => {
    const original = path.join(externalRoot, 'before.jpg');
    const renamed = path.join(externalRoot, 'after.jpg');
    await fs.writeFile(original, 'unique photo bytes');
    const library = await createExternalLibrary();
    await runScan(library.id);
    const initial = assets.listAssets('alice', library.id, null, 10).assets[0];

    await fs.rename(original, renamed);
    const scan = await runScan(library.id);
    const current = assets.listAssets('alice', library.id, null, 10).assets;

    expect(scan).toMatchObject({ added: 0, offline: 0, updated: 1 });
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ id: initial.id, relativePath: 'after.jpg' });
  });

  it('does not mark assets offline when the root is unavailable', async () => {
    await fs.writeFile(path.join(externalRoot, 'photo.jpg'), 'photo bytes');
    const library = await createExternalLibrary();
    await runScan(library.id);
    await fs.rename(externalRoot, `${externalRoot}-unmounted`);

    const scan = await runScan(library.id);
    const current = assets.listAssets('alice', library.id, null, 10).assets[0];
    expect(scan).toMatchObject({ status: 'failed', offline: 0 });
    expect(current.status).toBe('online');
    expect(service.get('alice', library.id).status).toBe('error');
  });

  it('cancels before traversal without publishing missing assets', async () => {
    await fs.writeFile(path.join(externalRoot, 'photo.jpg'), 'photo bytes');
    const library = await createExternalLibrary();
    const queued = assets.createScan('alice', library.id, randomUUID(), Date.now());

    await scanner.run('alice', library.id, queued.id, () => true);

    expect(assets.getScan('alice', library.id, queued.id)?.status).toBe('cancelled');
    expect(assets.listAssets('alice', library.id, null, 10).assets).toHaveLength(0);
  });

  it('persists scan lifecycle checkpoints', async () => {
    await fs.writeFile(path.join(externalRoot, 'photo.jpg'), 'photo bytes');
    const library = await createExternalLibrary();
    const queued = assets.createScan('alice', library.id, randomUUID(), Date.now());
    let checkpoints = 0;
    const checkpointingScanner = new LibraryScanner(libraries, assets, () => {
      checkpoints++;
    });

    await checkpointingScanner.run('alice', library.id, queued.id, () => false);

    expect(checkpoints).toBeGreaterThanOrEqual(3);
    expect(assets.getScan('alice', library.id, queued.id)?.status).toBe('completed');
  });
});

async function createExternalLibrary(exclusionPatterns: string[] = []) {
  const [root] = await service.availableRoots();
  return service.create('alice', {
    name: 'External photos',
    mode: 'external',
    roots: [{ rootId: root.id }],
    exclusionPatterns,
  });
}

async function runScan(libraryId: string) {
  const queued = assets.createScan('alice', libraryId, randomUUID(), Date.now());
  await scanner.run('alice', libraryId, queued.id, () => false);
  return assets.getScan('alice', libraryId, queued.id)!;
}
