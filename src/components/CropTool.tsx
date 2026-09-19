import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { CropAspect } from '../types';
import { normalizeCropRect, type CropRect } from '../engine/Crop';
import './CropTool.css';

interface CropToolProps {
  imageWidth: number;
  imageHeight: number;
  aspect: CropAspect;
  initialCrop?: CropRect;
  onCropChange: (crop: CropRect) => void;
  onCropConfirm: (crop: CropRect) => void;
  onCancel: () => void;
  /** Current rotation in degrees — purely informational here, the handle is
   *  a 2D widget that emits delta values via onRotationChange. */
  rotation?: number;
  onRotationChange?: (deg: number) => void;
  /**
   * Element to render the confirm/cancel buttons into. The crop frame itself
   * lives inside the zoomed image wrapper so it stays glued to the photo — but
   * the buttons must not shrink with the zoom, so they go somewhere unscaled.
   */
  actionsContainer?: HTMLElement | null;
}

export type { CropRect } from '../engine/Crop';

type Handle = 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r' | 'move' | 'rotate';

const ASPECT_RATIOS: Record<CropAspect, number | null> = {
  'free': null,
  '1:1': 1,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
  '16:9': 16 / 9,
  '5:4': 5 / 4,
};

export function CropTool({
  imageWidth, imageHeight, aspect, initialCrop, onCropChange, onCropConfirm, onCancel,
  rotation = 0, onRotationChange, actionsContainer,
}: CropToolProps) {
  const { t } = useTranslation();
  const [crop, setCrop] = useState<CropRect>(() => normalizeCropRect(initialCrop));
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ handle: Handle; startX: number; startY: number; startCrop: CropRect; startRotation: number } | null>(null);

  const constrainAspect = useCallback((c: CropRect, handle: Handle): CropRect => {
    const ratio = ASPECT_RATIOS[aspect];
    if (!ratio) return c;

    const imgRatio = imageWidth / imageHeight;
    const targetRatio = ratio / imgRatio;

    if (handle === 'move') return c;

    // Adjust height to match aspect ratio
    if (['tl', 'tr', 'bl', 'br', 'l', 'r'].includes(handle)) {
      c.height = c.width / targetRatio;
    } else {
      c.width = c.height * targetRatio;
    }

    return c;
  }, [aspect, imageWidth, imageHeight]);

  const handlePointerDown = useCallback((e: React.PointerEvent, handle: Handle) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragging.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startCrop: { ...crop },
      startRotation: rotation,
    };
  }, [crop, rotation]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dxPx = e.clientX - dragging.current.startX;
    const dx = dxPx / rect.width;
    const dy = (e.clientY - dragging.current.startY) / rect.height;
    const s = dragging.current.startCrop;
    const h = dragging.current.handle;

    // Rotation handle: horizontal drag maps to ±45°. Sensitivity tuned so a
    // full image width ≈ 90° → 1px is ~0.1° at typical sizes. Stays a 2D
    // widget that doesn't visually rotate with the value — matches Lightroom.
    if (h === 'rotate') {
      const deg = dragging.current.startRotation + (dxPx / rect.width) * 90;
      const clamped = Math.max(-45, Math.min(45, Math.round(deg * 10) / 10));
      onRotationChange?.(clamped);
      return;
    }

    let newCrop = { ...s };

    switch (h) {
      case 'move':
        newCrop.x = Math.max(0, Math.min(1 - s.width, s.x + dx));
        newCrop.y = Math.max(0, Math.min(1 - s.height, s.y + dy));
        break;
      case 'tl':
        newCrop.x = Math.max(0, s.x + dx);
        newCrop.y = Math.max(0, s.y + dy);
        newCrop.width = s.width - (newCrop.x - s.x);
        newCrop.height = s.height - (newCrop.y - s.y);
        break;
      case 'tr':
        newCrop.width = Math.min(1 - s.x, s.width + dx);
        newCrop.y = Math.max(0, s.y + dy);
        newCrop.height = s.height - (newCrop.y - s.y);
        break;
      case 'bl':
        newCrop.x = Math.max(0, s.x + dx);
        newCrop.width = s.width - (newCrop.x - s.x);
        newCrop.height = Math.min(1 - s.y, s.height + dy);
        break;
      case 'br':
        newCrop.width = Math.min(1 - s.x, s.width + dx);
        newCrop.height = Math.min(1 - s.y, s.height + dy);
        break;
      case 't':
        newCrop.y = Math.max(0, s.y + dy);
        newCrop.height = s.height - (newCrop.y - s.y);
        break;
      case 'b':
        newCrop.height = Math.min(1 - s.y, s.height + dy);
        break;
      case 'l':
        newCrop.x = Math.max(0, s.x + dx);
        newCrop.width = s.width - (newCrop.x - s.x);
        break;
      case 'r':
        newCrop.width = Math.min(1 - s.x, s.width + dx);
        break;
    }

    // Enforce minimum size
    newCrop.width = Math.max(0.05, newCrop.width);
    newCrop.height = Math.max(0.05, newCrop.height);

    newCrop = constrainAspect(newCrop, h);
    setCrop(newCrop);
    onCropChange(newCrop);
  }, [constrainAspect, onCropChange, onRotationChange]);

  const handlePointerUp = useCallback(() => {
    dragging.current = null;
  }, []);

  const actions = (
    <div className="crop-actions">
      <button className="crop-cancel-btn" onClick={onCancel} title={t('adjustments.crop.cancelTitle')}>{t('adjustments.crop.cancel')}</button>
      <button className="crop-confirm-btn" onClick={() => onCropConfirm(crop)} title={t('adjustments.crop.confirmTitle')}>{t('adjustments.crop.confirm')}</button>
    </div>
  );

  const frame = (
    <div
      className="crop-tool"
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      {/* Dark overlay outside crop area */}
      <div className="crop-mask crop-mask-top" style={{ height: `${crop.y * 100}%` }} />
      <div className="crop-mask crop-mask-bottom" style={{ top: `${(crop.y + crop.height) * 100}%`, height: `${(1 - crop.y - crop.height) * 100}%` }} />
      <div className="crop-mask crop-mask-left" style={{ top: `${crop.y * 100}%`, height: `${crop.height * 100}%`, width: `${crop.x * 100}%` }} />
      <div className="crop-mask crop-mask-right" style={{ top: `${crop.y * 100}%`, height: `${crop.height * 100}%`, left: `${(crop.x + crop.width) * 100}%`, width: `${(1 - crop.x - crop.width) * 100}%` }} />

      {/* Crop area */}
      <div
        className="crop-area"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}
        onPointerDown={(e) => handlePointerDown(e, 'move')}
      >
        {/* Grid lines (rule of thirds) */}
        <div className="crop-grid">
          <div className="crop-grid-h" style={{ top: '33.33%' }} />
          <div className="crop-grid-h" style={{ top: '66.67%' }} />
          <div className="crop-grid-v" style={{ left: '33.33%' }} />
          <div className="crop-grid-v" style={{ left: '66.67%' }} />
        </div>

        {/* Resize handles */}
        <div className="crop-handle crop-handle-tl" onPointerDown={(e) => handlePointerDown(e, 'tl')} />
        <div className="crop-handle crop-handle-tr" onPointerDown={(e) => handlePointerDown(e, 'tr')} />
        <div className="crop-handle crop-handle-bl" onPointerDown={(e) => handlePointerDown(e, 'bl')} />
        <div className="crop-handle crop-handle-br" onPointerDown={(e) => handlePointerDown(e, 'br')} />
        <div className="crop-handle crop-handle-t" onPointerDown={(e) => handlePointerDown(e, 't')} />
        <div className="crop-handle crop-handle-b" onPointerDown={(e) => handlePointerDown(e, 'b')} />
        <div className="crop-handle crop-handle-l" onPointerDown={(e) => handlePointerDown(e, 'l')} />
        <div className="crop-handle crop-handle-r" onPointerDown={(e) => handlePointerDown(e, 'r')} />

        {/* Rotation handle — stick above the top edge with a small line.
            Drag horizontally to adjust rotation. The handle itself does not
            rotate with the value (it's a control widget, not a visual hint). */}
        {onRotationChange && (
          <div className="crop-rotate-anchor">
            <div className="crop-rotate-stem" />
            <div
              className="crop-handle crop-handle-rotate"
              title={`${rotation.toFixed(1)}°`}
              onPointerDown={(e) => handlePointerDown(e, 'rotate')}
            />
          </div>
        )}

        {/* Dimensions display */}
        <div className="crop-dims">
          {Math.round(crop.width * imageWidth)} × {Math.round(crop.height * imageHeight)}
        </div>
      </div>

      {actionsContainer ? null : actions}
    </div>
  );

  return actionsContainer
    ? <>{frame}{createPortal(actions, actionsContainer)}</>
    : frame;
}
