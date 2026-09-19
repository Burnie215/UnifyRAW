import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStorage } from '../contexts/StorageContext';
import { downloadCatalog } from '../storage/downloadCatalog';
import './CatalogReadOnlyBanner.css';

/**
 * Tells the user when changes are not reaching the disk, in two cases.
 *
 * Read-only: another tab holds the catalog and this one only reads it. Once
 * the holder lets go the text says so; the reload then takes the catalog over.
 *
 * Write failed: a flush or thumbnail write threw. The flush retries on its
 * own and the banner goes away with the first write that lands; meanwhile the
 * user can retry by hand (which also asks a picked folder for its permission
 * again) or take a snapshot of the catalog out of the tab.
 *
 * Neither is dismissible on purpose: a banner one can close would trade silent
 * loss for silent loss.
 */
export function CatalogReadOnlyBanner() {
  const { t } = useTranslation();
  const { storage, readOnly, catalogLockFree, flushError, retryFlush } = useStorage();
  const [retrying, setRetrying] = useState(false);

  if (readOnly) {
    return (
      <div className={`catalog-readonly-banner${catalogLockFree ? ' free' : ''}`} role="alert">
        <div className="catalog-readonly-banner-text">
          {catalogLockFree ? t('storage.lockFree') : t('storage.readOnlyLocked')}
        </div>
        <button className="catalog-readonly-banner-btn" onClick={() => location.reload()}>
          {t('storage.reload')}
        </button>
      </div>
    );
  }

  if (!flushError || !storage) return null;

  const onRetry = async () => {
    setRetrying(true);
    try {
      await retryFlush();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="catalog-readonly-banner error" role="alert">
      <div className="catalog-readonly-banner-text" title={flushError.message}>
        {t('storage.flushFailed', { name: flushError.name })}
      </div>
      <button className="catalog-readonly-banner-btn" onClick={() => void onRetry()} disabled={retrying}>
        {t('storage.retryFlush')}
      </button>
      <button className="catalog-readonly-banner-btn secondary" onClick={() => downloadCatalog(storage)}>
        {t('storage.downloadCatalog')}
      </button>
    </div>
  );
}
