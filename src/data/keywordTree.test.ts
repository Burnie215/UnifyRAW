import { describe, expect, it } from 'vitest';
import { matchesKeyword } from './keywordTree';

describe('matchesKeyword', () => {
  it('matches exact tags and descendants of the selected hierarchy node', () => {
    const keywords = ['Animals|Dogs|Labrador', 'Landscape'];
    expect(matchesKeyword(keywords, 'Animals')).toBe(true);
    expect(matchesKeyword(keywords, 'Animals|Dogs')).toBe(true);
    expect(matchesKeyword(keywords, 'Animals|Dogs|Labrador')).toBe(true);
  });

  it('requires a hierarchy separator instead of accepting a text prefix', () => {
    expect(matchesKeyword(['Animals'], 'Animal')).toBe(false);
    expect(matchesKeyword(['Animal Portraits'], 'Animal')).toBe(false);
  });

  it('fails closed for empty photo keywords', () => {
    expect(matchesKeyword([], 'Animals')).toBe(false);
  });
});
