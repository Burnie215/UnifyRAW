import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { SpotRemoval } from '../engine/Mask';
import { MAX_RETOUCH_SPOTS } from '../engine/graph';
import './RetouchTool.css';

interface RetouchToolProps {
  active: boolean;
  mode: 'heal' | 'clone';
  spots: SpotRemoval[];
  brushRadius: number;
  onBrushRadiusChange: (r: number) => void;
  onSpotAdd: (spot: Omit<SpotRemoval, 'id'>) => void;
  onSpotDelete: (id: string) => void;
  imageWidth: number;
  imageHeight: number;
}

export function RetouchTool({
  active, mode, spots, brushRadius, onBrushRadiusChange,
  onSpotAdd, onSpotDelete, imageWidth, imageHeight: _imageHeight,
}: RetouchToolProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<'target' | 'source'>('target');
  const [targetPos, setTargetPos] = useState<{ x: number; y: number } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const atLimit = spots.length >= MAX_RETOUCH_SPOTS;
  const limitMessage = t('adjustments.retouch.limitReached', { max: MAX_RETOUCH_SPOTS });

  const toNorm = useCallback((e: React.PointerEvent): { x: number; y: number } => {
    const rect = containerRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!active || atLimit) return;
    const pos = toNorm(e);

    if (phase === 'target') {
      setTargetPos(pos);
      setPhase('source');
    } else if (phase === 'source' && targetPos) {
      onSpotAdd({
        mode,
        // Stored as a fraction of the image width, not as the pixels of this
        // preview: the same spot has to have the same size in the export.
        target: { x: targetPos.x, y: targetPos.y, radius: brushRadius / Math.max(imageWidth, 1) },
        source: { x: pos.x, y: pos.y },
        feather: 0.5,
        opacity: 1,
      });
      setTargetPos(null);
      setPhase('target');
    }
  }, [active, atLimit, phase, targetPos, mode, brushRadius, imageWidth, toNorm, onSpotAdd]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!active) return;
    setCursorPos(toNorm(e));
  }, [active, toNorm]);

  if (!active) return null;

  return (
    <div
      className={`retouch-tool ${atLimit ? 'at-limit' : ''}`}
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      aria-disabled={atLimit}
      title={atLimit ? limitMessage : undefined}
    >
      {/* Existing spots */}
      {spots.map((spot) => (
        <div key={spot.id} className="retouch-spot-group">
          {/* Target circle */}
          <div
            className="retouch-circle target"
            style={{
              left: `${spot.target.x * 100}%`,
              top: `${spot.target.y * 100}%`,
              width: spot.target.radius * imageWidth * 2,
              height: spot.target.radius * imageWidth * 2,
            }}
          >
            <button className="retouch-delete" onClick={(e) => { e.stopPropagation(); onSpotDelete(spot.id); }} title={t('adjustments.retouch.deletePoint')}>×</button>
          </div>
          {/* Source circle */}
          <div
            className="retouch-circle source"
            style={{
              left: `${spot.source.x * 100}%`,
              top: `${spot.source.y * 100}%`,
              width: spot.target.radius * imageWidth * 2,
              height: spot.target.radius * imageWidth * 2,
            }}
          />
          {/* Connection line */}
          <svg className="retouch-line" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            <line
              x1={`${spot.target.x * 100}%`} y1={`${spot.target.y * 100}%`}
              x2={`${spot.source.x * 100}%`} y2={`${spot.source.y * 100}%`}
              stroke="rgba(255,255,255,0.4)" strokeWidth="1" strokeDasharray="4 4"
            />
          </svg>
        </div>
      ))}

      {/* Target preview (waiting for source click) */}
      {targetPos && phase === 'source' && (
        <div
          className="retouch-circle target preview"
          style={{
            left: `${targetPos.x * 100}%`,
            top: `${targetPos.y * 100}%`,
            width: brushRadius * 2,
            height: brushRadius * 2,
          }}
        />
      )}

      {/* Brush cursor */}
      {cursorPos && (
        <div
          className="retouch-cursor"
          style={{
            left: `${cursorPos.x * 100}%`,
            top: `${cursorPos.y * 100}%`,
            width: brushRadius * 2,
            height: brushRadius * 2,
          }}
        />
      )}

      {/* Toolbar */}
      <div className="retouch-toolbar">
        <span className="retouch-mode">{mode === 'heal' ? t('adjustments.retouch.heal') : t('adjustments.retouch.clone')}</span>
        <span className="retouch-phase">
          {atLimit ? limitMessage : phase === 'target' ? t('adjustments.retouch.clickTarget') : t('adjustments.retouch.clickSource')}
        </span>
        <label className="retouch-size" title={t('adjustments.retouch.sizeTitle')}>
          {t('adjustments.retouch.size')}
          <input type="range" min={5} max={100} value={brushRadius} onChange={(e) => onBrushRadiusChange(Number(e.target.value))} title={`${brushRadius}px`} />
          <span>{brushRadius}px</span>
        </label>
      </div>
    </div>
  );
}
