import { useRef, useEffect, useCallback } from 'react';
import {
  type Sector, type DragMode,
  SIZE, OUTER_R, PICK_R, toRad,
  getPickAbs, getHueSat, hueDiff, drawWheel,
} from './hslUtils';
import { prepareCanvas } from '../image/hiDpiCanvas';
import { useResizeTick } from '../hooks/useResizeTick';

interface HSLWheelProps {
  sectors: Sector[];
  selectedIdx: number;
  cachedImageData: ImageData | null;
  onUpdateSector: (idx: number, patch: Partial<Sector>) => void;
  onClick: (hue: number, sat: number) => void;
}

export function HSLWheel({ sectors, selectedIdx, cachedImageData, onUpdateSector, onClick }: HSLWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: DragMode; idx: number } | null>(null);
  const wasDragging = useRef(false);

  const activeSector = selectedIdx >= 0 && selectedIdx < sectors.length ? sectors[selectedIdx] : null;

  // The wheel scales with the panel, so a resize has to reach the redraw below.
  useResizeTick(canvasRef);

  // Draw wheel on every render
  useEffect(() => {
    if (!canvasRef.current) return;
    drawWheel(prepareCanvas(canvasRef.current, SIZE, SIZE), sectors, selectedIdx, cachedImageData);
  });

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const el = wheelRef.current;
    if (!el || !activeSector || selectedIdx < 0) return;
    const { hue, sat, screenX, screenY } = getHueSat(e, el);
    const cx = SIZE / 2, cy = SIZE / 2;
    const s = activeSector;

    // Ring markers (12px tolerance)
    const aL = toRad(s.hueCenter - s.hueHalfWidth);
    const aMid = toRad(s.hueCenter);
    const aR = toRad(s.hueCenter + s.hueHalfWidth);
    for (const [angle, dm] of [[aL, 'schenkelL'], [aMid, 'mitte'], [aR, 'schenkelR']] as [number, DragMode][]) {
      const mx = cx + Math.cos(angle) * (OUTER_R + 1);
      const my = cy + Math.sin(angle) * (OUTER_R + 1);
      if (Math.hypot(screenX - mx, screenY - my) < 12) {
        dragRef.current = { mode: dm, idx: selectedIdx };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
    }

    // Pick point (10px tolerance)
    const pick = getPickAbs(s);
    const pRad = toRad(pick.hue);
    const pR = (pick.sat / 100) * PICK_R;
    const ppx = cx + Math.cos(pRad) * pR, ppy = cy + Math.sin(pRad) * pR;
    if (Math.hypot(screenX - ppx, screenY - ppy) < 10) {
      dragRef.current = { mode: 'pickPoint', idx: selectedIdx };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    // Side lines (4° hue tolerance)
    const dh = hueDiff(hue, s.hueCenter);
    if (Math.abs(dh + s.hueHalfWidth) < 4 && sat >= s.satMin - 5 && sat <= s.satMax + 5) {
      dragRef.current = { mode: 'schenkelL', idx: selectedIdx };
      (e.target as HTMLElement).setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    if (Math.abs(dh - s.hueHalfWidth) < 4 && sat >= s.satMin - 5 && sat <= s.satMax + 5) {
      dragRef.current = { mode: 'schenkelR', idx: selectedIdx };
      (e.target as HTMLElement).setPointerCapture(e.pointerId); e.preventDefault(); return;
    }

    // Sat arcs (5% sat tolerance)
    if (Math.abs(sat - s.satMax) < 5 && Math.abs(dh) < s.hueHalfWidth) {
      dragRef.current = { mode: 'sideOuter', idx: selectedIdx };
      (e.target as HTMLElement).setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    if (Math.abs(sat - s.satMin) < 5 && Math.abs(dh) < s.hueHalfWidth) {
      dragRef.current = { mode: 'sideInner', idx: selectedIdx };
      (e.target as HTMLElement).setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
  }, [activeSector, selectedIdx]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !wheelRef.current) return;
    wasDragging.current = true;
    const { hue, sat } = getHueSat(e, wheelRef.current);
    const s = sectors[d.idx];
    if (!s) return;
    const dh = hueDiff(hue, s.hueCenter);

    switch (d.mode) {
      case 'schenkelL': case 'schenkelR':
        onUpdateSector(d.idx, { hueHalfWidth: Math.max(3, Math.min(175, Math.abs(dh))) }); break;
      case 'mitte':
        onUpdateSector(d.idx, { hueCenter: (hue + 360) % 360 }); break;
      case 'sideOuter':
        onUpdateSector(d.idx, { satMax: Math.max(20, Math.min(100, sat)) }); break;
      case 'sideInner':
        onUpdateSector(d.idx, { satMin: Math.max(0, Math.min(80, sat)) }); break;
      case 'pickPoint': {
        const relHue = Math.max(0, Math.min(1, (dh / (s.hueHalfWidth * 2)) + 0.5));
        const relSat = Math.max(0, Math.min(1, (sat - s.satMin) / (s.satMax - s.satMin)));
        onUpdateSector(d.idx, { pickRelHue: relHue, pickRelSat: relSat }); break;
      }
    }
  }, [sectors, onUpdateSector]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
    setTimeout(() => { wasDragging.current = false; }, 10);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (wasDragging.current || !wheelRef.current) return;
    const { hue, sat } = getHueSat(e, wheelRef.current);
    onClick(hue, sat);
  }, [onClick]);

  return (
    <div className="ce-wheel" ref={wheelRef}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    >
      <canvas ref={canvasRef} width={SIZE} height={SIZE} className="ce-wheel-canvas" />
    </div>
  );
}
