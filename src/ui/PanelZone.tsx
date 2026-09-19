import { useRef, useCallback } from 'react';
import type { PanelDefinition } from './panelTypes';
import { ModularPanel } from './ModularPanel';
import './PanelZone.css';

interface PanelZoneProps {
  zone: 'left' | 'right' | 'bottom';
  panelIds: string[];
  panels: Map<string, PanelDefinition>;
  collapsed: Set<string>;
  pinned?: Set<string>;
  onToggle: (id: string) => void;
  onPin?: (id: string) => void;
  onFloat?: (id: string) => void;
  onDragStart?: (e: React.PointerEvent, panelId: string) => void;
  panelContent: Map<string, React.ReactNode>;
  size: number;
  onResize: (size: number) => void;
  resizeEdge: 'right' | 'left' | 'top';
  dropBeforeId?: string | null;
  dropAtEnd?: boolean;
  draggingId?: string | null;
  modifiedPanelIds?: ReadonlySet<string>;
  onResetPanel?: (id: string) => void;
}

export function PanelZone({
  zone, panelIds, panels, collapsed, pinned, onToggle, onPin, onFloat, onDragStart,
  panelContent, size, onResize, resizeEdge,
  dropBeforeId, dropAtEnd, draggingId, modifiedPanelIds, onResetPanel,
}: PanelZoneProps) {
  const dragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const handleDividerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    startPos.current = resizeEdge === 'top' ? e.clientY : e.clientX;
    startSize.current = size;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [size, resizeEdge]);

  const handleDividerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    if (resizeEdge === 'right') {
      onResize(startSize.current + (e.clientX - startPos.current));
    } else if (resizeEdge === 'left') {
      onResize(startSize.current - (e.clientX - startPos.current));
    } else {
      onResize(startSize.current - (e.clientY - startPos.current));
    }
  }, [onResize, resizeEdge]);

  const handleDividerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const isHorizontal = zone === 'bottom';
  const sizeStyle = isHorizontal
    ? { height: size, minHeight: 60 }
    : { width: size, minWidth: 180 };

  const dividerClass = `pz-divider pz-divider-${resizeEdge}`;

  const pinnedIds = panelIds.filter((id) => pinned?.has(id));
  const scrollIds = panelIds.filter((id) => !pinned?.has(id));

  const renderPanel = (id: string) => {
    const def = panels.get(id);
    if (!def) return null;
    const content = panelContent.get(id);
    if (!content) return null;
    const isDragging = id === draggingId;
    return (
      <div key={id} className={isDragging ? 'pz-panel-dragging' : undefined}>
        <ModularPanel
          definition={def}
          collapsed={collapsed.has(id)}
          pinned={pinned?.has(id)}
          onToggle={() => onToggle(id)}
          onPin={onPin ? () => onPin(id) : undefined}
          onFloat={onFloat ? () => onFloat(id) : undefined}
          onDragStart={onDragStart}
          onReset={modifiedPanelIds?.has(id) && onResetPanel ? () => onResetPanel(id) : undefined}
          dropBefore={dropBeforeId === id}
        >
          {content}
        </ModularPanel>
      </div>
    );
  };

  return (
    <div className={`panel-zone pz-${zone}`} style={sizeStyle}>
      <div
        className={dividerClass}
        onPointerDown={handleDividerDown}
        onPointerMove={handleDividerMove}
        onPointerUp={handleDividerUp}
      />
      {pinnedIds.length > 0 && (
        <div className="pz-pinned">
          {pinnedIds.map(renderPanel)}
        </div>
      )}
      <div className="pz-scroll">
        {scrollIds.map(renderPanel)}
        {dropAtEnd && <div className="mod-panel-drop-indicator" />}
      </div>
    </div>
  );
}
