import { describe, expect, it } from 'vitest';
import type { PanelLayout } from './panelTypes';
import { collectPhonePanelIds } from './phonePanelSelection';

function layoutWith(panelId: string, zone: 'left' | 'right' | 'floating'): PanelLayout {
  return {
    left: zone === 'left' ? [panelId] : [],
    right: zone === 'right' ? [panelId] : [],
    bottom: ['filmstrip'],
    floating: zone === 'floating'
      ? [{ id: panelId, x: 20, y: 20, width: 300, height: 400 }]
      : [],
    collapsed: [],
    pinned: [],
    leftWidth: 240,
    rightWidth: 300,
    bottomHeight: 90,
  };
}

describe('collectPhonePanelIds', () => {
  it.each(['left', 'right', 'floating'] as const)(
    'keeps a visible editor panel available when it is in the desktop %s zone',
    (zone) => {
      const layout = layoutWith('basic', zone);

      expect(collectPhonePanelIds(
        layout,
        new Set(['basic']),
        new Map([['basic', 'content']]),
      )).toEqual(['basic']);
    },
  );

  it('filters context-hidden and contentless panels and does not expose bottom-only content', () => {
    const layout: PanelLayout = {
      ...layoutWith('navigator', 'left'),
      right: ['basic', 'hidden', 'contentless'],
      bottom: ['filmstrip'],
      floating: [{ id: 'detail', x: 20, y: 20, width: 300, height: 400 }],
    };

    expect(collectPhonePanelIds(
      layout,
      new Set(['navigator', 'basic', 'contentless', 'detail', 'filmstrip']),
      new Map([
        ['navigator', 'content'],
        ['basic', 'content'],
        ['detail', 'content'],
        ['filmstrip', 'content'],
      ]),
    )).toEqual(['basic', 'navigator', 'detail']);
  });

  it('deduplicates malformed layouts defensively', () => {
    const layout: PanelLayout = {
      ...layoutWith('basic', 'left'),
      right: ['basic'],
      floating: [{ id: 'basic', x: 20, y: 20, width: 300, height: 400 }],
    };

    expect(collectPhonePanelIds(
      layout,
      new Set(['basic']),
      new Map([['basic', 'content']]),
    )).toEqual(['basic']);
  });
});
