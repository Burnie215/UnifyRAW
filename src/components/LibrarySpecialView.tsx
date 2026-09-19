import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../storage/repos';
import type { LibraryViewMode } from '../types';
import { revokeBlobUrls } from '../platform/objectUrls';

/** Loupe / Compare / Survey views inside the library mode. */
export function LibrarySpecialView({ mode, photos, selectedPhoto, selectedIds, onSelect, onOpen, getDisplayUrl }: {
  mode: LibraryViewMode;
  photos: PhotoView[];
  selectedPhoto: PhotoView | null;
  selectedIds: Set<number>;
  onSelect: (photo: PhotoView, multi: boolean, shift?: boolean) => void;
  onOpen: (photo: PhotoView) => void;
  getDisplayUrl: (photo: PhotoView) => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const [urls, setUrls] = useState<Map<number, string>>(new Map());

  const displayPhotos = useMemo(() => {
    if (mode === 'loupe') {
      return selectedPhoto ? [selectedPhoto] : photos.length > 0 ? [photos[0]] : [];
    }
    if (mode === 'compare') {
      const selected = photos.filter((p) => selectedIds.has(p.id!));
      if (selected.length >= 2) return selected.slice(0, 2);
      if (selectedPhoto) return [selectedPhoto, photos.find((p) => p.id !== selectedPhoto.id) ?? selectedPhoto].slice(0, 2);
      return photos.slice(0, 2);
    }
    // survey: all selected, or first 4-6
    const selected = photos.filter((p) => selectedIds.has(p.id!));
    return selected.length > 0 ? selected.slice(0, 8) : photos.slice(0, 6);
  }, [mode, photos, selectedPhoto, selectedIds]);

  // Survey shows up to eight originals at once and the set changes with every
  // click. Each round's URLs are released when the round ends, not at the next
  // page reload (F060).
  useEffect(() => {
    let cancelled = false;
    const shown = new Map<number, string>();
    async function load() {
      for (const p of displayPhotos) {
        if (!p.id) continue;
        try {
          const url = await getDisplayUrl(p);
          if (!url) continue;
          if (cancelled) { revokeBlobUrls([url]); return; }
          shown.set(p.id, url);
        } catch { /* skip */ }
      }
      if (!cancelled) setUrls(new Map(shown));
    }
    load();
    return () => {
      cancelled = true;
      revokeBlobUrls(shown.values());
    };
  }, [displayPhotos, getDisplayUrl]);

  if (displayPhotos.length === 0) {
    return <div className="lib-special-empty">{t('app.selectAtLeastOne')}</div>;
  }

  return (
    <div className={`lib-special lib-${mode}`}>
      {displayPhotos.map((p) => (
        <div
          key={p.id}
          className={`lib-special-item ${selectedIds.has(p.id!) ? 'selected' : ''}`}
          onClick={() => onSelect(p, false)}
          onDoubleClick={() => onOpen(p)}
        >
          {urls.get(p.id!) ? (
            <img src={urls.get(p.id!)!} alt={p.name} draggable={false} />
          ) : (
            <div className="lib-special-loading" />
          )}
          <div className="lib-special-label">{p.name}</div>
        </div>
      ))}
    </div>
  );
}
