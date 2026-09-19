import { describe, expect, it } from 'vitest';
import type { PhotoView, SourceRow } from '../storage/repos';
import { projectAvailablePhotos } from './useAvailablePhotos';

function source(id: string): SourceRow {
  return {
    id,
    type: 'immich',
    label: id,
    config: {},
    addedAt: 1,
    updatedAt: 1,
    deletedAt: null,
  };
}

function photo(id: number, sourceId: string): PhotoView {
  return {
    id,
    sourceId,
    sourcePhotoId: `folder/${id}`,
    name: `${id}.jpg`,
    availability: 'online',
    indexedAt: 1,
    updatedAt: 1,
  } as PhotoView;
}

describe('projectAvailablePhotos', () => {
  it('keeps only photos whose source exists and is connected', () => {
    const connected = photo(1, 'connected');
    const disconnected = photo(2, 'disconnected');
    const orphaned = photo(3, 'missing');

    const result = projectAvailablePhotos(
      [connected, disconnected, orphaned],
      [source('connected'), source('disconnected')],
      ['disconnected'],
      true,
    );

    expect(result.photos).toEqual([connected]);
    expect(result.photoIds).toEqual(new Set([1]));
    expect(result.sourceIds).toEqual(new Set(['connected']));
  });

  it('exposes nothing until reconnect state has been resolved', () => {
    const result = projectAvailablePhotos(
      [photo(1, 'source')],
      [source('source')],
      [],
      false,
    );

    expect(result.photos).toEqual([]);
    expect(result.photoIds.size).toBe(0);
    expect(result.sourceIds.size).toBe(0);
  });

  it('can explicitly project missing and trashed library entries', () => {
    const online = photo(1, 'source');
    const offline = { ...photo(2, 'source'), availability: 'offline' as const };
    const trashed = { ...photo(3, 'source'), availability: 'trashed' as const };

    const result = projectAvailablePhotos(
      [online, offline, trashed],
      [source('source')],
      [],
      true,
      'unavailable',
    );

    expect(result.photos).toEqual([offline, trashed]);
  });
});
