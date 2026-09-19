import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibraryRequestError } from './library.errors.js';
import {
  createManagedLibraryRoot,
  listAvailableLibraryRoots,
  locateConfiguredRoot,
  resolveExternalRootSelections,
} from './library.paths.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('library paths', () => {
  it('exposes opaque configured roots and resolves safe subdirectories', async () => {
    const base = await temporaryDirectory();
    const allowed = path.join(base, 'photos');
    const selected = path.join(allowed, '2025', 'trip');
    await fs.mkdir(selected, { recursive: true });

    const config = { allowedRoots: [allowed] };
    const available = await listAvailableLibraryRoots(config);
    expect(available).toHaveLength(1);
    expect(available[0]).toMatchObject({ label: 'photos', available: true });
    expect(available[0]).not.toHaveProperty('path');

    const roots = await resolveExternalRootSelections([
      { rootId: available[0].id, relativePath: '2025/trip' },
    ], config);
    expect(roots).toHaveLength(1);
    expect(roots[0].canonicalPath).toBe(await fs.realpath(selected));
    expect(roots[0].label).toBe('photos/2025/trip');
    expect(roots[0].writable).toBe(false);
  });

  it('rejects traversal outside a configured root', async () => {
    const base = await temporaryDirectory();
    const allowed = path.join(base, 'photos');
    await fs.mkdir(allowed);
    const [available] = await listAvailableLibraryRoots({ allowedRoots: [allowed] });

    await expect(resolveExternalRootSelections([
      { rootId: available.id, relativePath: '../outside' },
    ], { allowedRoots: [allowed] })).rejects.toMatchObject({
      code: 'ROOT_NOT_ALLOWED',
      statusCode: 403,
    });
  });

  it('rejects a symlink that escapes a configured root', async () => {
    const base = await temporaryDirectory();
    const allowed = path.join(base, 'photos');
    const outside = path.join(base, 'private');
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(allowed, 'escape'));
    const [available] = await listAvailableLibraryRoots({ allowedRoots: [allowed] });

    await expect(resolveExternalRootSelections([
      { rootId: available.id, relativePath: 'escape' },
    ], { allowedRoots: [allowed] })).rejects.toMatchObject({
      code: 'ROOT_NOT_ALLOWED',
      statusCode: 403,
    });
  });

  it('rejects roots that overlap PhotoLib application data', async () => {
    const base = await temporaryDirectory();
    const allowed = path.join(base, 'photos');
    const managed = path.join(allowed, '.photolib');
    await fs.mkdir(managed, { recursive: true });
    const config = { allowedRoots: [allowed], managedRoot: managed };
    const [available] = await listAvailableLibraryRoots(config);

    await expect(resolveExternalRootSelections([
      { rootId: available.id },
    ], config)).rejects.toMatchObject({
      code: 'ROOT_OVERLAPS_PHOTOLIB_DATA',
      statusCode: 409,
    });
  });

  it('locates the configured root of an absolute path and names the way down to it', async () => {
    const base = await temporaryDirectory();
    const allowed = path.join(base, 'photos');
    const nested = path.join(allowed, '2025', 'trip');
    await fs.mkdir(nested, { recursive: true });
    const config = { allowedRoots: [allowed] };
    const [available] = await listAvailableLibraryRoots(config);

    // The migration assistant hands over the ServerPath source's own root.
    const located = await locateConfiguredRoot(nested, config);
    expect(located.root.id).toBe(available.id);
    expect(located.root.label).toBe('photos');
    expect(located.relativePath).toBe('2025/trip');

    // The root itself resolves to an empty relative path, and a trailing
    // separator is not a different directory.
    expect(await locateConfiguredRoot(allowed, config)).toMatchObject({ relativePath: '' });
    expect(await locateConfiguredRoot(`${nested}/`, config)).toMatchObject({ relativePath: '2025/trip' });
  });

  it('picks the deepest configured root, so the library stays as narrow as the path', async () => {
    const base = await temporaryDirectory();
    const outer = path.join(base, 'photos');
    const inner = path.join(outer, 'archive');
    await fs.mkdir(inner, { recursive: true });
    const config = { allowedRoots: [outer, inner] };

    const located = await locateConfiguredRoot(inner, config);
    expect(located.root.label).toBe('archive');
    expect(located.relativePath).toBe('');
  });

  it('refuses a path outside every configured root, and a relative or missing one', async () => {
    const base = await temporaryDirectory();
    const allowed = path.join(base, 'photos');
    const outside = path.join(base, 'private');
    await fs.mkdir(allowed);
    await fs.mkdir(outside);
    const config = { allowedRoots: [allowed] };

    await expect(locateConfiguredRoot(outside, config)).rejects.toMatchObject({
      code: 'ROOT_NOT_ALLOWED',
      statusCode: 403,
    });
    // A sibling whose name merely starts like the root is not inside it.
    await expect(locateConfiguredRoot(`${allowed}-backup`, config)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(locateConfiguredRoot('photos/2025', config)).rejects.toMatchObject({
      code: 'INVALID_PATH',
      statusCode: 400,
    });
    await expect(locateConfiguredRoot(path.join(allowed, 'missing'), config)).rejects.toMatchObject({
      code: 'ROOT_UNAVAILABLE',
      statusCode: 409,
    });
  });

  it('refuses a path that overlaps PhotoLib application data', async () => {
    const base = await temporaryDirectory();
    const allowed = path.join(base, 'photos');
    const managed = path.join(allowed, '.photolib');
    await fs.mkdir(managed, { recursive: true });

    await expect(locateConfiguredRoot(managed, { allowedRoots: [allowed], managedRoot: managed }))
      .rejects.toMatchObject({ code: 'ROOT_OVERLAPS_PHOTOLIB_DATA', statusCode: 409 });
  });

  it('creates a managed library below the configured managed root', async () => {
    const base = await temporaryDirectory();
    const managed = path.join(base, 'managed');
    const root = await createManagedLibraryRoot(
      '27d315f5-d8cd-41f7-a9da-6a1f24748a80',
      'Managed',
      { allowedRoots: [], managedRoot: managed },
    );

    expect(root.canonicalPath).toBe(
      await fs.realpath(path.join(managed, '27d315f5-d8cd-41f7-a9da-6a1f24748a80')),
    );
    expect(root.writable).toBe(true);
  });

  it('returns a sanitized error when managed storage is disabled', async () => {
    await expect(createManagedLibraryRoot(
      '27d315f5-d8cd-41f7-a9da-6a1f24748a80',
      'Managed',
      { allowedRoots: [] },
    )).rejects.toEqual(expect.any(LibraryRequestError));
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-library-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

