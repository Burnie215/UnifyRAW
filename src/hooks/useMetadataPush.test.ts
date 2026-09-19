import { describe, expect, it } from 'vitest';
import type { PhotoRef, SourceProvider } from '../sources/types';
import {
  REJECT_KEYWORD,
  canPushMetadata,
  metadataPushToast,
  planMetadataPush,
  pushMetadata,
  type MetadataPushPhoto,
  type MetadataPushResult,
} from './useMetadataPush';

function provider(label: string, methods: Partial<SourceProvider> = {}): SourceProvider {
  return {
    id: label.toLowerCase(), label, type: 'test',
    connect: async () => true,
    disconnect: async () => {},
    listPhotos: (): AsyncIterable<PhotoRef> => ({ async *[Symbol.asyncIterator]() {} }),
    getDisplayUrl: async () => '',
    getThumbnailUrl: async () => null,
    getFile: async () => null,
    ...methods,
  };
}

function photo(patch: Partial<MetadataPushPhoto> = {}): MetadataPushPhoto {
  return {
    sourceId: 'src', sourcePhotoId: 'a1', name: 'DSC_0001.NEF',
    rating: null, flag: null, keywords: [],
    ...patch,
  };
}

/** t() hands back the key plus its arguments, so assertions read the wiring. */
const t = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}(${Object.entries(opts).map(([k, v]) => `${k}=${String(v)}`).join(',')})` : key;

describe('planMetadataPush', () => {
  it('says nothing about a photo without rating, flag or keywords', () => {
    expect(planMetadataPush(photo())).toEqual({});
  });

  it('sends the rating, rounded into 1-5', () => {
    expect(planMetadataPush(photo({ rating: 4 })).rating).toBe(4);
    expect(planMetadataPush(photo({ rating: 9 })).rating).toBe(5);
  });

  it('does not push a cleared rating, because clearing is an absence', () => {
    expect(planMetadataPush(photo({ rating: 0 })).rating).toBeUndefined();
    expect(planMetadataPush(photo({ rating: null })).rating).toBeUndefined();
  });

  it('turns the pick flag into a favourite and never into an un-favourite', () => {
    expect(planMetadataPush(photo({ flag: 'pick' })).favorite).toBe(true);
    expect(planMetadataPush(photo({ flag: null })).favorite).toBeUndefined();
    expect(planMetadataPush(photo({ flag: 'reject' })).favorite).toBeUndefined();
  });

  it('carries the reject flag as a keyword, since no source has such a flag', () => {
    expect(planMetadataPush(photo({ flag: 'reject', keywords: ['Alpen'] })).keywords)
      .toEqual(['Alpen', REJECT_KEYWORD]);
  });

  it('adds the reject keyword only once', () => {
    expect(planMetadataPush(photo({ flag: 'reject', keywords: [REJECT_KEYWORD] })).keywords)
      .toEqual([REJECT_KEYWORD]);
  });

  it('leaves an empty keyword list out, so setTags cannot wipe source tags', () => {
    expect(planMetadataPush(photo({ keywords: ['   '] })).keywords).toBeUndefined();
  });
});

describe('pushMetadata', () => {
  const full = (calls: string[]) => provider('Lychee', {
    setRating: async (_ref, rating) => { calls.push(`rating:${rating}`); return true; },
    setFavorite: async (_ref, favorite) => { calls.push(`favorite:${favorite}`); return true; },
    setTags: async (_ref, tags) => { calls.push(`tags:${tags.join('|')}`); return true; },
  });

  it('calls only the setters the source implements', async () => {
    const calls: string[] = [];
    const result = await pushMetadata(
      [photo({ rating: 3, flag: 'pick', keywords: ['Alpen'] })],
      () => full(calls),
    );
    expect(calls).toEqual(['rating:3', 'favorite:true', 'tags:Alpen']);
    expect(result).toMatchObject({ photos: 1, attempted: 3, applied: 3, skipped: [], failed: [] });
  });

  it('names the field a source cannot write instead of swallowing it', async () => {
    // Immich: setFavorite and setTags, no setRating.
    const calls: string[] = [];
    const immich = provider('Immich', {
      setFavorite: async () => { calls.push('favorite'); return true; },
      setTags: async () => { calls.push('tags'); return true; },
    });
    const result = await pushMetadata(
      [photo({ rating: 5, flag: 'pick', keywords: ['Alpen'] })],
      () => immich,
    );
    expect(calls).toEqual(['favorite', 'tags']);
    expect(result.skipped).toEqual([{ field: 'rating', source: 'Immich' }]);
    expect(result).toMatchObject({ attempted: 2, applied: 2 });
  });

  it('reports each field/source pair once, however many photos hit it', async () => {
    const immich = provider('Immich', { setTags: async () => true });
    const result = await pushMetadata(
      [photo({ rating: 1 }), photo({ rating: 2 }), photo({ rating: 3 })],
      () => immich,
    );
    expect(result.skipped).toEqual([{ field: 'rating', source: 'Immich' }]);
    expect(result.photos).toBe(3);
  });

  it('counts a refused write as failed, not as applied', async () => {
    const result = await pushMetadata(
      [photo({ rating: 2 })],
      () => provider('Lychee', { setRating: async () => false }),
    );
    expect(result.failed).toEqual([{ field: 'rating', source: 'Lychee' }]);
    expect(result).toMatchObject({ attempted: 1, applied: 0 });
  });

  it('survives a setter that throws and books it as failed', async () => {
    const result = await pushMetadata(
      [photo({ keywords: ['Alpen'] })],
      () => provider('Lychee', { setTags: async () => { throw new Error('offline'); } }),
    );
    expect(result.failed).toEqual([{ field: 'keywords', source: 'Lychee' }]);
  });

  it('counts a photo whose source is not connected as offline', async () => {
    const result = await pushMetadata([photo({ rating: 4 })], () => undefined);
    expect(result).toMatchObject({ offline: 1, photos: 0, attempted: 0 });
  });

  it('does not count a photo that has nothing to say', async () => {
    const calls: string[] = [];
    const result = await pushMetadata([photo()], () => full(calls));
    expect(calls).toEqual([]);
    expect(result.photos).toBe(0);
  });

  it('hands the source a ref it can resolve', async () => {
    let seen: PhotoRef | null = null;
    await pushMetadata(
      [photo({ rating: 4, sourceId: 'lychee-1', sourcePhotoId: 'p42', name: 'x.jpg' })],
      () => provider('Lychee', { setRating: async (ref) => { seen = ref; return true; } }),
    );
    expect(seen).toEqual({ sourceId: 'lychee-1', sourcePhotoId: 'p42', name: 'x.jpg' });
  });
});

describe('metadataPushToast', () => {
  const base: MetadataPushResult = {
    photos: 1, applied: 1, attempted: 1, skipped: [], failed: [], offline: 0,
  };

  it('stays informational when everything landed', () => {
    const spec = metadataPushToast(base, t);
    expect(spec.kind).toBe('info');
    expect(spec.message).toContain('metadataPush.done(applied=1,attempted=1)');
  });

  it('names the skipped field and its source', () => {
    const spec = metadataPushToast(
      { ...base, skipped: [{ field: 'rating', source: 'Immich' }] },
      t,
    );
    expect(spec.kind).toBe('warning');
    expect(spec.message).toContain('metadataPush.fields.rating');
    expect(spec.message).toContain('source=Immich');
  });

  it('turns red once a write actually failed', () => {
    const spec = metadataPushToast(
      { ...base, failed: [{ field: 'keywords', source: 'Lychee' }] },
      t,
    );
    expect(spec.kind).toBe('error');
    expect(spec.message).toContain('metadataPush.failed');
  });

  it('says so when there was nothing to send at all', () => {
    const spec = metadataPushToast({ ...base, photos: 0, applied: 0, attempted: 0 }, t);
    expect(spec.message).toBe('metadataPush.nothing');
  });
});

describe('canPushMetadata', () => {
  it('is false for a source with none of the three setters', () => {
    expect(canPushMetadata(provider('Ordner'))).toBe(false);
    expect(canPushMetadata(undefined)).toBe(false);
  });

  it('is true as soon as one setter exists', () => {
    expect(canPushMetadata(provider('Immich', { setTags: async () => true }))).toBe(true);
  });
});
