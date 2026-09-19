/* eslint-disable react-refresh/only-export-components -- Grid components intentionally share their small formatting helpers. */
import { useState, useEffect, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../../storage/repos';

export interface PhotoGroup {
  folder: string;
  photos: PhotoView[];
}

export function groupByFolder(photos: PhotoView[]): PhotoGroup[] {
  const map = new Map<string, PhotoView[]>();
  for (const p of photos) {
    const parts = p.sourcePhotoId.split('/');
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '/';
    let list = map.get(folder);
    if (!list) { list = []; map.set(folder, list); }
    list.push(p);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, photos]) => ({ folder, photos }));
}

/** Hook to track if element is currently visible (bidirectional) */
export function useIsVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: '300px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [ref]);
  return visible;
}

export function Stars({ rating }: { rating: number }) {
  return (
    <div className="stars">
      {[1, 2, 3, 4, 5].map((i) => (
        <svg key={i} width="10" height="10" viewBox="0 0 10 10" className={i <= rating ? 'star-filled' : 'star-empty'}>
          <path d="M5 0.5l1.5 3 3.5 0.5-2.5 2.5 0.5 3.5L5 8l-3 2 0.5-3.5L0 4l3.5-0.5z" />
        </svg>
      ))}
    </div>
  );
}

export function FlagIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="flag-pick">
      <path d="M2 1v8M2 1h5l-1.5 2.5L7 6H2" />
    </svg>
  );
}

export function RejectIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" className="flag-reject">
      <path d="M2 2l6 6M8 2L2 8" />
    </svg>
  );
}

export function Checkbox({ checked }: { checked: boolean }) {
  return (
    <div className={`grid-checkbox ${checked ? 'checked' : ''}`}>
      {checked && <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#fff" strokeWidth="2"><path d="M2 5l2 2 4-5" /></svg>}
    </div>
  );
}

/** Infinite scroll trigger — fires onLoadMore when scrolled into view */
export function LoadMoreTrigger({ canLoadMore, scanning, onLoadMore, count }: {
  canLoadMore: boolean; scanning: boolean; onLoadMore?: () => void; count: number;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!canLoadMore || !onLoadMore || !ref.current) return;
    const el = ref.current;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting && !scanning) onLoadMore(); },
      { rootMargin: '800px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [canLoadMore, scanning, onLoadMore]);

  return (
    <div ref={ref} className="load-more-trigger">
      {scanning ? (
        <span className="load-more-text">{t('grid.loadingPhotos', { count })}</span>
      ) : canLoadMore ? (
        <button className="load-more-btn" onClick={onLoadMore}>
          {t('grid.loadMore', { count })}
        </button>
      ) : null}
    </div>
  );
}

export function formatDate(ts?: number | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatSize(bytes?: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
