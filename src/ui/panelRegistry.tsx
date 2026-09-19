/* eslint-disable react-refresh/only-export-components -- Static metadata registry; private icons are not refresh boundaries. */
import type { PanelDefinition, PanelLayout, PanelZone } from './panelTypes';

// ─── SVG Icons ───
function NavIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="1" width="10" height="10" rx="1" /><rect x="6" y="6" width="5" height="5" fill="currentColor" opacity="0.3" /></svg>;
}
function PresetIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 3h8M2 6h5M2 9h3" /></svg>;
}
function HistoryIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="6" cy="6" r="5" /><path d="M6 3v3l2 1" /></svg>;
}
function LayerIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M1 6l5 3 5-3M1 8l5 3 5-3M1 4l5 3 5-3" /></svg>;
}
function HistogramIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M1 11V7l2-3 2 2 2-5 2 4 2-1v7" /></svg>;
}
function ToolStripIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 10l3-3 5-5" /><path d="M8 2l2 2" /></svg>;
}
function SlidersIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M1 3h10M1 6h10M1 9h10" /><circle cx="3" cy="3" r="1.5" fill="var(--bg-secondary)" /><circle cx="8" cy="6" r="1.5" fill="var(--bg-secondary)" /><circle cx="5" cy="9" r="1.5" fill="var(--bg-secondary)" /></svg>;
}
function WBIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="6" cy="6" r="4" /><path d="M6 2v2M6 8v2M2 6h2M8 6h2" /></svg>;
}
function ClarityIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="6" cy="6" r="5" /><circle cx="6" cy="6" r="2" /></svg>;
}
function CurveIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="1" width="10" height="10" rx="1" /><path d="M2 10C4 8 8 4 10 2" /></svg>;
}
function LevelsIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M1 11V8l3-4 4 2 3-5v10z" opacity="0.2" fill="currentColor" /><path d="M1 11h10M1 1v10" /><path d="M2 9l1-1M9 9l-1-1M5.5 9v-2" /></svg>;
}
function ColorIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="5" cy="5" r="3" /><circle cx="8" cy="5" r="3" opacity="0.5" /><circle cx="6.5" cy="8" r="3" opacity="0.5" /></svg>;
}
function GradingIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="3" cy="6" r="2" /><circle cx="6" cy="3" r="2" /><circle cx="9" cy="6" r="2" /></svg>;
}
function BWIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="6" cy="6" r="5" /><path d="M6 1v10" /><path d="M6 1a5 5 0 010 10" fill="currentColor" opacity="0.3" /></svg>;
}
function DetailIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="5" cy="5" r="4" /><path d="M8 8l3 3" /><path d="M5 3v4M3 5h4" /></svg>;
}
function FxIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 4c2-3 6-3 8 0M2 8c2 3 6 3 8 0" /></svg>;
}
function SkyIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M1 8c2-3 3-5 5-5s4 2 5 5" /><circle cx="9" cy="3" r="1.5" /><path d="M1 10h10" strokeDasharray="2 2" /></svg>;
}
function TransformIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="2" y="2" width="8" height="8" rx="1" /><path d="M5 1l1 2 1-2M5 11l1-2 1 2M1 5l2 1-2 1M11 5l-2 1 2 1" /></svg>;
}
function MaskIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="6" cy="6" r="5" /><path d="M3 6c0-2 1.5-3 3-3" strokeDasharray="1.5 1.5" /></svg>;
}
function ProofIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="1" width="10" height="10" rx="1" /><path d="M4 6l2 2 3-4" /></svg>;
}
function InfoIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="6" cy="6" r="5" /><path d="M6 5v4M6 3v.5" /></svg>;
}
function FilmIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><rect x="1" y="3" width="10" height="6" rx="1" /><rect x="3" y="4" width="2" height="4" rx="0.5" /><rect x="7" y="4" width="2" height="4" rx="0.5" /></svg>;
}
function KeywordIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M1 3h4l1 1.5L5 6H1z" /><circle cx="3" cy="4.5" r="0.7" fill="currentColor" /><path d="M7 6h4M7 8h3M7 4h2" /></svg>;
}
function LoupeIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><circle cx="5" cy="5" r="3.5" /><path d="M7.6 7.6L11 11" /><path d="M3.6 5h2.8M5 3.6v2.8" /></svg>;
}
function QuickDevIcon() {
  return <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M2 6h8M4 3h4l1 1-1 1H4L3 4z" /><path d="M5 8h4" /></svg>;
}

