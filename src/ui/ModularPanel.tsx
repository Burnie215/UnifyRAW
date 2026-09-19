import { useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { PanelDefinition } from './panelTypes';
import './ModularPanel.css';

interface ModularPanelProps {
  definition: PanelDefinition;
  collapsed: boolean;
  pinned?: boolean;
  onToggle: () => void;
  onPin?: () => void;
  onDragStart?: (e: React.PointerEvent, panelId: string) => void;
  onFloat?: () => void;
  onReset?: () => void;
  children: React.ReactNode;
  /** Show a drop indicator above this panel */
  dropBefore?: boolean;
}

export function ModularPanel({
  definition, collapsed, pinned, onToggle, onPin, onDragStart, onFloat, onReset, children, dropBefore,
}: ModularPanelProps) {
  const { t } = useTranslation();
  const headerRef = useRef<HTMLDivElement>(null);
  const dragIntent = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const didDrag = useRef(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // Only left button
    if (e.button !== 0) return;
    didDrag.current = false;
    dragIntent.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    headerRef.current?.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragIntent.current) return;
    const dx = e.clientX - dragIntent.current.x;
    const dy = e.clientY - dragIntent.current.y;
    // Threshold: 5px before starting drag
    if (Math.abs(dx) + Math.abs(dy) > 5) {
      didDrag.current = true;
      if (onDragStart) {
        onDragStart(e, definition.id);
      }
      dragIntent.current = null;
    }
  }, [onDragStart, definition.id]);

  const handlePointerUp = useCallback(() => {
    dragIntent.current = null;
  }, []);

  const handleClick = useCallback(() => {
    // Don't toggle if we just finished a drag
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);

  const handleDoubleClick = useCallback(() => {
    if (onFloat) onFloat();
  }, [onFloat]);

  return (
    <div className={`mod-panel ${collapsed ? 'collapsed' : ''}`} data-panel-id={definition.id}>
      {dropBefore && <div className="mod-panel-drop-indicator" />}
      <div
        ref={headerRef}
        className="mod-panel-header"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        <span className="mod-panel-icon">{definition.icon}</span>
        <span className="mod-panel-title">{t(definition.title)}</span>
        <div className="mod-panel-actions">
          {onPin && (
            <button
              className={`mod-panel-pin ${pinned ? 'active' : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onPin(); }}
              title={pinned ? t('uiShell.modPanel.unpin') : t('uiShell.modPanel.pin')}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M6 1L9 4M3 4l3-3 2.5 2.5-1 2L5 8l-1-1-2.5 1.5L3 6 1.5 4.5z" />
              </svg>
            </button>
          )}
          {onReset && (
            <button
              className="mod-panel-reset"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); onReset(); }}
              onDoubleClick={(e) => e.stopPropagation()}
              title={t('uiShell.modPanel.reset')}
              aria-label={t('uiShell.modPanel.reset')}
            >
              <PanelResetIcon />
            </button>
          )}
          <span className="mod-panel-chevron">{collapsed ? '\u25B8' : '\u25BE'}</span>
        </div>
      </div>
      {!collapsed && (
        <div className="mod-panel-body">
          {children}
        </div>
      )}
    </div>
  );
}

export function PanelResetIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M2.2 4.2A4.2 4.2 0 1 1 2 7" />
      <path d="M2.2 1.8v2.6h2.6" />
    </svg>
  );
}
