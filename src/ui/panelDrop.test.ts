import { describe, expect, it } from 'vitest';
import { applyDrop, resolveDrop, type DropCandidateZone } from './panelDrop';
import type { PanelLayout } from './panelTypes';

/** Three stacked panels, 100px each, starting at y = 0. */
function zone(name: 'left' | 'right', ids: string[], left: number): DropCandidateZone {
  return {
    zone: name,
    bounds: { left, right: left + 300, top: 0, bottom: 1000 },
    panels: ids.map((id, i) => ({ id, top: i * 100, bottom: i * 100 + 100 })),
  };
}

function layout(partial: Partial<PanelLayout> = {}): PanelLayout {
  return {
    left: [],
    right: [],
    bottom: [],
    floating: [],
    collapsed: [],
    pinned: [],
    leftWidth: 240,
    rightWidth: 300,
    bottomHeight: 90,
    ...partial,
  };
}

describe('resolveDrop', () => {
  const zones = [zone('left', ['navigator', 'presets'], 0), zone('right', ['basic', 'detail'], 500)];

  it('names the panel the pointer sits in front of', () => {
    expect(resolveDrop(zones, 100, 10)).toEqual({ zone: 'left', beforeId: 'navigator' });
    expect(resolveDrop(zones, 100, 90)).toEqual({ zone: 'left', beforeId: 'presets' });
    expect(resolveDrop(zones, 600, 120)).toEqual({ zone: 'right', beforeId: 'detail' });
  });

  it('reports the end of the zone below the last panel', () => {
    expect(resolveDrop(zones, 100, 400)).toEqual({ zone: 'left', beforeId: null });
  });

  it('reports the end of an empty zone the pointer is over', () => {
    expect(resolveDrop([zone('left', [], 0)], 100, 400)).toEqual({ zone: 'left', beforeId: null });
  });

  it('finds nothing outside every zone', () => {
    expect(resolveDrop(zones, 400, 50)).toBeNull();
    expect(resolveDrop(zones, 100, 2000)).toBeNull();
  });
});

describe('applyDrop', () => {
  it('reorders inside a zone', () => {
    const next = applyDrop(layout({ right: ['a', 'b', 'c'] }), 'c', { zone: 'right', beforeId: 'b' });
    expect(next.right).toEqual(['a', 'c', 'b']);
  });

  it('moves between zones and keeps the panel in exactly one of them', () => {
    const next = applyDrop(layout({ left: ['a', 'b'], right: ['c'] }), 'b', { zone: 'right', beforeId: 'c' });
    expect(next.left).toEqual(['a']);
    expect(next.right).toEqual(['b', 'c']);
  });

  it('appends when the target names no neighbour', () => {
    const next = applyDrop(layout({ right: ['a', 'b'] }), 'a', { zone: 'right', beforeId: null });
    expect(next.right).toEqual(['b', 'a']);
  });

  it('docks a floating panel that is dropped on a zone', () => {
    const start = layout({ right: ['a'], floating: [{ id: 'b', x: 1, y: 2, width: 300, height: 400 }] });
    const next = applyDrop(start, 'b', { zone: 'right', beforeId: 'a' });
    expect(next.floating).toEqual([]);
    expect(next.right).toEqual(['b', 'a']);
  });

  it('leaves the layout alone when a panel is dropped on its own slot', () => {
    const start = layout({ right: ['a', 'b', 'c'] });
    expect(applyDrop(start, 'b', { zone: 'right', beforeId: 'b' })).toBe(start);
  });

  /**
   * The regression this whole id-based path exists for: the hit-test only sees
   * the panels the context filter rendered, the stored layout also holds the
   * hidden ones. Counting rendered panels and using that number as an index
   * into the stored list drops the panel next to the wrong neighbour.
   */
  it('drops in front of the rendered neighbour even when the zone hides panels', () => {
    const stored = layout({ right: ['a', 'hidden1', 'b', 'hidden2', 'c'], left: ['x'] });
    const rendered = zone('right', ['a', 'b', 'c'], 0);

    // Pointer in the upper half of the third rendered panel ('c', index 2).
    const target = resolveDrop([rendered], 100, 210);
    expect(target).toEqual({ zone: 'right', beforeId: 'c' });

    expect(applyDrop(stored, 'x', target!).right).toEqual(['a', 'hidden1', 'b', 'hidden2', 'x', 'c']);
  });
});
