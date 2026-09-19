import { useRef, useCallback, useEffect, useState } from 'react';
import type { MaskDefinition, BrushStroke, SpotRemoval } from '../engine/Mask';
import { renderMaskToCanvas } from '../engine/Mask';
import './MaskOverlay.css';

interface MaskOverlayProps {
  mask: MaskDefinition | null;
  spotRemovals: SpotRemoval[];
  width: number;
  height: number;
  visible: boolean;
  // Brush interaction
  activeTool: string | null;
  brushRadius: number;
  brushFeather: number;
  brushFlow: number;
  brushErase: boolean;
  onStrokeAdd: (stroke: BrushStroke) => void;
  // Gradient/Radial interaction
  onGradientChange: (start: { x: number; y: number }, end: { x: number; y: number }) => void;
  onRadialChange: (center: { x: number; y: number }, rx: number, ry: number) => void;
  // Spot removal
  onSpotAdd: (spot: Omit<SpotRemoval, 'id'>) => void;
  activeSpotTool: 'spot-heal' | 'spot-clone' | null;
}

export function MaskOverlay({
  mask, spotRemovals, width, height, visible,
  activeTool, brushRadius, brushFeather, brushFlow, brushErase,
  onStrokeAdd, onGradientChange, onRadialChange,
  onSpotAdd, activeSpotTool,
}: MaskOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const currentStroke = useRef<{ x: number; y: number }[]>([]);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const gradientStart = useRef<{ x: number; y: number } | null>(null);

  // Render mask visualization (red overlay)
  useEffect(() => {
    if (!canvasRef.current || !mask || !visible) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, width, height);

    const maskCanvas = renderMaskToCanvas(mask, width, height);
    const maskCtx = maskCanvas.getContext('2d')!;
    const maskData = maskCtx.getImageData(0, 0, width, height);

    // Draw red overlay where mask is active
    const overlay = ctx.createImageData(width, height);
    for (let i = 0; i < maskData.data.length; i += 4) {
      const alpha = maskData.data[i]; // White channel = mask strength
      overlay.data[i] = 255;     // R
      overlay.data[i + 1] = 0;   // G
      overlay.data[i + 2] = 0;   // B
      overlay.data[i + 3] = Math.round(alpha * 0.4); // Semi-transparent red
    }
    ctx.putImageData(overlay, 0, 0);

    // Draw spot removal indicators
    for (const spot of spotRemovals) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(spot.target.x * width, spot.target.y * height, spot.target.radius * width, 0, Math.PI * 2);
      ctx.stroke();
      // Arrow from source to target
      ctx.beginPath();
      ctx.moveTo(spot.source.x * width, spot.source.y * height);
      ctx.lineTo(spot.target.x * width, spot.target.y * height);
      ctx.stroke();
    }
  }, [mask, visible, width, height, spotRemovals]);

  const toNorm = useCallback((e: React.PointerEvent): { x: number; y: number } => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height,
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const pos = toNorm(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    if (activeTool === 'brush') {
      drawing.current = true;
      currentStroke.current = [pos];
    } else if (activeTool === 'linear-gradient') {
      gradientStart.current = pos;
    } else if (activeTool === 'radial-gradient') {
      gradientStart.current = pos;
    } else if (activeSpotTool) {
      // First click = target, second click would be source (simplified: auto-offset)
      onSpotAdd({
        mode: activeSpotTool === 'spot-heal' ? 'heal' : 'clone',
        target: { x: pos.x, y: pos.y, radius: brushRadius / Math.max(width, 1) },
        source: { x: pos.x + 0.05, y: pos.y }, // Auto-offset source
        feather: brushFeather,
        opacity: 1,
      });
    }
  }, [activeTool, activeSpotTool, brushRadius, brushFeather, width, toNorm, onSpotAdd]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const pos = toNorm(e);
    setCursorPos(pos);

    if (drawing.current && activeTool === 'brush') {
      currentStroke.current.push(pos);
      // Live preview: draw on canvas
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx) {
        ctx.globalAlpha = brushFlow * 0.4;
        ctx.fillStyle = brushErase ? 'black' : 'rgba(255,0,0,0.5)';
        ctx.beginPath();
        ctx.arc(pos.x * width, pos.y * height, brushRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }, [activeTool, brushRadius, brushFlow, brushErase, width, height, toNorm]);

  const handlePointerUp = useCallback(() => {
    if (drawing.current && activeTool === 'brush') {
      drawing.current = false;
      if (currentStroke.current.length > 0) {
        onStrokeAdd({
          points: [...currentStroke.current],
          radius: brushRadius,
          feather: brushFeather,
          flow: brushFlow,
          erase: brushErase,
        });
        currentStroke.current = [];
      }
    } else if (gradientStart.current && cursorPos) {
      if (activeTool === 'linear-gradient') {
        onGradientChange(gradientStart.current, cursorPos);
      } else if (activeTool === 'radial-gradient') {
        const dx = cursorPos.x - gradientStart.current.x;
        const dy = cursorPos.y - gradientStart.current.y;
        const rx = Math.abs(dx);
        const ry = Math.abs(dy);
        onRadialChange(gradientStart.current, rx, ry);
      }
      gradientStart.current = null;
    }
  }, [activeTool, brushRadius, brushFeather, brushFlow, brushErase, cursorPos, onStrokeAdd, onGradientChange, onRadialChange]);

  if (!activeTool && !activeSpotTool && !visible) return null;

  const isInteractive = !!activeTool || !!activeSpotTool;

  return (
    <div className="mask-overlay-container" style={{ pointerEvents: isInteractive ? 'auto' : 'none' }}>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="mask-overlay-canvas"
        style={{ pointerEvents: isInteractive ? 'auto' : 'none', cursor: isInteractive ? 'crosshair' : 'default' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
      {/* Brush cursor */}
      {cursorPos && (activeTool === 'brush' || activeSpotTool) && (
        <div
          className="brush-cursor"
          style={{
            left: `${cursorPos.x * 100}%`,
            top: `${cursorPos.y * 100}%`,
            width: brushRadius * 2,
            height: brushRadius * 2,
          }}
        />
      )}
    </div>
  );
}
