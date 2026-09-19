import { useCallback } from 'react';
import type { BenchSource } from './useBenchSources';

interface BenchTileProps {
  source: BenchSource;
  focused: boolean;
  onFocus: () => void;
  /** Click position inside the image, normalised 0..1 - where the loupe cuts. */
  onPick: (x: number, y: number) => void;
  registerCanvas: (photoId: number, el: HTMLCanvasElement | null) => void;
  /** Straight lines to judge distortion against - it is invisible without them. */
  gridOverlay?: boolean;
  /**
   * Set when this photo is what stops a profile being saved - it names a
   * different camera or lens than the rest, or names none at all.
   */
  odd?: 'camera' | 'lens' | 'both';
  /** Take it out of the selection. */
  onExclude?: () => void;
  /** Vouch for it: same camera and lens, whatever the file records. */
  onAccept?: () => void;
}

export function BenchTile({
  source, focused, onFocus, onPick, registerCanvas, gridOverlay, odd, onExclude, onAccept,
}: BenchTileProps) {
  const ref = useCallback(
    (el: HTMLCanvasElement | null) => registerCanvas(source.photoId, el),
    [registerCanvas, source.photoId],
  );

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    onFocus();
    const canvas = e.currentTarget.querySelector('canvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    onPick(x, y);
  };

  return (
    <div
      className={`bench-tile ${focused ? 'focused' : ''} ${source.status} ${source.reference ? 'reference' : ''} ${odd ? 'odd' : ''}`}
      data-testid="bench-tile"
      data-photo-id={source.photoId}
      onClick={handleClick}
    >
      <div className="bench-tile-frame">
        <canvas ref={ref} className="bench-tile-canvas" />
        {gridOverlay && <div className="bench-tile-grid" aria-hidden="true" />}
        {odd && (
          <div className="bench-tile-odd" onClick={(e) => e.stopPropagation()}>
            <span className="bench-tile-odd-why">
              {odd === 'camera' ? 'andere Kamera'
                : odd === 'lens' ? 'anderes Objektiv'
                : 'andere Kamera und anderes Objektiv'}
            </span>
            <div className="bench-tile-odd-actions">
              <button
                className="bench-tile-odd-btn"
                data-testid="tile-exclude"
                title="Aus der Auswahl nehmen"
                onClick={onExclude}
              >×</button>
              <button
                className="bench-tile-odd-btn accept"
                data-testid="tile-accept"
                title="Gehört doch dazu - gleiche Kamera und gleiches Objektiv"
                onClick={onAccept}
              >✓</button>
            </div>
          </div>
        )}
        {source.status !== 'ready' && (
          <div className="bench-tile-state">
            {source.status === 'error'
              ? (source.error ?? 'Fehler')
              : `${source.stage ?? 'lädt'} …`}
          </div>
        )}
      </div>
      <div className="bench-tile-name" title={source.name}>
        {source.name}
        {source.status === 'ready' && source.kind === 'raw16' && (
          <span className="bench-tile-badge">RAW</span>
        )}
        {source.status === 'ready' && source.reference && (
          <span className="bench-tile-badge">Referenz</span>
        )}
        {source.status === 'ready' && source.rawFallback && (
          <span className="bench-tile-badge warn" title="RAW-Entwicklung fehlgeschlagen - hier steht das Kamera-JPEG">
            Kamera-JPEG
          </span>
        )}
      </div>
    </div>
  );
}
