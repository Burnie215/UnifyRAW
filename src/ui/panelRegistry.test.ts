import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  PANEL_DEFINITIONS,
  PANEL_MAP,
  buildDefaultLayout,
  panelIdsInZone,
} from './panelRegistry';
import { AUTO_EXPAND, TOOL_PANELS, getPanelContextFilter } from './panelContext';
import { PHONE_PANEL_GROUPS } from './phonePanelSelection';
import type { PanelLayout } from './panelTypes';

/**
 * Panels that were in the layout once and are gone for good. `publish` never
 * had content behind it, so it rendered as nothing while riding along in every
 * stored layout; `sanitizeLayout` now drops ids the registry does not know.
 */
const RETIRED_PANEL_IDS = ['publish'];

/**
 * The layout literal as it stood before the registry became its source
 * (panelTypes.ts:37-52, commit 19b1cf6). The derivation has to reproduce it
 * field for field apart from the retired ids, otherwise stored layouts would
 * silently move panels.
 */
const LAYOUT_BEFORE_DERIVATION: PanelLayout = {
  left: ['navigator', 'loupe', 'presets', 'history'],
  right: [
    'histogram', 'layers', 'toolstrip', 'basic', 'whitebalance', 'presence',
    'tonecurve', 'levels', 'hsl', 'colorgrading', 'bw', 'detail',
    'effects', 'sky', 'transform', 'masking', 'publish', 'softproof', 'metadata',
    'keywords', 'quickdev',
  ],
  bottom: ['filmstrip'],
  floating: [],
  collapsed: ['loupe', 'whitebalance', 'presence', 'tonecurve', 'hsl', 'colorgrading', 'bw', 'detail', 'effects', 'sky', 'transform', 'masking', 'publish', 'softproof', 'metadata', 'history'],
  pinned: ['histogram', 'layers'],
  leftWidth: 240,
  rightWidth: 300,
  bottomHeight: 90,
};

describe('DEFAULT_LAYOUT derived from the registry', () => {
  it('is exactly this object', () => {
    expect(DEFAULT_LAYOUT).toEqual({
      left: ['navigator', 'loupe', 'presets', 'history'],
      right: [
        'histogram', 'layers', 'toolstrip', 'basic', 'whitebalance', 'presence',
        'tonecurve', 'levels', 'hsl', 'colorgrading', 'bw', 'detail',
        'effects', 'sky', 'transform', 'masking', 'softproof', 'metadata',
        'keywords', 'quickdev',
      ],
      bottom: ['filmstrip'],
      floating: [],
      collapsed: [
        'loupe', 'history', 'whitebalance', 'presence', 'tonecurve', 'hsl',
        'colorgrading', 'bw', 'detail', 'effects', 'sky', 'transform',
        'masking', 'softproof', 'metadata',
      ],
      pinned: ['histogram', 'layers'],
      leftWidth: 240,
      rightWidth: 300,
      bottomHeight: 90,
    });
  });

  it('reproduces the hand-written literal it replaced, minus the retired panels', () => {
    const drop = (ids: string[]) => ids.filter((id) => !RETIRED_PANEL_IDS.includes(id));
    const { collapsed, ...zones } = DEFAULT_LAYOUT;
    const { collapsed: collapsedBefore, ...zonesBefore } = LAYOUT_BEFORE_DERIVATION;
    // Zones are ordered; `collapsed` is read as a set (PanelSystem builds one).
    expect(zones).toEqual({
      ...zonesBefore,
      left: drop(zonesBefore.left),
      right: drop(zonesBefore.right),
      bottom: drop(zonesBefore.bottom),
    });
    expect([...collapsed].sort()).toEqual(drop(collapsedBefore).sort());
  });

  it('has no definition left for a retired panel', () => {
    for (const id of RETIRED_PANEL_IDS) expect(PANEL_MAP.has(id)).toBe(false);
  });

  it('places every registered panel in exactly one zone, in registry order', () => {
    for (const zone of ['left', 'right', 'bottom'] as const) {
      expect(DEFAULT_LAYOUT[zone]).toEqual(panelIdsInZone(zone));
    }
    const placed = [...DEFAULT_LAYOUT.left, ...DEFAULT_LAYOUT.right, ...DEFAULT_LAYOUT.bottom];
    expect(placed.sort()).toEqual(PANEL_DEFINITIONS.map((p) => p.id).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('collapses exactly the panels the registry does not start open', () => {
    expect(DEFAULT_LAYOUT.collapsed)
      .toEqual(PANEL_DEFINITIONS.filter((p) => !p.defaultOpen).map((p) => p.id));
  });

  it('pins only panels that live in the right zone', () => {
    for (const id of DEFAULT_LAYOUT.pinned) {
      expect(DEFAULT_LAYOUT.right).toContain(id);
    }
  });

  it('follows the registry when a panel moves zone or start state', () => {
    const moved = buildDefaultLayout(
      [
        { id: 'a', title: 'a', icon: null, defaultZone: 'left', defaultOpen: false, context: 'editor' },
        { id: 'b', title: 'b', icon: null, defaultZone: 'right', defaultOpen: true, context: 'both' },
      ],
      { pinned: ['b'], leftWidth: 1, rightWidth: 2, bottomHeight: 3 },
    );
    expect(moved).toEqual({
      left: ['a'], right: ['b'], bottom: [], floating: [],
      collapsed: ['a'], pinned: ['b'], leftWidth: 1, rightWidth: 2, bottomHeight: 3,
    });
  });
});

describe('panel id lists outside the registry', () => {
  const listed = [
    ...Object.values(TOOL_PANELS).flat(),
    ...Object.values(AUTO_EXPAND).flat(),
    ...PHONE_PANEL_GROUPS.flatMap((g) => g.ids),
  ];

  it('name only panels the registry knows', () => {
    expect([...new Set(listed)].filter((id) => !PANEL_MAP.has(id))).toEqual([]);
  });
});

describe('getPanelContextFilter', () => {
  it('shows exactly the non-editor panels in the library', () => {
    const { visiblePanelIds, autoExpandIds } = getPanelContextFilter(null, true);
    expect([...visiblePanelIds].sort()).toEqual(['histogram', 'keywords', 'metadata', 'quickdev']);
    expect([...autoExpandIds]).toEqual([]);
  });

  it('shows exactly these panels in the editor with no tool active', () => {
    const { visiblePanelIds } = getPanelContextFilter('edit');
    expect([...visiblePanelIds].sort()).toEqual([
      'basic', 'bw', 'colorgrading', 'detail', 'effects', 'filmstrip', 'histogram',
      'history', 'hsl', 'layers', 'loupe', 'masking', 'metadata', 'navigator',
      'presence', 'presets', 'sky', 'softproof', 'tonecurve',
      'toolstrip', 'transform', 'whitebalance', 'levels',
    ].sort());
  });

  it('keeps the loupe and the left zone while a tool is active', () => {
    const { visiblePanelIds, autoExpandIds } = getPanelContextFilter('crop');
    expect([...visiblePanelIds].sort()).toEqual([
      'filmstrip', 'histogram', 'history', 'layers', 'loupe', 'navigator', 'presets', 'transform',
    ].sort());
    expect([...autoExpandIds]).toEqual(['transform']);
  });
});
