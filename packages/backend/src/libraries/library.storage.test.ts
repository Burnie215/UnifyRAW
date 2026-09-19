import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBackendMigrations } from '../db/migrations.js';
import { LibraryAssetRepository } from './library.asset.repository.js';
import { LibraryRepository } from './library.repository.js';
import { LibraryScanner } from './library.scanner.js';
import { LibraryService } from './library.service.js';
import { LibraryStorage } from './library.storage.js';
import { LibraryThumbnailService } from './library.thumbnails.js';

let db: Database;
let temporaryRoot: string;
let externalRoot: string;
let outsideRoot: string;
let assets: LibraryAssetRepository;
let libraries: LibraryRepository;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  runBackendMigrations(db);
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-storage-test-'));
  externalRoot = path.join(temporaryRoot, 'photos');
  outsideRoot = path.join(temporaryRoot, 'outside');
  await fs.mkdir(externalRoot);
  await fs.mkdir(outsideRoot);
  assets = new LibraryAssetRepository(db);
  libraries = new LibraryRepository(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('library media storage', () => {
  it('resolves indexed originals and persists versioned thumbnails', async () => {
    const filePath = path.join(externalRoot, 'photo.jpg');
    await sharp({
      create: {
        width: 64,
        height: 48,
        channels: 3,
        background: { r: 200, g: 120, b: 20 },
      },
    }).jpeg().toFile(filePath);
    const library = await createAndScanLibrary();
    const asset = assets.listAssets('alice', library.id, null, 10).assets[0];
    const storage = new LibraryStorage(libraries, assets);

    const original = await storage.resolveAssetFile('alice', library.id, asset.id);
    expect(original.filePath).toBe(await fs.realpath(filePath));

    const thumbnails = new LibraryThumbnailService(
      storage,
      path.join(temporaryRoot, 'thumbs'),
    );
    const first = await thumbnails.getOrCreate('alice', library.id, asset.id, 'small');
    const second = await thumbnails.getOrCreate('alice', library.id, asset.id, 'small');
    expect(second.filePath).toBe(first.filePath);
    expect((await sharp(first.filePath).metadata()).format).toBe('webp');
  });

  it('rejects a file replaced by a symlink escaping the indexed root', async () => {
    const filePath = path.join(externalRoot, 'photo.jpg');
    const outside = path.join(outsideRoot, 'private.jpg');
    await fs.writeFile(filePath, 'indexed contents');
    await fs.writeFile(outside, 'private contents');
    const library = await createAndScanLibrary();
    const asset = assets.listAssets('alice', library.id, null, 10).assets[0];

    await fs.unlink(filePath);
    await fs.symlink(outside, filePath);
    const storage = new LibraryStorage(libraries, assets);
    await expect(storage.resolveAssetFile('alice', library.id, asset.id)).rejects.toMatchObject({
      code: 'ASSET_NOT_AVAILABLE',
      statusCode: 409,
    });
  });
});

async function createAndScanLibrary() {
  const service = new LibraryService(libraries, { allowedRoots: [externalRoot] });
  const [root] = await service.availableRoots();
  const library = await service.create('alice', {
    name: 'External',
    mode: 'external',
    roots: [{ rootId: root.id }],
  });
  const scan = assets.createScan('alice', library.id, randomUUID(), Date.now());
  await new LibraryScanner(libraries, assets).run(
    'alice',
    library.id,
    scan.id,
    () => false,
  );
  return library;
}

