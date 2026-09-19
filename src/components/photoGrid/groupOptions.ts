import type { GridMode, GroupMode } from '../../types';

/**
 * Which groupings each view actually honours.
 *
 * The selector used to offer all four to every view that is not the gallery,
 * so picking a folder mosaic in the list or the timeline changed nothing at
 * all. Whether a grouping means something is the view's own answer, so it is
 * given once here and asked twice: the selector asks what to offer, the router
 * asks what to hand down. Adding a view means adding a line, not hunting for
 * every `<option>`.
 *
 * Every view honours `none`, so a list of one means "nothing worth choosing".
 */
const GROUP_OPTIONS: Record<GridMode, readonly GroupMode[]> = {
  // Folder sections, a folder mosaic and a folder stack all live in TilesView.
  tiles: ['none', 'folder', 'folder-grid', 'folder-stack'],
  // ListView has the collapsible folder sections; folder tiles have no row.
  list: ['none', 'folder'],
  // TimelineView groups by month itself, and the gallery is one photo plus a strip.
  timeline: ['none'],
  gallery: ['none'],
};

/**
 * The suffix under `gridToolbar.groups.` that names each grouping. Shared so
 * the two selectors cannot drift, but resolved at the call site as a template
 * (`` t(`gridToolbar.groups.${...}`) ``) - the locale gate reads prefixes out
 * of the source, and a register of finished keys is invisible to it.
 */
export const GROUP_LABEL_KEYS: Record<GroupMode, string> = {
  none: 'none',
  folder: 'folder',
  'folder-grid': 'folderGrid',
  'folder-stack': 'folderStack',
};

export function groupOptionsFor(gridMode: GridMode): readonly GroupMode[] {
  return GROUP_OPTIONS[gridMode];
}

/**
 * The grouping this view will really apply. The choice is kept across a view
 * switch rather than reset, so a folder mosaic is still there on the way back
 * to the tiles - but while a view that ignores it is on screen, both the
 * selector and the view itself say `none`.
 */
export function effectiveGroupMode(gridMode: GridMode, groupMode: GroupMode): GroupMode {
  return GROUP_OPTIONS[gridMode].includes(groupMode) ? groupMode : 'none';
}
