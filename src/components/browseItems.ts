import type { SourceBrowseItem } from '../sources/types';

/**
 * The rows the album picker shows, in the order the tree reads: nesting
 * becomes an indent on the name.
 *
 * An entry the server carries without a name arrives with an empty one - the
 * source must not invent one, because the name is part of every id it would
 * build (see `ImmichSource.albumNameOf`). Saying so is the picker's job: an
 * unnamed row would otherwise be a checkbox next to nothing at all, and a
 * missing name even printed itself as the word "undefined".
 */
export function flattenBrowseItems(
  items: SourceBrowseItem[],
  withoutName: string,
  depth = 0,
): SourceBrowseItem[] {
  const result: SourceBrowseItem[] = [];
  for (const item of items) {
    const indent = depth > 0 ? '  '.repeat(depth) : '';
    result.push({ ...item, name: `${indent}${item.name || withoutName}` });
    if (item.children) result.push(...flattenBrowseItems(item.children, withoutName, depth + 1));
  }
  return result;
}