// NOTE: `title` here is an i18n key (uiShell.panelRegistry.<id>) — it is resolved
// via t() at render time in ModularPanel, FloatingPanel, and the drag overlay.
export const PANEL_DEFINITIONS: PanelDefinition[] = [
  // === LEFT ===
  { id: 'navigator', title: 'uiShell.panelRegistry.navigator', icon: <NavIcon />, defaultZone: 'left', defaultOpen: true, context: 'editor' },
  { id: 'loupe', title: 'uiShell.panelRegistry.loupe', icon: <LoupeIcon />, defaultZone: 'left', defaultOpen: false, context: 'editor' },
  { id: 'presets', title: 'uiShell.panelRegistry.presets', icon: <PresetIcon />, defaultZone: 'left', defaultOpen: true, context: 'editor' },
  { id: 'history', title: 'uiShell.panelRegistry.history', icon: <HistoryIcon />, defaultZone: 'left', defaultOpen: false, context: 'editor' },

  // === RIGHT ===
  { id: 'histogram', title: 'uiShell.panelRegistry.histogram', icon: <HistogramIcon />, defaultZone: 'right', defaultOpen: true, context: 'both' },
  { id: 'layers', title: 'uiShell.panelRegistry.layers', icon: <LayerIcon />, defaultZone: 'right', defaultOpen: true, context: 'editor' },
  { id: 'toolstrip', title: 'uiShell.panelRegistry.toolstrip', icon: <ToolStripIcon />, defaultZone: 'right', defaultOpen: true, context: 'editor' },
  { id: 'basic', title: 'uiShell.panelRegistry.basic', icon: <SlidersIcon />, defaultZone: 'right', defaultOpen: true, context: 'editor' },
  { id: 'whitebalance', title: 'uiShell.panelRegistry.whitebalance', icon: <WBIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'presence', title: 'uiShell.panelRegistry.presence', icon: <ClarityIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'tonecurve', title: 'uiShell.panelRegistry.tonecurve', icon: <CurveIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'levels', title: 'uiShell.panelRegistry.levels', icon: <LevelsIcon />, defaultZone: 'right', defaultOpen: true, context: 'editor' },
  { id: 'hsl', title: 'uiShell.panelRegistry.hsl', icon: <ColorIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'colorgrading', title: 'uiShell.panelRegistry.colorgrading', icon: <GradingIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'bw', title: 'uiShell.panelRegistry.bw', icon: <BWIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'detail', title: 'uiShell.panelRegistry.detail', icon: <DetailIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'effects', title: 'uiShell.panelRegistry.effects', icon: <FxIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'sky', title: 'uiShell.panelRegistry.sky', icon: <SkyIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'transform', title: 'uiShell.panelRegistry.transform', icon: <TransformIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'masking', title: 'uiShell.panelRegistry.masking', icon: <MaskIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'softproof', title: 'uiShell.panelRegistry.softproof', icon: <ProofIcon />, defaultZone: 'right', defaultOpen: false, context: 'editor' },
  { id: 'metadata', title: 'uiShell.panelRegistry.metadata', icon: <InfoIcon />, defaultZone: 'right', defaultOpen: false, context: 'both' },
  { id: 'keywords', title: 'uiShell.panelRegistry.keywords', icon: <KeywordIcon />, defaultZone: 'right', defaultOpen: true, context: 'library' },
  { id: 'quickdev', title: 'uiShell.panelRegistry.quickdev', icon: <QuickDevIcon />, defaultZone: 'right', defaultOpen: true, context: 'library' },

  // === BOTTOM ===
  { id: 'filmstrip', title: 'uiShell.panelRegistry.filmstrip', icon: <FilmIcon />, defaultZone: 'bottom', defaultOpen: true, context: 'editor' },
];

/** Pre-built Map for O(1) lookup */
export const PANEL_MAP = new Map<string, PanelDefinition>(
  PANEL_DEFINITIONS.map((p) => [p.id, p])
);

interface DefaultLayoutChrome {
  pinned: string[];
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
}

/** Ids of every registered panel that docks into `zone`, in registry order. */
export function panelIdsInZone(
  zone: PanelZone,
  definitions: readonly PanelDefinition[] = PANEL_DEFINITIONS,
): string[] {
  return definitions.filter((p) => p.defaultZone === zone).map((p) => p.id);
}

/**
 * Zone and start state come from the registry, so a new panel is one entry
 * there instead of an entry plus three list edits. Only the chrome (widths and
 * the pinned pair) has no home on a single panel and is passed in.
 */
export function buildDefaultLayout(
  definitions: readonly PanelDefinition[],
  chrome: DefaultLayoutChrome,
): PanelLayout {
  return {
    left: panelIdsInZone('left', definitions),
    right: panelIdsInZone('right', definitions),
    bottom: panelIdsInZone('bottom', definitions),
    floating: [],
    collapsed: definitions.filter((p) => !p.defaultOpen).map((p) => p.id),
    pinned: [...chrome.pinned],
    leftWidth: chrome.leftWidth,
    rightWidth: chrome.rightWidth,
    bottomHeight: chrome.bottomHeight,
  };
}

export const DEFAULT_LAYOUT: PanelLayout = buildDefaultLayout(PANEL_DEFINITIONS, {
  pinned: ['histogram', 'layers'],
  leftWidth: 240,
  rightWidth: 300,
  bottomHeight: 90,
});
