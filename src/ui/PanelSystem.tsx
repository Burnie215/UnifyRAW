import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PanelDefinition, PanelLayout } from './panelTypes';
import type { EditorTool } from './ToolStrip';
import { PanelZone } from './PanelZone';
import { ModularPanel, PanelResetIcon } from './ModularPanel';
import { getPanelContextFilter } from './panelContext';
import { resolveDrop, type DockZone, type DropCandidateZone, type PanelDropTarget } from './panelDrop';
import { floatingIdsForSide } from './usePanelLayout';
import { useAdaptiveLayout } from '../contexts/AdaptiveLayoutContext';
import { PhonePanelActionsContext } from './phonePanelContext';
import { PHONE_PANEL_GROUPS, collectPhonePanelIds } from './phonePanelSelection';
import type { PhonePanelGroup } from './phonePanelSelection';
import './PanelSystem.css';

interface DragState {
  panelId: string;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface PanelSystemProps {
  children: React.ReactNode;
  layout: PanelLayout;
  panels: Map<string, PanelDefinition>;
  panelContent: Map<string, React.ReactNode>;
  onTogglePanel: (id: string) => void;
  onTogglePin?: (id: string) => void;
  onFloatPanel?: (id: string) => void;
  onDockPanel?: (id: string, zone?: DockZone) => void;
  onUpdateFloatingPos?: (id: string, pos: { x?: number; y?: number }) => void;
  onResizeZone: (zone: DockZone, size: number) => void;
  onDropPanel: (panelId: string, target: PanelDropTarget) => void;
  toolbar?: React.ReactNode;
  statusBar?: React.ReactNode;
  bottomContent?: React.ReactNode;
  /** Content rendered above the left zone panels (e.g. app navigation) */
  leftHeader?: React.ReactNode;
  activeTool?: EditorTool;
  isLibrary?: boolean;
  /** Suppress the right-side panel zone entirely (e.g. graph-mode where
   *  pipeline edits happen via the in-canvas inspector instead). */
  hideRight?: boolean;
  /** Adjustment panels whose current values differ from their defaults. */
  modifiedPanelIds?: ReadonlySet<string>;
  onResetPanel?: (id: string) => void;
}

export function PanelSystem({
  children, layout, panels, panelContent,
  onTogglePanel, onFloatPanel, onDockPanel, onUpdateFloatingPos,
  onResizeZone, onDropPanel,
  toolbar, statusBar, bottomContent, leftHeader,
  activeTool, isLibrary, onTogglePin, hideRight = false,
  modifiedPanelIds, onResetPanel,
}: PanelSystemProps) {
  const { t } = useTranslation();
  const adaptiveLayout = useAdaptiveLayout();
  const collapsedSet = useMemo(() => new Set(layout.collapsed), [layout.collapsed]);
  const pinnedSet = useMemo(() => new Set(layout.pinned ?? []), [layout.pinned]);

  // Context-sensitive filtering
  const contextFilter = useMemo(
    () => getPanelContextFilter(isLibrary ? null : (activeTool ?? 'edit'), isLibrary),
    [activeTool, isLibrary],
  );

  // Filter panel IDs per zone based on context
  const filteredLeft = useMemo(
    () => layout.left.filter((id) => contextFilter.visiblePanelIds.has(id)),
    [layout.left, contextFilter],
  );
  const filteredRight = useMemo(
    () => layout.right.filter((id) => contextFilter.visiblePanelIds.has(id)),
    [layout.right, contextFilter],
  );

  // Auto-expand: when tool changes, expand relevant panels
  const prevToolRef = useRef(activeTool);
  useEffect(() => {
    if (activeTool !== prevToolRef.current) {
      prevToolRef.current = activeTool;
      for (const id of contextFilter.autoExpandIds) {
        if (collapsedSet.has(id)) {
          onTogglePanel(id);
        }
      }
    }
  }, [activeTool, contextFilter.autoExpandIds, collapsedSet, onTogglePanel]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<PanelDropTarget | null>(null);
  const [compactDrawer, setCompactDrawer] = useState<'left' | 'right' | null>(null);
  const [phonePanelId, setPhonePanelId] = useState<string | null>(null);
  const [phoneSheet, setPhoneSheet] = useState<'picker' | 'panel' | null>(null);
  const systemRef = useRef<HTMLDivElement>(null);
  const phoneSheetRef = useRef<HTMLElement>(null);
  const phoneReturnFocusRef = useRef<HTMLElement | null>(null);

  const hasLeft = filteredLeft.length > 0 || (drag !== null);
  const hasRight = !hideRight && filteredRight.length > 0;

  // ─── Drag start (called from ModularPanel after threshold) ───
  const handleDragStart = useCallback((e: React.PointerEvent, panelId: string) => {
    setDrag({
      panelId,
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
    });
    // Capture on the system container for global tracking
    systemRef.current?.setPointerCapture(e.pointerId);
  }, []);

  // ─── Drag move (tracked on the system container) ───
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag) return;
    setDrag((prev) => prev ? { ...prev, currentX: e.clientX, currentY: e.clientY } : null);

    // Hit-test: which zone, and in front of which panel?
    setDropTarget(resolveDrop(readDropZones(systemRef.current), e.clientX, e.clientY));
  }, [drag]);

  // ─── Drag end ───
  const handlePointerUp = useCallback(() => {
    if (!drag) return;

    if (dropTarget) onDropPanel(drag.panelId, dropTarget);

    setDrag(null);
    setDropTarget(null);
  }, [drag, dropTarget, onDropPanel]);

  // The indicator sits in front of a named panel, so it marks the slot the drop
  // will actually use even while the context filter hides panels in between.
  const dropBeforeId = drag && dropTarget ? dropTarget.beforeId : null;
  const dropAtEndZone = drag && dropTarget && dropTarget.beforeId === null ? dropTarget.zone : null;

  const draggedDef = drag ? panels.get(drag.panelId) : null;

  const phonePanelIds = useMemo(
    () => collectPhonePanelIds(layout, contextFilter.visiblePanelIds, panelContent),
    [contextFilter.visiblePanelIds, layout, panelContent],
  );

  const phonePanelGroups = useMemo(() => {
    const available = new Set(phonePanelIds);
    const grouped = new Set<string>();
    const groups = PHONE_PANEL_GROUPS.map((group) => {
      const ids = group.ids.filter((id) => available.has(id) && !grouped.has(id));
      ids.forEach((id) => grouped.add(id));
      return { ...group, ids };
    }).filter((group) => group.ids.length > 0);
    const remaining = phonePanelIds.filter((id) => !grouped.has(id));
    if (remaining.length > 0) {
      groups.push({ id: 'more', titleKey: 'editor.phoneTools.more', ids: remaining });
    }
    return groups;
  }, [phonePanelIds]);

  const closePhoneSheet = useCallback(() => {
    setPhoneSheet(null);
    setPhonePanelId(null);
    const returnFocusTo = phoneReturnFocusRef.current;
    phoneReturnFocusRef.current = null;
    window.requestAnimationFrame(() => returnFocusTo?.focus());
  }, []);

  const openPhoneToolPicker = useCallback((returnFocusTo?: HTMLElement | null) => {
    if (phonePanelIds.length === 0) return;
    phoneReturnFocusRef.current = returnFocusTo ?? document.activeElement as HTMLElement | null;
    setPhonePanelId(null);
    setPhoneSheet('picker');
  }, [phonePanelIds.length]);

  const openPhonePanel = useCallback((id: string) => {
    if (!phonePanelIds.includes(id)) return;
    setPhonePanelId(id);
    setPhoneSheet('panel');
  }, [phonePanelIds]);

  const phonePanelActions = useMemo(() => ({
    available: adaptiveLayout.screen === 'phone' && !isLibrary && phonePanelIds.length > 0,
    openToolPicker: openPhoneToolPicker,
  }), [adaptiveLayout.screen, isLibrary, openPhoneToolPicker, phonePanelIds.length]);

  useEffect(() => {
    // Drawers and sheets belong to one screen-class shell. Clear all of them
    // on every class transition so tablet -> phone -> tablet (and the inverse)
    // can never revive stale overlay state from the previous shell.
    setCompactDrawer(null);
    setPhonePanelId(null);
    setPhoneSheet(null);
    phoneReturnFocusRef.current = null;
  }, [adaptiveLayout.screen]);

  useEffect(() => {
    if (!phonePanelId || phonePanelIds.includes(phonePanelId)) return;
    setPhonePanelId(null);
    setPhoneSheet(phonePanelIds.length > 0 ? 'picker' : null);
  }, [phonePanelId, phonePanelIds]);

  useEffect(() => {
    if (!compactDrawer && !phoneSheet) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setCompactDrawer(null);
      closePhoneSheet();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [closePhoneSheet, compactDrawer, phoneSheet]);

  useEffect(() => {
    if (!phoneSheet) return;
    const frame = window.requestAnimationFrame(() => {
      phoneSheetRef.current
        ?.querySelector<HTMLElement>('[data-phone-sheet-autofocus], button:not([disabled]), input:not([disabled])')
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [phonePanelId, phoneSheet]);

  const handlePhoneSheetKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !phoneSheetRef.current) return;
    const focusable = Array.from(phoneSheetRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute('hidden') && element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const renderCompactPanelList = (ids: string[]) => (
    <div className="ps-compact-panel-list">
      {ids.map((id) => {
        const definition = panels.get(id);
        const content = panelContent.get(id);
        if (!definition || !content) return null;
        return (
          <ModularPanel
            key={id}
            definition={definition}
            collapsed={collapsedSet.has(id)}
            pinned={pinnedSet.has(id)}
            onToggle={() => onTogglePanel(id)}
            onPin={onTogglePin ? () => onTogglePin(id) : undefined}
            onReset={modifiedPanelIds?.has(id) && onResetPanel ? () => onResetPanel(id) : undefined}
          >
            {content}
          </ModularPanel>
        );
      })}
    </div>
  );

  if (adaptiveLayout.screen !== 'desktop') {
    const isPhone = adaptiveLayout.screen === 'phone';
    const selectedPhoneDefinition = phonePanelId ? panels.get(phonePanelId) : null;
    const selectedPhoneContent = phonePanelId ? panelContent.get(phonePanelId) : null;
    // A floating panel has nowhere to float on tablet and phone, so it is
    // listed with the zone it was floated out of instead of disappearing.
    const drawerIds = (side: 'left' | 'right', docked: string[]) => [
      ...docked,
      ...floatingIdsForSide(layout, side),
    ].filter((id) => contextFilter.visiblePanelIds.has(id) && panelContent.has(id));
    const leftIds = drawerIds('left', filteredLeft);
    const rightIds = hideRight ? [] : drawerIds('right', filteredRight);

    return (
      <PhonePanelActionsContext.Provider value={phonePanelActions}>
        <div
          className={`panel-system ps-adaptive ps-${adaptiveLayout.screen}`}
          data-testid={`panel-system-${adaptiveLayout.screen}`}
        >
          <div className="ps-main-row">
            <div className="ps-center">
              {toolbar && <div className="ps-toolbar">{toolbar}</div>}
              <div className="ps-canvas">{children}</div>
              {statusBar && <div className="ps-statusbar">{statusBar}</div>}
              {!isPhone && bottomContent && (
                <div className="ps-bottom" style={{ height: layout.bottomHeight }}>{bottomContent}</div>
              )}
            </div>
          </div>

          {!isPhone && leftIds.length > 0 && (
            <button
              className="ps-tablet-drawer-trigger ps-tablet-drawer-trigger-left"
              onClick={() => setCompactDrawer('left')}
              aria-label={t('editor.library')}
            >
              <PanelEdgeIcon direction="right" />
            </button>
          )}
          {!isPhone && rightIds.length > 0 && (
            <button
              className="ps-tablet-drawer-trigger ps-tablet-drawer-trigger-right"
              onClick={() => setCompactDrawer('right')}
              aria-label={t('uiShell.panelRegistry.basic')}
            >
              <PanelEdgeIcon direction="left" />
            </button>
          )}

          {!isPhone && compactDrawer && (
            <div className="ps-compact-layer">
              <button className="ps-compact-backdrop" onClick={() => setCompactDrawer(null)} aria-label={t('common.close')} />
              <aside className={`ps-tablet-drawer ps-tablet-drawer-${compactDrawer}`}>
                <div className="ps-compact-header">
                  <strong>{compactDrawer === 'left' ? t('editor.library') : t('uiShell.panelRegistry.basic')}</strong>
                  <button onClick={() => setCompactDrawer(null)} aria-label={t('common.close')}>×</button>
                </div>
                {compactDrawer === 'left' && leftHeader}
                {renderCompactPanelList(compactDrawer === 'left' ? leftIds : rightIds)}
              </aside>
            </div>
          )}

          {isPhone && phoneSheet && !isLibrary && (
            <div className="ps-compact-layer ps-phone-sheet-layer">
              <button
                className="ps-compact-backdrop"
                onClick={closePhoneSheet}
                aria-label={t('common.close')}
                tabIndex={-1}
              />
              <section
                ref={phoneSheetRef}
                className={`ps-phone-sheet ${phoneSheet === 'picker' ? 'ps-phone-tool-picker-sheet' : ''}`}
                role="dialog"
                aria-modal="true"
                aria-labelledby="phone-editor-sheet-title"
                onKeyDown={handlePhoneSheetKeyDown}
              >
                <div className="ps-phone-sheet-handle" aria-hidden="true" />
                {phoneSheet === 'picker' ? (
                  <>
                    <div className="ps-phone-sheet-title">
                      <strong id="phone-editor-sheet-title">{t('editor.phoneTools.title')}</strong>
                      <button
                        data-phone-sheet-autofocus
                        onClick={closePhoneSheet}
                        aria-label={t('common.close')}
                      >×</button>
                    </div>
                    <div className="ps-phone-tool-picker">
                      {phonePanelGroups[0] && (
                        <PhoneToolGroup
                          group={phonePanelGroups[0]}
                          panels={panels}
                          onSelect={openPhonePanel}
                        />
                      )}
                      {phonePanelGroups.length > 1 && (
                        <details className="ps-phone-more-tools">
                          <summary>
                            <span>{t('editor.phoneTools.showMore')}</span>
                            <span className="ps-phone-more-count">
                              {phonePanelGroups.slice(1).reduce((count, group) => count + group.ids.length, 0)}
                            </span>
                            <ChevronIcon />
                          </summary>
                          {phonePanelGroups.slice(1).map((group) => (
                            <PhoneToolGroup
                              key={group.id}
                              group={group}
                              panels={panels}
                              onSelect={openPhonePanel}
                            />
                          ))}
                        </details>
                      )}
                    </div>
                  </>
                ) : selectedPhoneDefinition && selectedPhoneContent ? (
                  <>
                    <div className="ps-phone-sheet-title">
                      <button
                        className="ps-phone-sheet-back"
                        data-phone-sheet-autofocus
                        onClick={() => {
                          setPhonePanelId(null);
                          setPhoneSheet('picker');
                        }}
                        aria-label={t('editor.phoneTools.backToTools')}
                      >
                        <BackIcon />
                      </button>
                      <span className="ps-phone-sheet-title-icon" aria-hidden="true">{selectedPhoneDefinition.icon}</span>
                      <strong id="phone-editor-sheet-title">{t(selectedPhoneDefinition.title)}</strong>
                      {phonePanelId && modifiedPanelIds?.has(phonePanelId) && onResetPanel && (
                        <button
                          className="ps-phone-reset"
                          onClick={() => onResetPanel(phonePanelId)}
                          aria-label={t('uiShell.modPanel.reset')}
                          title={t('uiShell.modPanel.reset')}
                        >
                          <PanelResetIcon size={18} />
                        </button>
                      )}
                      <button onClick={closePhoneSheet} aria-label={t('common.close')}>×</button>
                    </div>
                    <div className="ps-phone-sheet-content">{selectedPhoneContent}</div>
                  </>
                ) : null}
              </section>
            </div>
          )}
        </div>
      </PhonePanelActionsContext.Provider>
    );
  }

  return (
    <div
      className="panel-system"
      ref={systemRef}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <div className="ps-main-row">
        {hasLeft && (
          <div className="ps-left-column" style={{ width: layout.leftWidth, minWidth: 180, flexShrink: 0 }}>
            {leftHeader && <div className="ps-left-header">{leftHeader}</div>}
            <PanelZone
              zone="left"
              panelIds={filteredLeft}
              panels={panels}
              collapsed={collapsedSet}
              pinned={pinnedSet}
              onToggle={onTogglePanel}
              onPin={onTogglePin}
              onFloat={onFloatPanel}
              onDragStart={handleDragStart}
              panelContent={panelContent}
              size={layout.leftWidth}
              onResize={(s) => onResizeZone('left', s)}
              resizeEdge="right"
              dropBeforeId={dropBeforeId}
              dropAtEnd={dropAtEndZone === 'left'}
              draggingId={drag?.panelId ?? null}
              modifiedPanelIds={modifiedPanelIds}
              onResetPanel={onResetPanel}
            />
          </div>
        )}
        <div className="ps-center">
          {toolbar && <div className="ps-toolbar">{toolbar}</div>}
          <div className="ps-canvas">{children}</div>
          {statusBar && <div className="ps-statusbar">{statusBar}</div>}
          {bottomContent && (
            <div className="ps-bottom" style={{ height: layout.bottomHeight }}>
              {bottomContent}
            </div>
          )}
        </div>
        {hasRight && (
          <PanelZone
            zone="right"
            panelIds={filteredRight}
            panels={panels}
            collapsed={collapsedSet}
            pinned={pinnedSet}
            onToggle={onTogglePanel}
            onPin={onTogglePin}
            onFloat={onFloatPanel}
            onDragStart={handleDragStart}
            panelContent={panelContent}
            size={layout.rightWidth}
            onResize={(s) => onResizeZone('right', s)}
            resizeEdge="left"
            dropBeforeId={dropBeforeId}
            dropAtEnd={dropAtEndZone === 'right'}
            draggingId={drag?.panelId ?? null}
            modifiedPanelIds={modifiedPanelIds}
            onResetPanel={onResetPanel}
          />
        )}
      </div>

      {/* Floating panels */}
      {layout.floating.map((fp) => {
        const def = panels.get(fp.id);
        const content = panelContent.get(fp.id);
        if (!def || !content) return null;
        return (
          <FloatingPanel
            key={fp.id}
            definition={def}
            x={fp.x}
            y={fp.y}
            width={fp.width}
            height={fp.height}
            collapsed={collapsedSet.has(fp.id)}
            onToggle={() => onTogglePanel(fp.id)}
            onDock={onDockPanel ? () => onDockPanel(fp.id) : undefined}
            onMove={onUpdateFloatingPos ? (x, y) => onUpdateFloatingPos(fp.id, { x, y }) : undefined}
            onReset={modifiedPanelIds?.has(fp.id) && onResetPanel ? () => onResetPanel(fp.id) : undefined}
          >
            {content}
          </FloatingPanel>
        );
      })}

      {/* Drag overlay — follows cursor */}
      {drag && draggedDef && (
        <div
          className="ps-drag-overlay"
          style={{ left: drag.currentX + 12, top: drag.currentY - 10 }}
        >
          <span className="mod-panel-icon">{draggedDef.icon}</span>
          <span className="ps-drag-title">{t(draggedDef.title)}</span>
        </div>
      )}
    </div>
  );
}

function PanelEdgeIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="14" height="14" rx="2" />
      <path d={direction === 'left' ? 'M11 5L7 9l4 4' : 'M7 5l4 4-4 4'} />
    </svg>
  );
}

function PhoneToolGroup({ group, panels, onSelect }: {
  group: PhonePanelGroup;
  panels: Map<string, PanelDefinition>;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="ps-phone-tool-group" aria-labelledby={`phone-tool-group-${group.id}`}>
      <h3 id={`phone-tool-group-${group.id}`}>{t(group.titleKey)}</h3>
      <div className="ps-phone-tool-grid">
        {group.ids.map((id) => {
          const definition = panels.get(id);
          if (!definition) return null;
          return (
            <button key={id} onClick={() => onSelect(id)}>
              <span className="ps-phone-tool-icon" aria-hidden="true">{definition.icon}</span>
              <span>{t(definition.title)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ChevronIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M5 7l4 4 4-4" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M13 4l-6 6 6 6" />
    </svg>
  );
}

/**
 * Read the drop geometry off the DOM. Only the rendered panels are measured,
 * and each one is carried by its id - `resolveDrop` decides the rest.
 */
function readDropZones(container: HTMLElement | null): DropCandidateZone[] {
  if (!container) return [];
  const zones: DropCandidateZone[] = [];
  for (const zone of ['left', 'right'] as const) {
    const zoneEl = container.querySelector(`.pz-${zone}`);
    if (!zoneEl) continue;
    const rect = zoneEl.getBoundingClientRect();
    const panels: DropCandidateZone['panels'] = [];
    for (const el of zoneEl.querySelectorAll<HTMLElement>('.mod-panel[data-panel-id]')) {
      const panelRect = el.getBoundingClientRect();
      panels.push({ id: el.dataset.panelId as string, top: panelRect.top, bottom: panelRect.bottom });
    }
    zones.push({
      zone,
      bounds: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
      panels,
    });
  }
  return zones;
}

function FloatingPanel({ definition, x, y, width, height, collapsed, onToggle, onDock, onMove, onReset, children }: {
  definition: PanelDefinition;
  x: number; y: number; width: number; height: number;
  collapsed: boolean; onToggle: () => void;
  onDock?: () => void;
  onMove?: (x: number, y: number) => void;
  onReset?: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const dragging = useRef(false);
  const offset = useRef({ x: 0, y: 0 });
  const posRef = useRef({ x, y });
  const elRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.ps-floating-btn')) return;
    dragging.current = true;
    offset.current = { x: e.clientX - posRef.current.x, y: e.clientY - posRef.current.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !elRef.current) return;
    const nx = e.clientX - offset.current.x;
    const ny = e.clientY - offset.current.y;
    posRef.current = { x: nx, y: ny };
    elRef.current.style.left = `${nx}px`;
    elRef.current.style.top = `${ny}px`;
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    onMove?.(posRef.current.x, posRef.current.y);
  }, [onMove]);

  return (
    <div ref={elRef} className="ps-floating" style={{ left: x, top: y, width, height: collapsed ? 'auto' : height }}>
      <div
        className="ps-floating-header"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <span className="mod-panel-icon">{definition.icon}</span>
        <span className="mod-panel-title">{t(definition.title)}</span>
        <div className="ps-floating-actions">
          {onDock && (
            <button className="ps-floating-btn" onClick={onDock} title={t('uiShell.floating.dock')}>
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="1" y="1" width="8" height="8" rx="1" /><line x1="6" y1="1" x2="6" y2="9" />
              </svg>
            </button>
          )}
          {onReset && (
            <button className="ps-floating-btn" onClick={onReset} title={t('uiShell.modPanel.reset')} aria-label={t('uiShell.modPanel.reset')}>
              <PanelResetIcon />
            </button>
          )}
          <button className="ps-floating-btn" onClick={onToggle} title={collapsed ? t('uiShell.floating.expand') : t('uiShell.floating.collapse')}>
            {collapsed ? '\u25B8' : '\u25BE'}
          </button>
        </div>
      </div>
      {!collapsed && (
        <div className="ps-floating-body">{children}</div>
      )}
    </div>
  );
}
