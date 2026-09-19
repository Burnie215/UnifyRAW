import { useState, useCallback } from 'react';
import type { PanelLayout, FloatingPanelPos } from './panelTypes';
import { DEFAULT_LAYOUT, PANEL_MAP } from './panelRegistry';
import { applyDrop, type DockZone, type PanelDropTarget } from './panelDrop';
import { STORAGE_KEYS } from '../platform/storageKeys';

const STORAGE_KEY = STORAGE_KEYS.panelLayout;

/**
 * 1 = the format before stored layouts were cleaned on load. Those carry ids
 * of panels that no longer exist (`publish` rode along in every profile) and,
 * after a failed drag, the same id twice. 2 is written by `saveLayout` once
 * `sanitizeLayout` has been over it.
 */
export const PANEL_LAYOUT_VERSION = 2;

const DOCK_ZONES = ['left', 'right', 'bottom'] as const;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Known panel ids, in the given order, each at most once across the layout. */
function sanitizeIds(value: unknown, seen: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string' || !PANEL_MAP.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sanitizeFloating(value: unknown, seen: Set<string>): FloatingPanelPos[] {
  if (!Array.isArray(value)) return [];
  const out: FloatingPanelPos[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const f = entry as Partial<FloatingPanelPos>;
    if (typeof f.id !== 'string' || !PANEL_MAP.has(f.id) || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push({
      id: f.id,
      x: numberOr(f.x, 0),
      y: numberOr(f.y, 0),
      width: numberOr(f.width, 300),
      height: numberOr(f.height, 400),
      ...(f.origin === 'left' || f.origin === 'right' || f.origin === 'bottom'
        ? { origin: f.origin }
        : {}),
    });
  }
  return out;
}

/** Flat id list, no order semantics — collapsed and pinned are read as sets. */
function sanitizeFlags(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && PANEL_MAP.has(id)))];
}

/**
 * A stored layout is user data of unknown age: it may name panels that were
 * retired, hold one panel twice, or miss panels that shipped since. Everything
 * downstream (drag, the phone sheet, the tablet drawer) assumes one id lives in
 * exactly one place, so the cleaning happens once, here.
 */
export function sanitizeLayout(raw: unknown): PanelLayout {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LAYOUT };
  const parsed = raw as Record<string, unknown>;

  const seen = new Set<string>();
  const layout: PanelLayout = {
    left: sanitizeIds(parsed.left, seen),
    right: sanitizeIds(parsed.right, seen),
    bottom: sanitizeIds(parsed.bottom, seen),
    floating: sanitizeFloating(parsed.floating, seen),
    collapsed: sanitizeFlags(parsed.collapsed, DEFAULT_LAYOUT.collapsed),
    pinned: sanitizeFlags(parsed.pinned, DEFAULT_LAYOUT.pinned),
    leftWidth: numberOr(parsed.leftWidth, DEFAULT_LAYOUT.leftWidth),
    rightWidth: numberOr(parsed.rightWidth, DEFAULT_LAYOUT.rightWidth),
    bottomHeight: numberOr(parsed.bottomHeight, DEFAULT_LAYOUT.bottomHeight),
  };

  // Panels added to the registry since the layout was stored: place each one
  // behind its default predecessor so a new panel lands where it was designed
  // to, not at the top of the zone.
  for (const zone of DOCK_ZONES) {
    for (let i = 0; i < DEFAULT_LAYOUT[zone].length; i++) {
      const id = DEFAULT_LAYOUT[zone][i];
      if (seen.has(id)) continue;
      const prevId = i > 0 ? DEFAULT_LAYOUT[zone][i - 1] : null;
      const insertAt = prevId ? layout[zone].indexOf(prevId) + 1 : i;
      layout[zone] = [...layout[zone]];
      layout[zone].splice(Math.min(insertAt, layout[zone].length), 0, id);
      seen.add(id);
    }
  }

  return layout;
}

export function loadLayout(): PanelLayout {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      const layout = sanitizeLayout(parsed);
      // Write the cleaned layout back once. Sanitizing on every load alone
      // would leave the retired ids sitting in storage forever, where the next
      // reader (a Playwright check, a support session) still sees them.
      const version = (parsed as { version?: unknown } | null)?.version;
      if (version !== PANEL_LAYOUT_VERSION) saveLayout(layout);
      return layout;
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_LAYOUT };
}

export function saveLayout(layout: PanelLayout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...layout, version: PANEL_LAYOUT_VERSION }));
  } catch { /* ignore */ }
}

