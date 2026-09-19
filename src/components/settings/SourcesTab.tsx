import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PhotoLibrary,
  PhotoLibraryIntegrityReport,
  PhotoLibraryAsset,
  PhotoLibraryStats,
} from '@photolib/shared';
import type { SourceRow } from '../../storage/repos';
import { sourceTypeLabel } from '../../sources/sourcePresentation';
import { config, hasBackend } from '../../platform/config';
import {
  serverPathTargetsOwnBackend,
} from '../../sources/serverPathMigration';
import { serverPathRootPath, serverPathServerUrl } from '../../sources/serverPathMigrationAssistant';
import { ServerPathMigrationPanel } from './ServerPathMigrationPanel';
import {
  resolveSourceTransportMode,
  supportsBrowserDirectTransport,
} from '../../platform/sourceTransport';
import {
  getPhotoLibrary,
  getPhotoLibraryStats,
  updatePhotoLibrary,
  runPhotoLibraryIntegrityCheck,
  listPhotoLibraryAssets,
  purgePhotoLibraryAsset,
  restorePhotoLibraryAsset,
  importFileIntoPhotoLibrary,
} from '../../platform/libraryApi';

export interface SourcesTabProps {
  sources: SourceRow[];
  onRemoveSource: (id: string) => void;
  onRescanSource: (id: string) => void;
  onAddSource: () => void;
  scanning: boolean;
  photoCountBySource: Record<string, number>;
  getAutoRefresh?: (id: string) => boolean;
  onAutoRefreshChange?: (id: string, enabled: boolean) => void;
  autoPushMetadata?: boolean;
  onAutoPushMetadataChange?: (enabled: boolean) => void;
}

