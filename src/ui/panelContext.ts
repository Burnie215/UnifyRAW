import type { EditorTool } from './ToolStrip';
import { PANEL_DEFINITIONS, panelIdsInZone } from './panelRegistry';

/**
 * Editor panels that stay regardless of the active tool. Both are pinned in
 * DEFAULT_LAYOUT, which is what "always" means here; the left zone gets the
 * same treatment through LEFT_PANELS below.
 */
const EDITOR_ALWAYS_VISIBLE = new Set(['histogram', 'layers']);

/** Panels visible in library mode - everything the registry does not call editor-only */
const LIBRARY_PANELS = PANEL_DEFINITIONS
  .filter((p) => p.context !== 'editor')
  .map((p) => p.id);

/** Panels visible per tool context (editor) */
export const TOOL_PANELS: Record<string, string[]> = {
  // Default (edit mode): all editing panels
  edit: [
    'toolstrip', 'loupe', 'basic', 'whitebalance', 'presence', 'tonecurve', 'levels', 'hsl',
    'colorgrading', 'bw', 'detail', 'effects', 'sky', 'transform',
    'masking', 'softproof', 'metadata',
  ],
  crop: ['transform'],
  heal: ['masking', 'detail'],
  clone: ['masking', 'detail'],
  brush: ['masking'],
  gradient: ['masking'],
  radial: ['masking'],
  straighten: ['transform'],
};

/** Panels to auto-expand when a tool is activated */
export const AUTO_EXPAND: Record<string, string[]> = {
  crop: ['transform'],
  heal: ['masking'],
  clone: ['masking'],
  brush: ['masking'],
  gradient: ['masking'],
  radial: ['masking'],
  straighten: ['transform'],
};

/** Left-zone panels are always shown (navigator, presets, etc.) */
const LEFT_PANELS = new Set(panelIdsInZone('left'));

/** Bottom panels are always shown */
const BOTTOM_PANELS = new Set(panelIdsInZone('bottom'));

export interface PanelContextFilter {
  /** Panel IDs that should be visible in right zone */
  visiblePanelIds: Set<string>;
  /** Panel IDs that should be auto-expanded */
  autoExpandIds: Set<string>;
}

/**
 * Determine which panels should be visible and auto-expanded
 * based on the active tool.
 */
export function getPanelContextFilter(
  activeTool: EditorTool | null | undefined,
  isLibrary?: boolean,
): PanelContextFilter {
  if (isLibrary) {
    return {
      visiblePanelIds: new Set(LIBRARY_PANELS),
      autoExpandIds: new Set(),
    };
  }

  const tool = activeTool ?? 'edit';
  const contextPanels = TOOL_PANELS[tool] ?? TOOL_PANELS.edit;

  const visiblePanelIds = new Set<string>([
    ...EDITOR_ALWAYS_VISIBLE,
    ...contextPanels,
    ...LEFT_PANELS,
    ...BOTTOM_PANELS,
  ]);

  const autoExpandIds = new Set<string>(AUTO_EXPAND[tool] ?? []);

  return { visiblePanelIds, autoExpandIds };
}
