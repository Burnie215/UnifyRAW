import { describe, expect, it } from 'vitest';
import { matchesLibraryExclusion, mediaTypeForPath } from './library.media.js';

describe('library media helpers', () => {
  it('recognizes supported media extensions case-insensitively', () => {
    expect(mediaTypeForPath('IMG_0001.JPG')).toEqual({
      extension: '.jpg',
      mimeType: 'image/jpeg',
    });
    expect(mediaTypeForPath('capture.CR3')?.mimeType).toBe('image/x-canon-cr3');
    expect(mediaTypeForPath('SONY_0001.HIF')).toEqual({
      extension: '.hif',
      mimeType: 'image/heif',
    });
    expect(mediaTypeForPath('notes.txt')).toBeNull();
  });

  it('matches relative glob exclusions without filesystem access', () => {
    const patterns = ['**/cache/**', '*.tmp', 'private/?.jpg'];
    expect(matchesLibraryExclusion('cache/', patterns, true)).toBe(true);
    expect(matchesLibraryExclusion('trip/cache/thumb.jpg', patterns, false)).toBe(true);
    expect(matchesLibraryExclusion('preview.tmp', patterns, false)).toBe(true);
    expect(matchesLibraryExclusion('private/a.jpg', patterns, false)).toBe(true);
    expect(matchesLibraryExclusion('private/ab.jpg', patterns, false)).toBe(false);
    expect(matchesLibraryExclusion('trip/photo.jpg', patterns, false)).toBe(false);
  });
});
