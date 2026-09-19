import { describe, expect, it } from 'vitest';
import { LocalSource } from './LocalSource';
import { IncompleteListingError } from './IncompleteListingError';
import { createFakeDirectory } from '../test/fakeFileSystem';

async function writeFile(dir: FileSystemDirectoryHandle, name: string): Promise<FileSystemFileHandle> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write('jpeg');
  await writable.close();
  return handle;
}

/** Photos/{a.jpg, Trip/b.jpg, Locked/c.jpg, d.jpg} */
async function library() {
  const root = createFakeDirectory('Photos');
  await writeFile(root, 'a.jpg');
  await writeFile(await root.getDirectoryHandle('Trip', { create: true }), 'b.jpg');
  const locked = await root.getDirectoryHandle('Locked', { create: true });
  const lockedPhoto = await writeFile(locked, 'c.jpg');
  await writeFile(root, 'd.jpg');
  return { root, locked, lockedPhoto };
}

const denied = () => Promise.reject(new DOMException('permission denied', 'NotAllowedError'));

async function list(source: LocalSource) {
  const ids: string[] = [];
  let error: unknown = null;
  try {
    for await (const ref of source.listPhotos()) ids.push(ref.sourcePhotoId);
  } catch (e) {
    error = e;
  }
  return { ids, error };
}

describe('LocalSource listing', () => {
  it('walks a readable folder tree without complaint', async () => {
    const { root } = await library();
    await expect(list(new LocalSource('local', 'Photos', root))).resolves.toEqual({
      ids: ['a.jpg', 'Trip/b.jpg', 'Locked/c.jpg', 'd.jpg'],
      error: null,
    });
  });

  it('skips a folder it cannot read, lists the rest and then reports the listing incomplete', async () => {
    const { root, locked } = await library();
    Object.assign(locked, {
      values: () => ({ [Symbol.asyncIterator]: () => ({ next: denied }) }),
    });

    const { ids, error } = await list(new LocalSource('local', 'Photos', root));

    expect(ids).toEqual(['a.jpg', 'Trip/b.jpg', 'd.jpg']);
    expect(error).toBeInstanceOf(IncompleteListingError);
    expect((error as IncompleteListingError).reasons).toEqual(['Locked']);
  });

  it('reports a photo it cannot read the same way', async () => {
    const { root, lockedPhoto } = await library();
    Object.assign(lockedPhoto, { getFile: denied });

    const { ids, error } = await list(new LocalSource('local', 'Photos', root));

    expect(ids).toEqual(['a.jpg', 'Trip/b.jpg', 'd.jpg']);
    expect((error as IncompleteListingError).reasons).toEqual(['Locked/c.jpg']);
  });
});
