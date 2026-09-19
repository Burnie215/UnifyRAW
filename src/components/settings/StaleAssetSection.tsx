import { useTranslation } from 'react-i18next';
import { detectedStaleAssets, clearDetectedAssets } from '../../sources/staleAssetCache';
import { removeDetectedStalePhotos } from '../../sources/staleCleanup';
import { useRepos } from '../../contexts/StorageContext';

export function StaleAssetSection({ rerender }: { rerender: () => void }) {
  const { t } = useTranslation();
  const repos = useRepos();
  const detected = detectedStaleAssets();
  const count = detected.length;

  const onRemove = () => {
    const removed = removeDetectedStalePhotos(repos.photos);
    console.log(`[settings] removed ${removed} stale photos from catalog`);
    rerender();
  };

  const onForget = () => {
    clearDetectedAssets();
    rerender();
  };

  return (
    <div style={{ marginBottom: 20, padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
      <h3 style={{ marginTop: 0 }}>{t('settings.cache.stale.title')}</h3>
      <p className="settings-hint">{t('settings.cache.stale.hint')}</p>
      <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-primary)' }}>
        {count === 0 ? t('settings.cache.stale.none') : t('settings.cache.stale.count', { count })}
      </div>
      {count > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
          <button className="settings-btn-primary" onClick={onRemove}>
            {t('settings.cache.stale.remove')}
          </button>
          <button className="settings-btn-text" onClick={onForget}>
            {t('settings.cache.stale.forget')}
          </button>
        </div>
      )}
    </div>
  );
}
