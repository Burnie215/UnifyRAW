import type { PanelLayout } from './panelTypes';

/** The three docked zones. `floating` has no drop geometry of its own. */
export type DockZone = 'left' | 'right' | 'bottom';

export interface PanelDropTarget {
  zone: DockZone;
  /**
   * Insert the dragged panel before this panel id; `null` means "after the
   * last panel of the zone". An id, never an index: the hit-test only sees
   * the panels the context filter actually rendered, while the stored layout
   * also holds the hidden ones. An index from the first list applied to the
   * second lands somewhere else entirely.
   */
  beforeId: string | null;
}

export interface DropCandidatePanel {
  id: string;
  top: number;
  bottom: number;
}

export interface DropCandidateZone {
  zone: DockZone;
  bounds: { left: number; right: number; top: number; bottom: number };
  /** Rendered panels of that zone, in the order they appear on screen. */
  panels: DropCandidatePanel[];
}

/**
 * Which zone and which neighbour the pointer is over. Zones are tested in the
 * order given, the first hit wins.
 */
export function resolveDrop(
  zones: readonly DropCandidateZone[],
  clientX: number,
  clientY: number,
): PanelDropTarget | null {
  for (const candidate of zones) {
    const { left, right, top, bottom } = candidate.bounds;
    if (clientX < left || clientX > right || clientY < top || clientY > bottom) continue;
    for (const panel of candidate.panels) {
      const midY = panel.top + (panel.bottom - panel.top) / 2;
      if (clientY < midY) return { zone: candidate.zone, beforeId: panel.id };
    }
    return { zone: candidate.zone, beforeId: null };
  }
  return null;
}

/**
 * Move `panelId` to the target slot. Reorder inside a zone and move between
 * zones are the same operation here — remove everywhere, insert before the
 * named neighbour — so there is no index to adjust and no off-by-one to get
 * wrong.
 */
export function applyDrop(
  layout: PanelLayout,
  panelId: string,
  target: PanelDropTarget,
): PanelLayout {
  // Dropping a panel onto its own slot changes nothing. Without this guard the
  // insert would look for a neighbour that was just removed and append instead.
  if (target.beforeId === panelId) return layout;

  const next: PanelLayout = { ...layout };
  for (const zone of ['left', 'right', 'bottom'] as const) {
    next[zone] = layout[zone].filter((id) => id !== panelId);
  }
  next.floating = layout.floating.filter((f) => f.id !== panelId);

  const arr = [...next[target.zone]];
  const before = target.beforeId === null ? -1 : arr.indexOf(target.beforeId);
  arr.splice(before < 0 ? arr.length : before, 0, panelId);
  next[target.zone] = arr;
  return next;
}
