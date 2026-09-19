import type { PanelLayout } from './panelTypes';

type AdaptivePanelLayout = Pick<PanelLayout, 'left' | 'right' | 'floating'>;

export interface PhonePanelGroup {
  id: string;
  titleKey: string;
  ids: string[];
}

/**
 * The phone tool picker groups panels by job, not by desktop zone. Ids here are
 * panel registry ids; panelRegistry.test.ts holds them to that.
 */
export const PHONE_PANEL_GROUPS: PhonePanelGroup[] = [
  {
    id: 'essentials',
    titleKey: 'editor.phoneTools.essentials',
    ids: ['toolstrip', 'basic', 'presets', 'transform', 'masking', 'detail'],
  },
  {
    id: 'color',
    titleKey: 'editor.phoneTools.color',
    ids: ['whitebalance', 'tonecurve', 'levels', 'hsl', 'colorgrading', 'bw'],
  },
  {
    id: 'detail',
    titleKey: 'editor.phoneTools.detailAndEffects',
    ids: ['presence', 'effects', 'sky'],
  },
  {
    id: 'workflow',
    titleKey: 'editor.phoneTools.workflow',
    ids: ['layers', 'history', 'navigator', 'loupe', 'histogram', 'metadata', 'softproof'],
  },
];

/**
 * Collect editor panels for the phone tool picker without coupling the picker
 * to the panel's desktop docking position. Bottom-only content (the filmstrip)
 * is intentionally excluded from the phone editor tools.
 */
export function collectPhonePanelIds(
  layout: AdaptivePanelLayout,
  visiblePanelIds: ReadonlySet<string>,
  panelContent: ReadonlyMap<string, unknown>,
): string[] {
  const seen = new Set<string>();
  const candidates = [
    ...layout.right,
    ...layout.left,
    ...layout.floating.map(({ id }) => id),
  ];

  return candidates.filter((id) => {
    if (seen.has(id) || !visiblePanelIds.has(id) || !panelContent.has(id)) return false;
    seen.add(id);
    return true;
  });
}
