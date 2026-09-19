import { describe, expect, it } from 'vitest';
import { slideshowSelection } from './slideshowSelection';

const LIBRARY = [1, 2, 3, 4, 5].map((id) => ({ id }));

describe('slideshowSelection', () => {
  it('shows only the selection from two selected photos onward', () => {
    const { photos, startIndex } = slideshowSelection(LIBRARY, new Set([2, 4]), LIBRARY[3]);
    expect(photos.map((p) => p.id)).toEqual([2, 4]);
    expect(startIndex).toBe(1);
  });

  it('keeps the library order, not the order the user clicked in', () => {
    const { photos } = slideshowSelection(LIBRARY, new Set([5, 1, 3]), null);
    expect(photos.map((p) => p.id)).toEqual([1, 3, 5]);
  });

  it('shows all filtered photos from the selected one when only one is selected', () => {
    const { photos, startIndex } = slideshowSelection(LIBRARY, new Set([3]), LIBRARY[2]);
    expect(photos.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
    expect(startIndex).toBe(2);
  });

  it('shows all filtered photos from the start when nothing is selected', () => {
    const { photos, startIndex } = slideshowSelection(LIBRARY, new Set(), null);
    expect(photos.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
    expect(startIndex).toBe(0);
  });

  it('starts at the first photo when the selected one is not in the list', () => {
    const { photos, startIndex } = slideshowSelection(LIBRARY, new Set([2, 4]), { id: 99 });
    expect(photos.map((p) => p.id)).toEqual([2, 4]);
    // Not -1: the slideshow indexes its array with this directly.
    expect(startIndex).toBe(0);
  });

  it('leaves the filtered list untouched', () => {
    const { photos } = slideshowSelection(LIBRARY, new Set(), null);
    photos.push({ id: 6 });
    expect(LIBRARY).toHaveLength(5);
  });
});
