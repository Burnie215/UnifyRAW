import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './IndexingStatus.css';

interface IndexingStatusProps {
  /** Total photos in library */
  totalPhotos: number;
  /** Photos that have a cached thumbnail */
  cachedThumbs: number;
  /** Photos that have a blurHash */
  blurHashCount: number;
  /** Currently generating thumbnails */
  generating: boolean;
  /** Sidecar operation in progress */
  sidecarBusy: boolean;
  /** Scanning sources */
  scanning: boolean;
  /** Sync in progress */
  syncing?: boolean;
  /** Sync error */
  syncError?: string | null;
}

export function IndexingStatus({
  totalPhotos, cachedThumbs, blurHashCount, generating, sidecarBusy, scanning,
  syncing, syncError,
}: IndexingStatusProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);

  const isActive = scanning || generating || sidecarBusy || !!syncing;
  const thumbProgress = totalPhotos > 0 ? Math.round((cachedThumbs / totalPhotos) * 100) : 100;
  const blurProgress = totalPhotos > 0 ? Math.round((blurHashCount / totalPhotos) * 100) : 100;
  const thumbsDone = thumbProgress >= 100;
  const progress = thumbsDone ? blurProgress : thumbProgress;
  const allDone = thumbsDone && blurProgress >= 100 && !isActive;

  // Show when active, hide 3s after completion
  useEffect(() => {
    if (isActive || progress < 100) {
      setVisible(true);
      return;
    }
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [isActive, progress]);

  if (!visible && !hovered) return null;

  return (
    <div
      className={`indexing-status ${allDone ? 'done' : ''} ${hovered ? 'expanded' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Compact view */}
      {!hovered && (
        <div className="indexing-compact">
          {isActive && <div className="indexing-spinner" />}
          <span className="indexing-pct">{progress}%</span>
          {scanning && <span className="indexing-label">{t('indexing.labelScan')}</span>}
          {!scanning && !thumbsDone && generating && <span className="indexing-label">{t('indexing.labelThumbs')}</span>}
          {!scanning && thumbsDone && blurProgress < 100 && <span className="indexing-label">{t('indexing.labelBlurHash')}</span>}
          {syncing && <span className="indexing-label">{t('indexing.labelSync')}</span>}
          {syncError && <span className="indexing-label" style={{ color: 'var(--color-error, #e74c3c)' }}>!</span>}
        </div>
      )}

      {/* Expanded view on hover */}
      {hovered && (
        <div className="indexing-expanded">
          <div className="indexing-row">
            <span>{t('indexing.thumbnails')}</span>
            <span>{cachedThumbs} / {totalPhotos}</span>
          </div>
          <div className="indexing-bar">
            <div className="indexing-bar-fill" style={{ width: `${thumbProgress}%` }} />
          </div>
          {thumbsDone && blurProgress < 100 && (
            <>
              <div className="indexing-row">
                <span>{t('indexing.blurHash')}</span>
                <span>{blurHashCount} / {totalPhotos}</span>
              </div>
              <div className="indexing-bar">
                <div className="indexing-bar-fill" style={{ width: `${blurProgress}%` }} />
              </div>
            </>
          )}
          {scanning && (
            <div className="indexing-row active">
              <div className="indexing-spinner" />
              <span>{t('indexing.scanningSources')}</span>
            </div>
          )}
          {generating && (
            <div className="indexing-row active">
              <div className="indexing-spinner" />
              <span>{t('indexing.generatingThumbs')}</span>
            </div>
          )}
          {sidecarBusy && (
            <div className="indexing-row active">
              <div className="indexing-spinner" />
              <span>{t('indexing.sidecarOp')}</span>
            </div>
          )}
          {syncing && (
            <div className="indexing-row active">
              <div className="indexing-spinner" />
              <span>{t('indexing.syncing')}</span>
            </div>
          )}
          {syncError && (
            <div className="indexing-row" style={{ color: 'var(--color-error, #e74c3c)' }}>
              <span>{t('indexing.syncError')}</span>
            </div>
          )}
          {allDone && (
            <div className="indexing-row done">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 6l3 3 5-6" />
              </svg>
              <span>{t('indexing.allIndexed')}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
