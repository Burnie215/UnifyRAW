import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDirectory } from '../test/fakeFileSystem';
import { stubWebLocks } from '../test/fakeLocks';
import { acquireCatalogLock, catalogLockName, waitForCatalogLock } from './catalogLock';

const NAME = 'photolib-catalog:opfs';

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | 'pending'> {
  return Promise.race([
    promise.then((value) => ({ value })),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
  ]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('catalogLockName', () => {
  it('names the OPFS catalog per origin and a picked folder by its name', () => {
    expect(catalogLockName('opfs', createFakeDirectory(''))).toBe('photolib-catalog:opfs');
    expect(catalogLockName('filesystem', createFakeDirectory('Fotos'))).toBe('photolib-catalog:filesystem:Fotos');
  });
});

describe('acquireCatalogLock', () => {
  it('refuses a second holder without waiting, until the first lets go', async () => {
    stubWebLocks();
    const first = await acquireCatalogLock(NAME);
    expect(first).toBeTypeOf('function');

    expect(await settleWithin(acquireCatalogLock(NAME), 200)).toEqual({ value: null });

    await first!();
    const third = await acquireCatalogLock(NAME);
    expect(third).toBeTypeOf('function');
    await third!();
  });

  it('resolves the release only once the lock is free again', async () => {
    const locks = stubWebLocks();
    const release = await acquireCatalogLock(NAME);
    await release!();
    expect(locks.isHeld(NAME)).toBe(false);
  });

  it('keeps different catalogs apart', async () => {
    stubWebLocks();
    const opfs = await acquireCatalogLock(NAME);
    const folder = await acquireCatalogLock('photolib-catalog:filesystem:Fotos');
    expect(opfs).toBeTypeOf('function');
    expect(folder).toBeTypeOf('function');
  });

  it('opens unprotected without Web Locks and says so in the log', async () => {
    vi.stubGlobal('navigator', {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    expect(await acquireCatalogLock(NAME)).toBeTypeOf('function');
    expect(await acquireCatalogLock(NAME)).toBeTypeOf('function');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('without multi-tab protection'));
  });
});

describe('waitForCatalogLock', () => {
  it('resolves once the holder lets go and leaves the lock free', async () => {
    const locks = stubWebLocks();
    const release = await acquireCatalogLock(NAME);
    const waiting = waitForCatalogLock(NAME);
    expect(await settleWithin(waiting, 50)).toBe('pending');

    await release!();
    await waiting;
    expect(locks.isHeld(NAME)).toBe(false);
    expect(await acquireCatalogLock(NAME)).toBeTypeOf('function');
  });

  it('stops waiting when aborted', async () => {
    const locks = stubWebLocks();
    const release = await acquireCatalogLock(NAME);
    const controller = new AbortController();
    const waiting = waitForCatalogLock(NAME, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

    await release!();
    expect(locks.isHeld(NAME)).toBe(false);
  });
});
