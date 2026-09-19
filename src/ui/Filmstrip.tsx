import { useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../storage/repos';
import { useThumbnail } from '../hooks/useThumbnail';
import './Filmstrip.css';

interface FilmstripProps {
  photos: PhotoView[];
  activePhotoId: number | null;
  onSelect: (photo: PhotoView) => void;
  onOpen: (photo: PhotoView) => void;
  height: number;
  onHeightChange: (h: number) => void;
}

export function Filmstrip({ photos, activePhotoId, onSelect, onOpen, height, onHeightChange }: FilmstripProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // Scroll active photo into view
  useEffect(() => {
    if (!scrollRef.current || !activePhotoId) return;
    const el = scrollRef.current.querySelector(`[data-photo-id="${activePhotoId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [activePhotoId]);

  // Keyboard navigation
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement) return;
      const idx = photos.findIndex((p) => p.id === activePhotoId);
      if (e.key === 'ArrowLeft' && idx > 0) { e.preventDefault(); onSelect(photos[idx - 1]); }
      if (e.key === 'ArrowRight' && idx < photos.length - 1) { e.preventDefault(); onSelect(photos[idx + 1]); }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [photos, activePhotoId, onSelect]);

  // Resize divider
  const handleDividerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleDividerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const parent = (e.target as HTMLElement).parentElement!;
    const rect = parent.getBoundingClientRect();
    onHeightChange(Math.max(60, Math.min(200, rect.bottom - e.clientY + 6)));
  }, [onHeightChange]);

  const handleDividerUp = useCallback(() => { dragging.current = false; }, []);

  const thumbSize = Math.max(40, height - 30);

  const activeIdx = photos.findIndex((p) => p.id === activePhotoId);

  const handlePrev = useCallback(() => {
    if (activeIdx > 0) onSelect(photos[activeIdx - 1]);
  }, [activeIdx, photos, onSelect]);

  const handleNext = useCallback(() => {
    if (activeIdx < photos.length - 1) onSelect(photos[activeIdx + 1]);
  }, [activeIdx, photos, onSelect]);

  return (
    <div className="filmstrip" style={{ height }}>
      <div className="fs-divider"
        onPointerDown={handleDividerDown}
        onPointerMove={handleDividerMove}
        onPointerUp={handleDividerUp}
      />
      <div className="fs-header">
        <button className="fs-nav-btn" onClick={handlePrev} disabled={activeIdx <= 0} title={t('uiShell.filmstrip.prev')}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 2L3 5l3 3" /></svg>
        </button>
        <button className="fs-nav-btn" onClick={handleNext} disabled={activeIdx >= photos.length - 1} title={t('uiShell.filmstrip.next')}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 2l3 3-3 3" /></svg>
        </button>
        <span className="fs-info-text">
          {activeIdx >= 0
            ? t('uiShell.filmstrip.countWithSelected', { count: photos.length, index: activeIdx + 1 })
            : t('uiShell.filmstrip.countPhotos', { count: photos.length })}
        </span>
      </div>
      <div className="fs-scroll" ref={scrollRef}>
        {photos.map((photo) => (
          <FilmstripItem
            key={photo.id}
            photo={photo}
            active={photo.id === activePhotoId}
            size={thumbSize}
            onSelect={onSelect}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  );
}

function FilmstripItem({ photo, active, size, onSelect, onOpen }: {
  photo: PhotoView; active: boolean; size: number;
  onSelect: (p: PhotoView) => void; onOpen: (p: PhotoView) => void;
}) {
  const { url } = useThumbnail(photo);
  const labelColor = photo.colorLabel ? `var(--label-${photo.colorLabel})` : undefined;

  return (
    <div
      className={`fs-item ${active ? 'active' : ''}`}
      data-photo-id={photo.id}
      style={{ borderBottomColor: labelColor }}
      onClick={() => onSelect(photo)}
      onDoubleClick={() => onOpen(photo)}
    >
      <div className="fs-thumb" style={{ width: size, height: size }}>
        {url ? <img src={url} alt="" draggable={false} /> : <div className="fs-loading" />}
      </div>
      <div className="fs-info">
        {(photo.rating ?? 0) > 0 && (
          <span className="fs-stars">{'★'.repeat(photo.rating!)}{'☆'.repeat(5 - photo.rating!)}</span>
        )}
      </div>
    </div>
  );
}
