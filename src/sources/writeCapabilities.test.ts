import { describe, expect, it } from 'vitest';
import type { PhotoRef, SourceProvider, WriteCapabilities } from './types';
import { ServerPathSource } from './ServerPathSource';
import { FlickrSource } from './FlickrSource';
import { LocalSource } from './LocalSource';
import { PhotoLibLibrarySource } from './PhotoLibLibrarySource';
import { writeCapabilitiesOf } from './writeCapabilities';

function provider(methods: Partial<SourceProvider> = {}): SourceProvider {
  return {
    id: 's', label: 'S', type: 'test',
    connect: async () => true,
    disconnect: async () => {},
    listPhotos: (): AsyncIterable<PhotoRef> => ({ async *[Symbol.asyncIterator]() {} }),
    getDisplayUrl: async () => '',
    getThumbnailUrl: async () => null,
    getFile: async () => null,
    ...methods,
  };
}

const trueFlags = (caps: WriteCapabilities) =>
  Object.entries(caps).filter(([, v]) => v).map(([k]) => k).sort();

describe('writeCapabilitiesOf', () => {
  it('reports nothing for a source with no write methods', () => {
    expect(trueFlags(writeCapabilitiesOf(provider()))).toEqual([]);
  });

  it('reports exactly the flags whose method exists', () => {
    const caps = writeCapabilitiesOf(provider({
      setTags: async () => true,
      deletePhotos: async () => ({ succeededIds: [], failed: [] }),
    }));
    expect(trueFlags(caps)).toEqual(['canDelete', 'canSetTags']);
  });

  it('lets writeRestrictions switch a derived flag off', () => {
    const caps = writeCapabilitiesOf(provider({
      deletePhotos: async () => ({ succeededIds: [], failed: [] }),
      writeRestrictions: () => ({ canDelete: false }),
    }));
    expect(caps.canDelete).toBe(false);
  });

  it('does not let writeRestrictions switch a flag on', () => {
    const caps = writeCapabilitiesOf(provider({ writeRestrictions: () => ({ canUpload: true }) }));
    expect(caps.canUpload).toBe(false);
  });
});

describe('the providers that used to declare capabilities by hand', () => {
  it('offers no ServerPath writes without matching backend routes', () => {
    const caps = writeCapabilitiesOf(new ServerPathSource('sp', 'Server', { serverUrl: 'https://example.test', rootPath: '/srv' }));
    expect(caps.canWriteSidecar).toBe(false);
    expect(caps.canUpload).toBe(false);
    expect(caps.canCreateAlbum).toBe(false);
  });

  it('says true for LocalSource, which does own writeSidecar', () => {
    expect(writeCapabilitiesOf(new LocalSource('l', 'Ordner')).canWriteSidecar).toBe(true);
  });

  it('keeps the library from offering a delete while it has no trash', () => {
    // deletePhotos exists unconditionally; only writeRestrictions() knows the state.
    const caps = writeCapabilitiesOf(new PhotoLibLibrarySource('lib', 'Bibliothek', { libraryId: 'l1' }));
    expect(caps.canDelete).toBe(false);
  });

  it('says false for Flickr, whose writes need OAuth 1.0a signing', () => {
    const caps = writeCapabilitiesOf(new FlickrSource('f', 'Flickr', { apiKey: 'k', userId: 'u' }));
    expect(trueFlags(caps)).toEqual([]);
  });
});
