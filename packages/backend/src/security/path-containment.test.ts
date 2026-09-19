import { describe, expect, it } from 'vitest';
import { isPathInside } from './path-containment.js';
import { isPathInside as libraryIsPathInside } from '../libraries/library.paths.js';

describe('isPathInside(root, candidate)', () => {
  it('accepts the root itself and paths below it', () => {
    expect(isPathInside('/a', '/a')).toBe(true);
    expect(isPathInside('/a', '/a/b')).toBe(true);
    expect(isPathInside('/a', '/a/b/../c')).toBe(true);
  });

  it('rejects a parent, a sibling prefix and a traversal', () => {
    expect(isPathInside('/a/b', '/a')).toBe(false);
    expect(isPathInside('/a', '/ab')).toBe(false);
    expect(isPathInside('/a', '/a/../b')).toBe(false);
  });

  it('is the one implementation library code imports', () => {
    expect(libraryIsPathInside).toBe(isPathInside);
  });
});
