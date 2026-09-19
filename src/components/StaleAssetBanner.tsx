import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { onStaleDetected } from '../sources/staleAssetCache';
import { removeDetectedStalePhotos } from '../sources/staleCleanup';
import { useRepos } from '../contexts/StorageContext';
import './StaleAssetBanner.css';

/**
 * One-shot popup that surfaces the first stale-asset detection of a session.
 *
 * When a source returns 400/404 for an asset that's still listed in our
 * catalog (typical case: photo deleted in Immich but still in PhotoLib),
 * staleAssetCache fires an event. The first event triggers the popup.
 *
 * The user can confirm "Aufräumen" (bulk-delete every detected stale photo
 * from the catalog) or "Später" (dismiss the banner for the rest of the
 * session — won't reappear until reload).
 *
 * After a removal cycle the detected-assets set is cleared; if NEW stale
 * assets pop up later (e.g. during further browsing) the popup will
 * reappear once.
 */
export function StaleAssetBanner() {
  const { t } = useTranslation();
  const repos = useRepos();
  const [visible, setVisible] = useState(false);
  const [count, setCount] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    const off = onStaleDetected((_sourceId, _sourcePhotoId, total) => {
      setCount(total);
      setVisible(true);
    });
    return off;
  }, [dismissed]);

  if (!visible) return null;

  const onRemove = async () => {
    setRemoving(true);
    try {
      const removed = removeDetectedStalePhotos(repos.photos);
      console.log(`[StaleAssetBanner] removed ${removed} stale photos from catalog`);
    } finally {
      setRemoving(false);
      setVisible(false);
      setDismissed(true);
    }
  };

  const onLater = () => {
    setVisible(false);
    setDismissed(true);
  };

  return (
    <div className="stale-banner">
      <div className="stale-banner-body">
        <div className="stale-banner-title">
          {t('stale.title', { count })}
        </div>
        <div className="stale-banner-text">
          {t('stale.body')}
        </div>
      </div>
      <div className="stale-banner-actions">
        <button className="stale-banner-btn-primary" onClick={onRemove} disabled={removing}>
          {removing ? t('stale.removing') : t('stale.cleanup', { count })}
        </button>
        <button className="stale-banner-btn-secondary" onClick={onLater} disabled={removing}>
          {t('stale.later')}
        </button>
      </div>
    </div>
  );
}

