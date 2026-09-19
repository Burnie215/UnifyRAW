import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAllowedExistingPath } from './allowed-path.js';

let temporaryRoot: string;

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-allowed-path-'));
});

afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('allowed server paths', () => {
  it('accepts an existing child and rejects sibling prefix tricks', async () => {
    const root = path.join(temporaryRoot, 'photos');
    const sibling = path.join(temporaryRoot, 'photos-secret');
    await fs.mkdir(root);
    await fs.mkdir(sibling);
    const photo = path.join(root, 'photo.jpg');
    const secret = path.join(sibling, 'secret.jpg');
    await fs.writeFile(photo, 'photo');
    await fs.writeFile(secret, 'secret');

    expect(await resolveAllowedExistingPath(photo, [root])).toBe(await fs.realpath(photo));
    expect(await resolveAllowedExistingPath(secret, [root])).toBeNull();
  });

  it('does not let a root below the requested path authorize it', async () => {
    const root = path.join(temporaryRoot, 'photos');
    await fs.mkdir(root);

    expect(await resolveAllowedExistingPath(temporaryRoot, [root])).toBeNull();
  });

  it('rejects a symlink that leaves an allowed root', async () => {
    const root = path.join(temporaryRoot, 'photos');
    const outside = path.join(temporaryRoot, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.jpg'), 'secret');
    await fs.symlink(outside, path.join(root, 'escape'));

    expect(await resolveAllowedExistingPath(path.join(root, 'escape', 'secret.jpg'), [root])).toBeNull();
  });

  it('allows a configured root that is itself a symlink', async () => {
    const realRoot = path.join(temporaryRoot, 'real-photos');
    const configuredRoot = path.join(temporaryRoot, 'photos-link');
    await fs.mkdir(realRoot);
    await fs.symlink(realRoot, configuredRoot);
    const photo = path.join(configuredRoot, 'photo.jpg');
    await fs.writeFile(photo, 'photo');

    expect(await resolveAllowedExistingPath(photo, [configuredRoot])).toBe(await fs.realpath(photo));
  });
});
