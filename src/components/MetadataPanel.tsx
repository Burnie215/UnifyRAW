import { useTranslation } from 'react-i18next';
import type { ExifData } from '../hooks/useExif';
import './MetadataPanel.css';

interface MetadataPanelProps {
  exif: ExifData | null;
}

export function MetadataPanel({ exif }: MetadataPanelProps) {
  const { t, i18n } = useTranslation();
  if (!exif) return <div className="meta-loading">{t('panels.metadata.loading')}</div>;
  const dateLocale = i18n.language?.startsWith('de') ? 'de-DE' : 'en-US';

  return (
    <div className="metadata-panel">
      {/* Camera */}
      {(exif.make || exif.model) && (
        <div className="meta-section">
          {exif.make && exif.model
            ? <div className="meta-row"><span className="meta-label">{t('panels.metadata.camera')}</span><span className="meta-value">{exif.make} {exif.model}</span></div>
            : <div className="meta-row"><span className="meta-label">{t('panels.metadata.camera')}</span><span className="meta-value">{exif.make || exif.model}</span></div>
          }
          {exif.lens && <div className="meta-row"><span className="meta-label">{t('panels.metadata.lens')}</span><span className="meta-value">{exif.lens}</span></div>}
        </div>
      )}

      {/* Exposure */}
      {(exif.exposureTime || exif.fNumber || exif.iso || exif.focalLength) && (
        <div className="meta-exposure">
          {exif.exposureTime && <span>{exif.exposureTime}s</span>}
          {exif.fNumber && <span>f/{exif.fNumber}</span>}
          {exif.iso && <span>ISO {exif.iso}</span>}
          {exif.focalLength && <span>{exif.focalLength}mm</span>}
        </div>
      )}

      {/* Date */}
      {exif.dateTime && (
        <div className="meta-section">
          <div className="meta-row">
            <span className="meta-label">{t('panels.metadata.date')}</span>
            <span className="meta-value">
              {exif.dateTime.toLocaleDateString(dateLocale, { day: '2-digit', month: '2-digit', year: 'numeric' })}
              {' '}
              {exif.dateTime.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          </div>
        </div>
      )}

      {/* File info */}
      <div className="meta-exposure">
        {exif.dimensions.width > 0 && exif.dimensions.height > 0 && (
          <span>{exif.dimensions.width} × {exif.dimensions.height}</span>
        )}
        <span>{formatSize(exif.fileSize)}</span>
        <span>{exif.mimeType.split('/')[1]?.toUpperCase()}</span>
      </div>

      {/* GPS */}
      {exif.latitude != null && exif.longitude != null && (
        <div className="meta-section">
          <div className="meta-row">
            <span className="meta-label">{t('panels.metadata.gps')}</span>
            <span className="meta-value meta-link">
              <a
                href={`https://www.openstreetmap.org/?mlat=${exif.latitude}&mlon=${exif.longitude}#map=15/${exif.latitude}/${exif.longitude}`}
                target="_blank"
                rel="noopener"
              >
                {exif.latitude.toFixed(4)}°, {exif.longitude.toFixed(4)}°
              </a>
            </span>
          </div>
          {exif.altitude != null && (
            <div className="meta-row">
              <span className="meta-label">{t('panels.metadata.altitude')}</span>
              <span className="meta-value">{Math.round(exif.altitude)} m</span>
            </div>
          )}
        </div>
      )}

      {/* Keywords */}
      {exif.keywords && exif.keywords.length > 0 && (
        <div className="meta-section">
          <div className="meta-row">
            <span className="meta-label">{t('panels.metadata.keywords')}</span>
            <span className="meta-value meta-tags">
              {exif.keywords.map((kw, i) => <span key={i} className="meta-tag">{kw}</span>)}
            </span>
          </div>
        </div>
      )}

      {exif.copyright && (
        <div className="meta-section">
          <div className="meta-row"><span className="meta-label">{t('panels.metadata.copyright')}</span><span className="meta-value">{exif.copyright}</span></div>
        </div>
      )}

      {exif.description && (
        <div className="meta-section">
          <div className="meta-row"><span className="meta-label">{t('panels.metadata.description')}</span><span className="meta-value">{exif.description}</span></div>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
