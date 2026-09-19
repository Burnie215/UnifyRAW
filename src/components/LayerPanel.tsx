import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { DocLayer, DocLayerType, BlendMode } from '../engine/DocumentModel';
import type { MaskType } from '../engine/Mask';
import { BLEND_MODES } from '../engine/DocumentModel';
import { CompactSlider as Slider } from '../ui/CompactSlider';
import './LayerPanel.css';

interface LayerPanelProps {
  layers: DocLayer[];
  activeLayerId: string | null;
  onSelectLayer: (id: string | null) => void;
  onAddLayer: (type: DocLayerType) => void;
  onDeleteLayer: (id: string) => void;
  onDuplicateLayer: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onToggleLock: (id: string) => void;
  onOpacityChange: (id: string, opacity: number) => void;
  onBlendModeChange: (id: string, mode: BlendMode) => void;
  onReorderLayers: (fromIndex: number, toIndex: number) => void;
  onRenameLayer: (id: string, name: string) => void;
  onAddImageLayer?: () => void;
  onAddMask?: (layerId: string, type: MaskType) => void;
  onRemoveMask?: (layerId: string) => void;
}

export function LayerPanel({
  layers, activeLayerId,
  onSelectLayer, onAddLayer, onDeleteLayer, onDuplicateLayer,
  onToggleVisibility, onToggleLock, onOpacityChange, onBlendModeChange,
  onReorderLayers, onRenameLayer, onAddImageLayer, onAddMask, onRemoveMask,
}: LayerPanelProps) {
  const { t } = useTranslation();
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; layerId: string } | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const activeLayer = layers.find((l) => l.id === activeLayerId);

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((index: number) => {
    if (dragIndex === null || dragIndex === index) return;
    setDropTarget(index);
  }, [dragIndex]);

  const handleDragEnd = useCallback(() => {
    if (dragIndex !== null && dropTarget !== null && dragIndex !== dropTarget) {
      onReorderLayers(dragIndex, dropTarget);
    }
    setDragIndex(null);
    setDropTarget(null);
  }, [dragIndex, dropTarget, onReorderLayers]);

  const handleNameDoubleClick = useCallback((id: string) => {
    setEditingName(id);
    setTimeout(() => nameInputRef.current?.select(), 50);
  }, []);

  const handleNameBlur = useCallback((id: string, name: string) => {
    if (name.trim()) onRenameLayer(id, name.trim());
    setEditingName(null);
  }, [onRenameLayer]);

  return (
    <div className="layer-panel">
      {/* Active layer controls */}
      {activeLayer && (
        <div className="layer-controls">
          <div className="layer-control-row">
            <label>{t('panels.layers.opacity')}</label>
            <Slider
              label=""
              value={Math.round(activeLayer.opacity * 100)}
              min={0} max={100}
              onChange={(v) => onOpacityChange(activeLayer.id, v / 100)}
            />
          </div>
          <div className="layer-control-row">
            <label>{t('panels.layers.mode')}</label>
            <select
              className="blend-mode-select"
              value={activeLayer.blendMode}
              onChange={(e) => onBlendModeChange(activeLayer.id, e.target.value as BlendMode)}
            >
              {BLEND_MODES.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Layer list (top = front, bottom = back) */}
      <div className="layer-list">
        {layers.length === 0 && (
          <div className="layer-empty">{t('panels.layers.empty')}</div>
        )}
        {[...layers].reverse().map((layer, revIdx) => {
          const realIdx = layers.length - 1 - revIdx;
          return (
            <div
              key={layer.id}
              className={`layer-item ${activeLayerId === layer.id ? 'active' : ''} ${dropTarget === realIdx ? 'drop-target' : ''} ${dragIndex === realIdx ? 'dragging' : ''}`}
              onClick={() => onSelectLayer(layer.id)}
              onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, layerId: layer.id }); }}
              onPointerDown={() => handleDragStart(realIdx)}
              onPointerOver={() => handleDragOver(realIdx)}
              onPointerUp={handleDragEnd}
            >
              {/* Visibility */}
              <button
                className={`layer-vis ${layer.visible ? '' : 'off'}`}
                onClick={(e) => { e.stopPropagation(); onToggleVisibility(layer.id); }}
                title={layer.visible ? t('panels.layers.hide') : t('panels.layers.show')}
              >
                {layer.visible ? '●' : '○'}
              </button>

              {/* Thumbnail */}
              <LayerThumbnail layer={layer} size={28} />

              {/* Name */}
              {editingName === layer.id ? (
                <input
                  ref={nameInputRef}
                  className="layer-name-input"
                  defaultValue={layer.name}
                  onBlur={(e) => handleNameBlur(layer.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditingName(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span
                  className="layer-name"
                  onDoubleClick={(e) => { e.stopPropagation(); handleNameDoubleClick(layer.id); }}
                >
                  {layer.name}
                </span>
              )}

              {/* Lock */}
              <button
                className={`layer-lock ${layer.locked ? 'locked' : ''}`}
                onClick={(e) => { e.stopPropagation(); onToggleLock(layer.id); }}
                title={layer.locked ? t('panels.layers.unlock') : t('panels.layers.lock')}
              >
                {layer.locked ? '🔒' : ''}
              </button>

              {/* Mask indicator */}
              {layer.mask && (
                <span className="layer-mask-badge" title={t('panels.layers.maskBadge', { type: layer.mask.type })}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
                    <circle cx="5" cy="5" r="4" /><path d="M5 1v8" />
                  </svg>
                </span>
              )}

              {/* Opacity indicator */}
              {layer.opacity < 1 && (
                <span className="layer-opacity-badge">{Math.round(layer.opacity * 100)}%</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer actions */}
      <div className="layer-actions">
        <button className="layer-add-btn" onClick={onAddImageLayer ?? (() => onAddLayer('image'))} title={t('panels.layers.addImage')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="1" y="1" width="10" height="10" rx="1" /><path d="M1 8l3-3 2 2 3-4 2 3" />
          </svg>
        </button>
        <button className="layer-add-btn" onClick={() => onAddLayer('adjustment')} title={t('panels.layers.addAdjustment')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="6" cy="6" r="4" /><path d="M6 2v8" />
          </svg>
        </button>
        <button className="layer-add-btn" onClick={() => onAddLayer('text')} title={t('panels.layers.addText')}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 2h6M6 2v8M4 10h4" />
          </svg>
        </button>
        <div className="layer-action-spacer" />
        {activeLayerId && (
          <>
            <button className="layer-add-btn" onClick={() => onDuplicateLayer(activeLayerId)} title={t('panels.layers.duplicate')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="1" y="3" width="7" height="7" rx="1" /><rect x="4" y="1" width="7" height="7" rx="1" strokeDasharray="2 2" />
              </svg>
            </button>
            <button className="layer-add-btn danger" onClick={() => onDeleteLayer(activeLayerId)} title={t('panels.layers.delete')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 3h8M4.5 3V2h3v1M3 3v7a1 1 0 001 1h4a1 1 0 001-1V3" />
              </svg>
            </button>
          </>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div className="layer-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={() => setContextMenu(null)} onMouseLeave={() => setContextMenu(null)}>
          {(() => {
            const target = layers.find((l) => l.id === contextMenu.layerId);
            const hasMask = !!target?.mask;
            return (<>
              {target?.type === 'adjustment' && !hasMask && onAddMask && (<>
                <button onClick={() => { onAddMask(contextMenu.layerId, 'brush'); setContextMenu(null); }}>{t('panels.layers.addBrushMask')}</button>
                <button onClick={() => { onAddMask(contextMenu.layerId, 'linear-gradient'); setContextMenu(null); }}>{t('panels.layers.addGradientMask')}</button>
                <button onClick={() => { onAddMask(contextMenu.layerId, 'radial-gradient'); setContextMenu(null); }}>{t('panels.layers.addRadialMask')}</button>
                <button onClick={() => { onAddMask(contextMenu.layerId, 'luminance-range'); setContextMenu(null); }}>{t('panels.layers.addLuminanceMask')}</button>
              </>)}
              {hasMask && onRemoveMask && (
                <button className="danger" onClick={() => { onRemoveMask(contextMenu.layerId); setContextMenu(null); }}>{t('panels.layers.removeMask')}</button>
              )}
              <button onClick={() => { onDuplicateLayer(contextMenu.layerId); setContextMenu(null); }}>{t('panels.layers.duplicate')}</button>
              {target?.type !== 'base' && (
                <button className="danger" onClick={() => { onDeleteLayer(contextMenu.layerId); setContextMenu(null); }}>{t('panels.layers.delete')}</button>
              )}
            </>);
          })()}
        </div>
      )}
    </div>
  );
}

function LayerThumbnail({ layer, size = 32 }: { layer: DocLayer; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d')!;
    ctx.fillStyle = '#333';
    ctx.fillRect(0, 0, size, size);

    if (layer.type === 'image' && layer.imageBlob) {
      createImageBitmap(layer.imageBlob).then((bmp) => {
        ctx.drawImage(bmp, 0, 0, size, size);
        bmp.close();
      });
    } else if (layer.type === 'adjustment') {
      // Half-black half-white circle (Photoshop style)
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 3, -Math.PI / 2, Math.PI / 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 3, Math.PI / 2, -Math.PI / 2);
      ctx.fill();
    } else if (layer.type === 'text') {
      ctx.fillStyle = layer.fontColor ?? '#fff';
      ctx.font = `bold ${size * 0.6}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('T', size / 2, size / 2);
    }
  }, [layer, size]);

  return <canvas ref={canvasRef} width={size} height={size} className="layer-thumb-canvas" />;
}
