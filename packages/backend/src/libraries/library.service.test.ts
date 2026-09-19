import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBackendMigrations } from '../db/migrations.js';
import { LibraryAssetRepository } from './library.asset.repository.js';
import { LibraryImportRepository } from './library.import.repository.js';
import { LibraryRepository } from './library.repository.js';
import { LibraryService } from './library.service.js';

let db: Database;
let temporaryRoot: string;
let externalRoot: string;
let managedRoot: string;
let service: LibraryService;

beforeEach(async () => {
  const SQL = await initSqlJs();
  db = new SQL.Database();
  runBackendMigrations(db);
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-library-service-'));
  externalRoot = path.join(temporaryRoot, 'external');
  managedRoot = path.join(temporaryRoot, 'managed');
  await fs.mkdir(externalRoot);
  service = new LibraryService(new LibraryRepository(db), {
    allowedRoots: [externalRoot],
    managedRoot,
  });
});

afterEach(async () => {
  db.close();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('LibraryService', () => {
  it('creates, updates, scopes and removes an external library without touching files', async () => {
    const original = path.join(externalRoot, 'keep-me.jpg');
    await fs.writeFile(original, 'test image placeholder');
    const [available] = await service.availableRoots();

    const created = await service.create('alice', {
      name: ' Archive ',
      mode: 'external',
      roots: [{ rootId: available.id }],
      exclusionPatterns: ['**/cache/**', '**/cache/**'],
    });

    expect(created).toMatchObject({
      name: 'Archive',
      mode: 'external',
      readOnly: true,
      exclusionPatterns: ['**/cache/**'],
      capabilities: { canScan: true, canImport: false, canTrash: false },
    });
    expect(created.roots[0]).not.toHaveProperty('path');
    expect(() => service.get('bob', created.id)).toThrow('Library not found');
    expect(service.list('alice')).toHaveLength(1);
    expect(service.list('bob')).toHaveLength(0);

    const updated = service.update('alice', created.id, {
      name: 'Archive 2025',
      includeHidden: true,
      scanIntervalMinutes: 60,
    });
    expect(updated).toMatchObject({
      name: 'Archive 2025',
      includeHidden: true,
      scanIntervalMinutes: 60,
    });

    service.delete('alice', created.id);
    expect(service.list('alice')).toHaveLength(0);
    expect(await fs.readFile(original, 'utf8')).toBe('test image placeholder');
  });

  it('does not allow the same external root twice for one owner', async () => {
    const [available] = await service.availableRoots();
    await service.create('alice', {
      name: 'First',
      mode: 'external',
      roots: [{ rootId: available.id }],
    });

    await expect(service.create('alice', {
      name: 'Second',
      mode: 'external',
      roots: [{ rootId: available.id }],
    })).rejects.toMatchObject({ code: 'ROOT_ALREADY_REGISTERED', statusCode: 409 });

    await expect(service.create('bob', {
      name: 'Bob archive',
      mode: 'external',
      roots: [{ rootId: available.id }],
    })).resolves.toMatchObject({ mode: 'external' });
  });

  it('creates managed storage but never deletes it with the registry entry', async () => {
    const created = await service.create('alice', {
      name: 'Managed originals',
      mode: 'managed',
    });
    const repository = new LibraryRepository(db);
    const internal = repository.get('alice', created.id);
    expect(created).toMatchObject({
      mode: 'managed',
      readOnly: false,
      capabilities: { canImport: true },
    });
    expect(internal?.roots).toHaveLength(1);
    const internalPath = internal?.roots[0].canonicalPath;
    expect(internalPath).toBeTruthy();

    expect(() => service.delete('alice', created.id)).toThrowError(
      expect.objectContaining({ code: 'MANAGED_LIBRARY_DELETE_REQUIRES_CONFIRMATION' }),
    );
    service.delete('alice', created.id, true);
    expect((await fs.stat(internalPath!)).isDirectory()).toBe(true);
  });

  it('refuses deletion while a scan or import is active', async () => {
    const repository = new LibraryRepository(db);
    const assets = new LibraryAssetRepository(db);
    const imports = new LibraryImportRepository(db);
    const [available] = await service.availableRoots();
    const external = await service.create('alice', {
      name: 'Scanning archive',
      mode: 'external',
      roots: [{ rootId: available.id }],
    });
    const scan = assets.createScan('alice', external.id, 'active-scan', Date.now());

    expect(() => service.delete('alice', external.id)).toThrowError(
      expect.objectContaining({ code: 'LIBRARY_BUSY', statusCode: 409 }),
    );
    assets.finishScan(
      'alice',
      external.id,
      scan.id,
      'completed',
      { discovered: 0, added: 0, updated: 0, offline: 0, restored: 0, errors: 0 },
      null,
      Date.now(),
    );
    service.delete('alice', external.id);

    const managed = await service.create('alice', {
      name: 'Incoming originals',
      mode: 'managed',
    });
    const pendingImport = imports.create(
      'alice',
      managed.id,
      'active-import',
      { fileName: 'photo.jpg', sizeBytes: 12 },
      Date.now(),
    );
    expect(repository.hasActiveOperations('alice', managed.id)).toBe(true);
    expect(() => service.delete('alice', managed.id, true)).toThrowError(
      expect.objectContaining({ code: 'LIBRARY_BUSY', statusCode: 409 }),
    );

    imports.setState('alice', managed.id, pendingImport.id, 'cancelled');
    expect(repository.hasActiveOperations('alice', managed.id)).toBe(false);
    service.delete('alice', managed.id, true);
  });

  it('validates requests before creating filesystem or database state', async () => {
    await expect(service.create('alice', {
      name: 'No root',
      mode: 'external',
    })).rejects.toMatchObject({ code: 'ROOT_REQUIRED', statusCode: 400 });

    await expect(service.create('alice', {
      name: 'Managed',
      mode: 'managed',
      roots: [{ rootId: 'a'.repeat(24) }],
    })).rejects.toMatchObject({
      code: 'MANAGED_ROOT_IS_SERVER_CONTROLLED',
      statusCode: 400,
    });
    expect(service.list('alice')).toHaveLength(0);
  });
});
