import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../storage/repos';
import './MapView.css';

interface MapViewProps {
  photos: PhotoView[];
  onSelectPhoto: (photo: PhotoView) => void;
}

/**
 * Coordinates only, deliberately without a map. The embedded
 * openstreetmap.org frame this view used to render handed the visitor's IP
 * address and the bounding box of every geotagged photo to a third party,
 * which both privacy texts rule out. No route reaches this component until
 * feat-map-alternative settles on a tile source that keeps that data here.
 */
export function MapView({ photos, onSelectPhoto }: MapViewProps) {
  const { t } = useTranslation();
  const geoPhotos = useMemo(() => {
    return photos.filter((p) => p.latitude != null && p.longitude != null);
  }, [photos]);

  if (geoPhotos.length === 0) {
    return (
      <div className="map-view-empty">
        <div className="map-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M24 4C18 4 13 9 13 16c0 11 11 28 11 28s11-17 11-28C35 9 30 4 24 4z" />
            <circle cx="24" cy="16" r="5" />
          </svg>
        </div>
        <h3>{t('map.title')}</h3>
        <p>{t('map.noGpsTitle')}</p>
        <p className="map-hint">{t('map.noGpsHint')}</p>
      </div>
    );
  }

  return (
    <div className="map-view">
      <div className="map-header">
        <span>{t('map.photosWithGps', { count: geoPhotos.length })}</span>
      </div>
      <div className="map-photo-list">
        {geoPhotos.map((p) => (
          <button key={p.id} className="map-photo-entry" onClick={() => onSelectPhoto(p)}>
            <span className="map-photo-name">{p.name}</span>
            <span className="map-coords">{p.latitude!.toFixed(4)}°, {p.longitude!.toFixed(4)}°</span>
          </button>
        ))}
      </div>
    </div>
  );
}
