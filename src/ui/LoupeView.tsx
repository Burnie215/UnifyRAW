import { useEffect, useRef, useState } from 'react';
import './LoupeView.css';

interface LoupeViewProps {
  /** The canvas the editor renders into. */
  source: HTMLCanvasElement | null;
  /** Bumped after every render, so the loupe re-cuts when the picture changes. */
  renderGeneration: number;
  /** Edge of the cut-out in source pixels. */
  edge?: number;
}

const DEFAULT_EDGE = 220;

/**
 * A 1:1 window into the rendered image.
 *
 * The canvas is fitted to the viewport, so what is on screen is a
 * down-scaled picture: sharpening, noise reduction and grain are all decided
 * at a scale the editor never actually shows. The loupe cuts a square out of
 * the render at its own pixels and draws it unscaled, which is the only view
 * in which those three sliders mean anything.
 *
 * It follows the pointer over the image and holds the last position when the
 * pointer leaves, so the view stays put while the sliders are being moved -
 * a loupe that snapped back to the middle every time the hand left the canvas
 * would be useless for exactly the job it exists for.
 */
export function LoupeView({ source, renderGeneration, edge = DEFAULT_EDGE }: LoupeViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Normalised, so the point survives a resize or a new photo of another size.
  const pointRef = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
  const [tracking, setTracking] = useState(false);

  useEffect(() => {
    if (!source) return;
    // Listening on the window and hit-testing the canvas rect, rather than on
    // the canvas itself: the editor stacks overlays over the image - crop
    // frame, mask outlines, the vignette preview - and any of them swallows a
    // pointermove before the canvas underneath ever sees it.
    const onMove = (e: PointerEvent) => {
      const rect = source.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      if (e.clientX < rect.left || e.clientX > rect.right
        || e.clientY < rect.top || e.clientY > rect.bottom) return;
      pointRef.current = {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
      setTracking(true);
      draw();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, edge]);

  function draw() {
    const target = canvasRef.current;
    if (!target || !source || !source.width || !source.height) return;
    const size = Math.min(edge, source.width, source.height);
    const sx = Math.max(0, Math.min(source.width - size, Math.round(pointRef.current.x * source.width - size / 2)));
    const sy = Math.max(0, Math.min(source.height - size, Math.round(pointRef.current.y * source.height - size / 2)));
    if (target.width !== size || target.height !== size) {
      target.width = size;
      target.height = size;
    }
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    try {
      ctx.drawImage(source, sx, sy, size, size, 0, 0, size, size);
    } catch { /* a canvas mid-resize has no readable pixels; the next pass draws */ }
  }

  // Re-cut whenever the picture underneath changes, without waiting for the
  // pointer to move: the whole point is watching a slider act on this spot.
  useEffect(draw, [renderGeneration, source, edge]);

  return (
    <div className="loupe-view">
      <div className="loupe-frame">
        <canvas ref={canvasRef} className="loupe-canvas" data-testid="loupe-canvas" />
        {!source && <div className="loupe-state">Kein Bild geladen</div>}
        {source && !tracking && <div className="loupe-state">Zeiger über das Bild bewegen</div>}
      </div>
      <div className="loupe-hint">
        1:1 aus dem gerenderten Bild — Schärfe, Entrauschung und Korn sind nur hier zu beurteilen.
      </div>
    </div>
  );
}
