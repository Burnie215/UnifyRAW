/**
 * What the album picker puts next to its checkboxes. An entry without a name
 * is the case that matters: Immich answers albums it carries without one, the
 * source refuses to invent a name for them, and a row that says nothing at
 * all cannot be picked with any confidence.
 */
import { describe, expect, it } from 'vitest';
import { flattenBrowseItems } from './browseItems';
import type { SourceBrowseItem } from '../sources/types';

const album = (id: string, name: string, children?: SourceBrowseItem[]): SourceBrowseItem =>
  ({ id, name, type: 'album', children });

describe('the rows of the album picker', () => {
  it('says so when an entry has no name, at every depth', () => {
    const rows = flattenBrowseItems([album('al-1', '', [album('al-2', '')])], '(without a name)');

    expect(rows.map((row) => row.name)).toEqual(['(without a name)', '  (without a name)']);
  });

  it('leaves a name the server did send alone', () => {
    const rows = flattenBrowseItems([album('al-1', 'Urlaub', [album('al-2', 'Sommer')])], '(without a name)');

    expect(rows.map((row) => row.name)).toEqual(['Urlaub', '  Sommer']);
  });
});