/**
 * Panels floating over a screen class that has no free space. The tablet
 * drawer shows them with the panels of the zone they came from; anything not
 * from the left goes to the right drawer, which is where an unknown origin
 * docks as well.
 */
export function floatingIdsForSide(layout: PanelLayout, side: 'left' | 'right'): string[] {
  return layout.floating
    .filter((f) => (f.origin === 'left' ? 'left' : 'right') === side)
    .map((f) => f.id);
}

function zoneOf(layout: PanelLayout, panelId: string): DockZone | null {
  for (const zone of DOCK_ZONES) {
    if (layout[zone].includes(panelId)) return zone;
  }
  return null;
}

export type PanelLayoutApi = ReturnType<typeof usePanelLayout>;

/**
 * The owner of the stored panel layout. Exactly one instance may exist — see
 * `PanelLayoutProvider`. Two of them write the same localStorage key from their
 * own mount snapshot, so whichever renders last wins and the other's moves are
 * gone.
 */
export function usePanelLayout() {
  const [layout, setLayout] = useState<PanelLayout>(loadLayout);

  const update = useCallback((fn: (prev: PanelLayout) => PanelLayout) => {
    setLayout((prev) => {
      const next = fn(prev);
      if (next === prev) return prev;
      saveLayout(next);
      return next;
    });
  }, []);

  const togglePanel = useCallback((panelId: string) => {
    update((prev) => {
      const collapsed = new Set(prev.collapsed);
      if (collapsed.has(panelId)) collapsed.delete(panelId);
      else collapsed.add(panelId);
      return { ...prev, collapsed: Array.from(collapsed) };
    });
  }, [update]);

  const togglePin = useCallback((panelId: string) => {
    update((prev) => {
      const pinned = new Set(prev.pinned ?? []);
      if (pinned.has(panelId)) pinned.delete(panelId);
      else pinned.add(panelId);
      return { ...prev, pinned: Array.from(pinned) };
    });
  }, [update]);

  /** Drag and drop: move a panel in front of a named neighbour. */
  const dropPanel = useCallback((panelId: string, target: PanelDropTarget) => {
    update((prev) => applyDrop(prev, panelId, target));
  }, [update]);

  const resizeZone = useCallback((zone: DockZone, size: number) => {
    update((prev) => {
      if (zone === 'left') return { ...prev, leftWidth: Math.max(180, Math.min(400, size)) };
      if (zone === 'right') return { ...prev, rightWidth: Math.max(220, Math.min(450, size)) };
      return { ...prev, bottomHeight: Math.max(60, Math.min(300, size)) };
    });
  }, [update]);

  const floatPanel = useCallback((panelId: string) => {
    update((prev) => {
      const origin = zoneOf(prev, panelId);
      const next: PanelLayout = { ...prev };
      for (const zone of DOCK_ZONES) next[zone] = prev[zone].filter((id) => id !== panelId);
      next.floating = [
        ...prev.floating.filter((f) => f.id !== panelId),
        {
          id: panelId,
          x: Math.round(window.innerWidth / 2 - 150),
          y: Math.round(window.innerHeight / 3),
          width: 300,
          height: 400,
          ...(origin ? { origin } : {}),
        },
      ];
      return next;
    });
  }, [update]);

  const updateFloatingPos = useCallback((panelId: string, pos: Partial<FloatingPanelPos>) => {
    update((prev) => ({
      ...prev,
      floating: prev.floating.map((f) => f.id === panelId ? { ...f, ...pos } : f),
    }));
  }, [update]);

  /** Dock a floating panel. Without an explicit zone it returns where it came from. */
  const dockPanel = useCallback((panelId: string, zone?: DockZone) => {
    update((prev) => {
      const floating = prev.floating.find((f) => f.id === panelId);
      const target = zone ?? floating?.origin ?? 'right';
      const next: PanelLayout = { ...prev };
      next.floating = prev.floating.filter((f) => f.id !== panelId);
      next[target] = [...prev[target].filter((id) => id !== panelId), panelId];
      return next;
    });
  }, [update]);

  const resetLayout = useCallback(() => {
    const fresh = { ...DEFAULT_LAYOUT };
    saveLayout(fresh);
    setLayout(fresh);
  }, []);

  return {
    layout,
    togglePanel,
    togglePin,
    dropPanel,
    resizeZone,
    floatPanel,
    updateFloatingPos,
    dockPanel,
    resetLayout,
  };
}