export function SourcesTab({
  sources, onRemoveSource, onRescanSource, onAddSource, scanning, photoCountBySource,
  getAutoRefresh, onAutoRefreshChange, autoPushMetadata, onAutoPushMetadataChange,
}: SourcesTabProps) {
  const { t } = useTranslation();
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [migratingSource, setMigratingSource] = useState<string | null>(null);
  const [libraryInfo, setLibraryInfo] = useState<Record<string, {
    library: PhotoLibrary;
    stats: PhotoLibraryStats;
  }>>({});
  const [updatingLibrary, setUpdatingLibrary] = useState<string | null>(null);
  const [integrityRunning, setIntegrityRunning] = useState<string | null>(null);
  const [integrityReports, setIntegrityReports] = useState<Record<string, PhotoLibraryIntegrityReport>>({});
  const [trashAssets, setTrashAssets] = useState<Record<string, PhotoLibraryAsset[]>>({});
  const [trashBusy, setTrashBusy] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [managedImport, setManagedImport] = useState<Record<string, {
    completed: number;
    total: number;
    duplicates: number;
    failed: number;
  }>>({});

  const updateScanInterval = async (sourceId: string, libraryId: string, minutes: number) => {
    setUpdatingLibrary(sourceId);
    try {
      const library = await updatePhotoLibrary(libraryId, { scanIntervalMinutes: minutes });
      setLibraryInfo((previous) => {
        const current = previous[sourceId];
        return current
          ? { ...previous, [sourceId]: { ...current, library } }
          : previous;
      });
    } finally {
      setUpdatingLibrary(null);
    }
  };

  const runIntegrityCheck = async (sourceId: string, libraryId: string) => {
    setIntegrityRunning(sourceId);
    try {
      const report = await runPhotoLibraryIntegrityCheck(libraryId);
      setIntegrityReports((previous) => ({ ...previous, [sourceId]: report }));
      const stats = await getPhotoLibraryStats(libraryId);
      setLibraryInfo((previous) => {
        const current = previous[sourceId];
        return current ? { ...previous, [sourceId]: { ...current, stats } } : previous;
      });
    } finally {
      setIntegrityRunning(null);
    }
  };

  const refreshTrash = async (sourceId: string, libraryId: string) => {
    const [page, stats] = await Promise.all([
      listPhotoLibraryAssets(libraryId, { status: 'trashed', limit: 500 }),
      getPhotoLibraryStats(libraryId),
    ]);
    setTrashAssets((previous) => ({ ...previous, [sourceId]: page.assets }));
    setLibraryInfo((previous) => {
      const current = previous[sourceId];
      return current ? { ...previous, [sourceId]: { ...current, stats } } : previous;
    });
  };

  const restoreTrashed = async (sourceId: string, libraryId: string, assetId: string) => {
    setTrashBusy(assetId);
    try {
      await restorePhotoLibraryAsset(libraryId, assetId);
      await refreshTrash(sourceId, libraryId);
    } finally {
      setTrashBusy(null);
    }
  };

  const purgeTrashed = async (sourceId: string, libraryId: string, assetId: string) => {
    if (confirmPurge !== assetId) {
      setConfirmPurge(assetId);
      return;
    }
    setTrashBusy(assetId);
    try {
      await purgePhotoLibraryAsset(libraryId, assetId);
      setConfirmPurge(null);
      await refreshTrash(sourceId, libraryId);
    } finally {
      setTrashBusy(null);
    }
  };

  const importManagedFiles = async (
    sourceId: string,
    libraryId: string,
    files: readonly File[],
  ) => {
    let completed = 0;
    let duplicates = 0;
    let failed = 0;
    setManagedImport((previous) => ({
      ...previous,
      [sourceId]: { completed, total: files.length, duplicates, failed },
    }));
    for (const file of files) {
      try {
        const result = await importFileIntoPhotoLibrary(libraryId, file);
        if (result.duplicate) duplicates++;
      } catch {
        failed++;
      }
      completed++;
      setManagedImport((previous) => ({
        ...previous,
        [sourceId]: { completed, total: files.length, duplicates, failed },
      }));
    }
    await refreshTrash(sourceId, libraryId);
    onRescanSource(sourceId);
  };

  useEffect(() => {
    let cancelled = false;
    const librarySources = sources.filter((source) => source.type === 'photolib-library');
    void Promise.all(librarySources.map(async (source) => {
      const libraryId = typeof source.config.libraryId === 'string' ? source.config.libraryId : '';
      if (!libraryId) return null;
      try {
        const [library, stats] = await Promise.all([
          getPhotoLibrary(libraryId),
          getPhotoLibraryStats(libraryId),
        ]);
        if (library.mode === 'managed') {
          const page = await listPhotoLibraryAssets(libraryId, { status: 'trashed', limit: 500 });
          if (!cancelled) {
            setTrashAssets((previous) => ({ ...previous, [source.id]: page.assets }));
          }
        }
        return [source.id, { library, stats }] as const;
      } catch {
        return null;
      }
    })).then((entries) => {
      if (cancelled) return;
      setLibraryInfo(Object.fromEntries(entries.filter((entry) => entry !== null)));
    });
    return () => { cancelled = true; };
  }, [sources, scanning]);

  /**
   * A legacy ServerPath source can be carried into a library only when its
   * files are on the backend this app talks to; one pointing at somebody
   * else's server stays a remote source.
   */
  const canMigrate = (source: SourceRow): boolean => (
    source.type === 'server-path'
    && hasBackend()
    && serverPathRootPath(source) !== ''
    && serverPathTargetsOwnBackend(
      serverPathServerUrl(source),
      config.backendUrl,
      typeof window === 'undefined' ? '' : window.location.origin,
    )
  );

  return (
    <div className="settings-section">
      <h3>{t('settings.sources.heading')}</h3>
      <p className="settings-hint">{t('settings.sources.hint')}</p>

      {onAutoPushMetadataChange && (
        <>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={autoPushMetadata === true}
              onChange={(e) => onAutoPushMetadataChange(e.target.checked)}
            />
            <span>{t('settings.sources.autoPushMetadata')}</span>
          </label>
          <p className="settings-hint">{t('settings.sources.autoPushMetadataHint')}</p>
        </>
      )}

      {sources.length === 0 ? (
        <div className="settings-empty">{t('sidebar.noSources')}</div>
      ) : (
        <div className="settings-source-list">
          {sources.map((s) => {
            const integrated = libraryInfo[s.id];
            return (
            <div key={s.id} className={`settings-source-item ${integrated ? 'settings-source-library' : ''}`}>
              <div className="settings-source-info">
                <span className="settings-source-label">{s.label}</span>
                <span className="settings-source-meta">
                  {sourceTypeLabel(s.type)} — {t('sidebar.photosCount', { count: integrated?.stats.total ?? photoCountBySource[s.id] ?? 0 })}
                  {supportsBrowserDirectTransport(s.type) && (
                    <> · {resolveSourceTransportMode(s.config.transport) === 'browser-direct'
                      ? t('sources.transportBadgeBrowser')
                      : t('sources.transportBadgeServer')}</>
                  )}
                </span>
                {integrated && (
                  <>
                    <span className="settings-source-library-mode">
                      {integrated.library.mode === 'external'
                        ? t('sources.libraryExternal')
                        : t('sources.libraryManaged')}
                      {' · '}
                      {integrated.library.readOnly
                        ? t('sources.libraryRootReadOnly')
                        : t('sources.libraryReadWrite')}
                      {' · '}{t(`sources.libraryStatus.${integrated.library.status}`)}
                    </span>
                    <span className="settings-source-library-stats">
                      <span>{t('sources.libraryStatsOnline', { count: integrated.stats.online })}</span>
                      {integrated.stats.offline > 0 && <span className="warn">{t('sources.libraryStatsOffline', { count: integrated.stats.offline })}</span>}
                      {integrated.stats.error > 0 && <span className="error">{t('sources.libraryStatsError', { count: integrated.stats.error })}</span>}
                    </span>
                    <label className="settings-source-autorefresh">
                      <span>{t('sources.libraryScanInterval')}</span>
                      <select
                        value={integrated.library.scanIntervalMinutes}
                        disabled={updatingLibrary === s.id || scanning}
                        onChange={(event) => void updateScanInterval(
                          s.id,
                          integrated.library.id,
                          Number(event.target.value),
                        )}
                      >
                        <option value={0}>{t('sources.libraryScanManual')}</option>
                        <option value={15}>{t('sources.libraryScanMinutes', { count: 15 })}</option>
                        <option value={60}>{t('sources.libraryScanHourly')}</option>
                        <option value={360}>{t('sources.libraryScanHours', { count: 6 })}</option>
                        <option value={1440}>{t('sources.libraryScanDaily')}</option>
                      </select>
                    </label>
                    {integrated.library.mode === 'managed' && (
                      <div className="settings-source-library-integrity">
                        <label className="settings-btn-sm settings-source-library-import">
                          {t('sources.libraryImportMore')}
                          <input
                            type="file"
                            multiple
                            accept="image/*,.heic,.heif,.hif,.dng,.cr2,.cr3,.nef,.nrw,.arw,.raf,.rw2,.orf,.pef,.srw,.x3f"
                            onChange={(event) => {
                              const files = Array.from(event.target.files ?? []);
                              event.target.value = '';
                              if (files.length > 0) {
                                void importManagedFiles(s.id, integrated.library.id, files);
                              }
                            }}
                          />
                        </label>
                        {managedImport[s.id] && (
                          <span>{t('sources.libraryImportResult', managedImport[s.id])}</span>
                        )}
                        <button
                          className="settings-btn-sm"
                          disabled={integrityRunning === s.id || scanning}
                          onClick={() => void runIntegrityCheck(s.id, integrated.library.id)}
                        >
                          {integrityRunning === s.id
                            ? t('sources.libraryIntegrityRunning')
                            : t('sources.libraryIntegrityRun')}
                        </button>
                        {integrityReports[s.id] && (
                          <span>
                            {t('sources.libraryIntegrityResult', {
                              valid: integrityReports[s.id].valid,
                              initialized: integrityReports[s.id].initialized,
                              problems: integrityReports[s.id].missing
                                + integrityReports[s.id].changed
                                + integrityReports[s.id].unreadable,
                            })}
                          </span>
                        )}
                      </div>
                    )}
                    {integrated.library.mode === 'managed' && (trashAssets[s.id]?.length ?? 0) > 0 && (
                      <div className="settings-source-library-trash">
                        <strong>{t('sources.libraryTrashTitle', { count: trashAssets[s.id].length })}</strong>
                        {trashAssets[s.id].map((asset) => (
                          <div key={asset.id} className="settings-source-library-trash-row">
                            <span title={asset.relativePath}>{asset.name}</span>
                            <button
                              className="settings-btn-sm"
                              disabled={trashBusy === asset.id}
                              onClick={() => void restoreTrashed(s.id, integrated.library.id, asset.id)}
                            >
                              {t('sources.libraryTrashRestore')}
                            </button>
                            <button
                              className="settings-btn-sm danger"
                              disabled={trashBusy === asset.id}
                              onClick={() => void purgeTrashed(s.id, integrated.library.id, asset.id)}
                            >
                              {confirmPurge === asset.id
                                ? t('sources.libraryTrashPurgeConfirm')
                                : t('sources.libraryTrashPurge')}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {canMigrate(s) && (
                  migratingSource === s.id ? (
                    <ServerPathMigrationPanel
                      sourceId={s.id}
                      scanning={scanning}
                      onRescanSource={onRescanSource}
                      onClose={() => setMigratingSource(null)}
                    />
                  ) : (
                    <button
                      className="settings-btn-sm settings-source-migrate"
                      onClick={() => setMigratingSource(s.id)}
                    >
                      {t('sources.migrate.open')}
                    </button>
                  )
                )}
                {s.type !== 'photolib-library' && getAutoRefresh && onAutoRefreshChange && (
                  <label className="settings-source-autorefresh">
                    <input
                      type="checkbox"
                      checked={getAutoRefresh(s.id)}
                      onChange={(e) => onAutoRefreshChange(s.id, e.target.checked)}
                    />
                    <span>{t('settings.sources.autoImport')}</span>
                  </label>
                )}
              </div>
              <div className="settings-source-actions">
                <button className="settings-btn-sm" onClick={() => onRescanSource(s.id)} disabled={scanning} title={t('settings.sources.rescan')}>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M2 6a4 4 0 1 1 1.17 2.83" /><path d="M2 9V6h3" />
                  </svg>
                </button>
                {confirmRemove === s.id ? (
                  <button className="settings-btn-sm danger" onClick={() => { onRemoveSource(s.id); setConfirmRemove(null); }} title={t('common.confirm')}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6l2 2 4-4" /></svg>
                  </button>
                ) : (
                  <button className="settings-btn-sm" onClick={() => setConfirmRemove(s.id)} title={t('common.remove')}>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3l6 6M9 3L3 9" /></svg>
                  </button>
                )}
              </div>
            </div>
          );})}
        </div>
      )}

      <button className="settings-btn-primary" onClick={onAddSource} disabled={scanning}>
        {scanning ? t('settings.sources.scanning') : `+ ${t('sidebar.addSource')}`}
      </button>
    </div>
  );
}
