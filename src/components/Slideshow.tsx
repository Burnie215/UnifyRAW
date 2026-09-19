import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../storage/repos';
import { useThumbnail } from '../hooks/useThumbnail';
import { revokeBlobUrls } from '../platform/objectUrls';
import './Slideshow.css';

interface SlideshowProps {
  photos: PhotoView[];
  startIndex?: number;
  onClose: () => void;
  getDisplayUrl?: (photo: PhotoView) => Promise<string | null>;
}

export function Slideshow({ photos, startIndex = 0, onClose, getDisplayUrl }: SlideshowProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(startIndex);
  const [playing, setPlaying] = useState(true);
  const [interval, setIntervalSec] = useState(5);
  const [fullUrl, setFullUrl] = useState<string | null>(null);
  const [showControls, setShowControls] = useState(true);
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const playTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const photo = photos[index];
  const { url: thumbUrl } = useThumbnail(photo);

  // Load full-res URL. Every slide allocates its own blob (30 MB for a local
  // RAW); without the revoke below a ten-minute show at five seconds a slide
  // pins some gigabytes until the tab is reloaded (F060).
  useEffect(() => {
    if (!getDisplayUrl || !photo) return;
    let cancelled = false;
    let shown: string | null = null;
    setFullUrl(null);
    getDisplayUrl(photo).then((url) => {
      if (cancelled) { revokeBlobUrls([url]); return; }
      shown = url;
      setFullUrl(url);
    });
    return () => {
      cancelled = true;
      revokeBlobUrls([shown]);
    };
  }, [photo, getDisplayUrl]);

  const displayUrl = fullUrl ?? thumbUrl;

  // Auto-advance
  useEffect(() => {
    if (!playing) return;
    playTimer.current = setTimeout(() => {
      setIndex((prev) => (prev + 1) % photos.length);
    }, interval * 1000);
    return () => clearTimeout(playTimer.current);
  }, [playing, interval, index, photos.length]);

  // Hide controls after 3s
  useEffect(() => {
    if (!showControls) return;
    controlsTimer.current = setTimeout(() => setShowControls(false), 3000);
    return () => clearTimeout(controlsTimer.current);
  }, [showControls]);

  const handleMouseMove = useCallback(() => setShowControls(true), []);

  const prev = useCallback(() => setIndex((i) => (i - 1 + photos.length) % photos.length), [photos.length]);
  const next = useCallback(() => setIndex((i) => (i + 1) % photos.length), [photos.length]);

  // Keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'p') setPlaying((p) => !p);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, next, prev]);

  // Fullscreen
  useEffect(() => {
    document.documentElement.requestFullscreen?.().catch(() => {});
    return () => { document.exitFullscreen?.().catch(() => {}); };
  }, []);

  return (
    <div className="slideshow" role="region" aria-label={t('slideshow.title')} onMouseMove={handleMouseMove} onClick={next}>
      {displayUrl && (
        <img src={displayUrl} alt={photo?.name} className="slideshow-img" />
      )}

      {/* Controls overlay */}
      <div className={`slideshow-controls ${showControls ? 'visible' : ''}`} onClick={(e) => e.stopPropagation()}>
        <button className="ss-btn" onClick={prev} title={t('slideshow.previous')} aria-label={t('slideshow.previous')}>◀</button>
        <button
          className="ss-btn"
          onClick={() => setPlaying((p) => !p)}
          title={playing ? t('slideshow.pause') : t('slideshow.play')}
          aria-label={playing ? t('slideshow.pause') : t('slideshow.play')}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button className="ss-btn" onClick={next} title={t('slideshow.next')} aria-label={t('slideshow.next')}>▶</button>
        <span className="ss-counter">{index + 1} / {photos.length}</span>
        <select className="ss-interval" aria-label={t('slideshow.speed')} value={interval} onChange={(e) => setIntervalSec(Number(e.target.value))}>
          <option value={2}>2s</option>
          <option value={3}>3s</option>
          <option value={5}>5s</option>
          <option value={8}>8s</option>
          <option value={10}>10s</option>
        </select>
        <span className="ss-name">{photo?.name}</span>
        <button className="ss-btn ss-close" onClick={onClose} title={t('slideshow.exit')} aria-label={t('slideshow.exit')}>✕</button>
      </div>
    </div>
  );
}
