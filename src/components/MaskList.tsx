import { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { MaskDefinition, SpotRemoval } from '../engine/Mask';
import { renderMaskToCanvas } from '../engine/Mask';
import type { Adjustments } from '../types';
import { CompactSlider as Slider } from '../ui/CompactSlider';
import { Panel } from './Panel';
import './MaskList.css';

interface MaskListProps {
  masks: MaskDefinition[];
  spots: SpotRemoval[];
  activeMaskId: string | null;
  onSelectMask: (id: string | null) => void;
  onDeleteMask: (id: string) => void;
  onToggleMaskVisibility: (id: string) => void;
  /** The adjustments of the layer the active mask gates. */
  maskLayerAdjustments: Partial<Adjustments>;
  onMaskLayerAdjustmentChange: (id: string, adj: Partial<Adjustments>) => void;
  onMaskPropertyChange?: (id: string, props: Partial<MaskDefinition>) => void;
  onDeleteSpot: (id: string) => void;
}

export function MaskList({
  masks, spots, activeMaskId, onSelectMask, onDeleteMask,
  onToggleMaskVisibility, maskLayerAdjustments, onMaskLayerAdjustmentChange,
  onMaskPropertyChange, onDeleteSpot,
}: MaskListProps) {
  const { t } = useTranslation();
  const activeMask = masks.find((m) => m.id === activeMaskId);

  const LOCAL_SLIDERS: { key: keyof Adjustments; label: string; min: number; max: number }[] = [
    { key: 'exposure', label: t('panels.masks.exposure'), min: -100, max: 100 },
    { key: 'contrast', label: t('panels.masks.contrast'), min: -100, max: 100 },
    { key: 'highlights', label: t('panels.masks.highlights'), min: -100, max: 100 },
    { key: 'shadows', label: t('panels.masks.shadowsDepth'), min: -100, max: 100 },
    { key: 'clarity', label: t('panels.masks.clarity'), min: -100, max: 100 },
    { key: 'saturation', label: t('panels.masks.saturation'), min: -100, max: 100 },
    { key: 'sharpness', label: t('panels.masks.sharpness'), min: -100, max: 100 },
    { key: 'temperature', label: t('panels.masks.temperature'), min: -100, max: 100 },
  ];

  return (
    <div className="mask-list">
      <div className="mask-list-header">
        <span>{t('panels.masks.title')}</span>
        <span className="mask-count">{masks.length}</span>
      </div>

      {masks.length === 0 && spots.length === 0 && (
        <div className="mask-empty">{t('panels.masks.emptyAll')}</div>
      )}

      {/* Mask entries */}
      {masks.map((mask) => (
        <div
          key={mask.id}
          className={`mask-entry ${activeMaskId === mask.id ? 'active' : ''}`}
          onClick={() => onSelectMask(activeMaskId === mask.id ? null : mask.id)}
        >
          <MaskThumbnail mask={mask} size={24} />
          <span className="mask-entry-name">{mask.name}</span>
          <div className="mask-entry-actions">
            <button
              className={`mask-vis-btn ${mask.visible ? '' : 'off'}`}
              onClick={(e) => { e.stopPropagation(); onToggleMaskVisibility(mask.id); }}
              title={mask.visible ? t('panels.masks.hideOne') : t('panels.masks.show')}
            >
              {mask.visible ? '●' : '○'}
            </button>
            <button
              className="mask-del-btn"
              onClick={(e) => { e.stopPropagation(); onDeleteMask(mask.id); }}
              title={t('panels.masks.deleteOne')}
            >
              ×
            </button>
          </div>
        </div>
      ))}

      {/* Spot removal entries */}
      {spots.map((spot) => (
        <div key={spot.id} className="mask-entry spot">
          <span className="mask-type-icon">{spot.mode === 'heal' ? '🩹' : '📋'}</span>
          <span className="mask-entry-name">{spot.mode === 'heal' ? t('panels.masks.repair') : t('panels.masks.clone')}</span>
          <button className="mask-del-btn" onClick={() => onDeleteSpot(spot.id)} title={t('panels.masks.deleteOne')}>×</button>
        </div>
      ))}

      {/* Range mask parameters */}
      {activeMask && activeMask.type === 'luminance-range' && onMaskPropertyChange && (
        <Panel title={t('panels.masks.luminanceRangeTitle')} defaultOpen>
          <div className="mask-local-adjustments">
            <Slider label={t('panels.masks.rangeMin')} value={activeMask.rangeMin ?? 0} min={0} max={255}
              onChange={(v) => onMaskPropertyChange(activeMask.id, { rangeMin: v })} />
            <Slider label={t('panels.masks.rangeMax')} value={activeMask.rangeMax ?? 128} min={0} max={255}
              onChange={(v) => onMaskPropertyChange(activeMask.id, { rangeMax: v })} />
            <Slider label={t('panels.masks.softness')} value={activeMask.rangeFeather ?? 15} min={0} max={50}
              onChange={(v) => onMaskPropertyChange(activeMask.id, { rangeFeather: v })} />
          </div>
        </Panel>
      )}

      {activeMask && activeMask.type === 'color-range' && onMaskPropertyChange && (
        <Panel title={t('panels.masks.colorRangeTitle')} defaultOpen>
          <div className="mask-local-adjustments">
            <Slider label={t('panels.masks.tolerance')} value={activeMask.rangeMax ?? 30} min={5} max={100}
              onChange={(v) => onMaskPropertyChange(activeMask.id, { rangeMax: v })} />
            <Slider label={t('panels.masks.softness')} value={activeMask.rangeFeather ?? 15} min={0} max={50}
              onChange={(v) => onMaskPropertyChange(activeMask.id, { rangeFeather: v })} />
          </div>
        </Panel>
      )}

      {/* Quick sliders for the layer the active mask gates. Same store as the
          regular panels — eight of its fields, next to the mask they act on. */}
      {activeMask && (
        <Panel title={t('panels.masks.localAdjustments')} defaultOpen>
          <div className="mask-local-adjustments">
            {LOCAL_SLIDERS.map(({ key, label, min, max }) => (
              <Slider
                key={key}
                label={label}
                value={(maskLayerAdjustments[key] as number) ?? 0}
                min={min}
                max={max}
                onChange={(v) => onMaskLayerAdjustmentChange(activeMask.id, { ...maskLayerAdjustments, [key]: v })}
              />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function maskTypeLabel(type: string): string {
  switch (type) {
    case 'brush': return '🖌';
    case 'linear-gradient': return '▬';
    case 'radial-gradient': return '◎';
    case 'luminance-range': return '☀';
    case 'color-range': return '🎨';
    case 'ai-segment': return '🤖';
    default: return '?';
  }
}

function MaskThumbnail({ mask, size = 24 }: { mask: MaskDefinition; size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      const maskCanvas = renderMaskToCanvas(mask, size, size);
      const ctx = canvasRef.current.getContext('2d')!;
      ctx.drawImage(maskCanvas, 0, 0);
    } catch {
      // Fallback: fill with type indicator color
      const ctx = canvasRef.current.getContext('2d')!;
      ctx.fillStyle = '#444';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#888';
      ctx.font = `${size * 0.6}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(maskTypeLabel(mask.type), size / 2, size / 2);
    }
  }, [mask, size]);

  return <canvas ref={canvasRef} width={size} height={size} className="mask-thumb-canvas" />;
}
