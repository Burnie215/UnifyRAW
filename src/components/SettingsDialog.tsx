import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SourceRow } from '../storage/repos';
import type { GridFlow, HistogramStyle } from '../types';
import type { ImportPreset } from '../hooks/useImportPreset';
import { LICENSING_ENABLED, type LicenseStatus } from '../engine/License';
import type { UiPreferences } from '../hooks/useUiPreferences';
import { StorageTab } from './StorageTab';
import { BrandingTab } from './BrandingTab';
import { SourcesTab } from './settings/SourcesTab';
import { AppearanceTab } from './settings/AppearanceTab';
import { ImportTab } from './settings/ImportTab';
import { EditorTab } from './settings/EditorTab';
import { CacheTab } from './settings/CacheTab';
import { LicenseTab } from './settings/LicenseTab';
import { RawDevelopmentTab } from './settings/RawDevelopmentTab';
import './SettingsDialog.css';

// Re-export for back-compat — consumers (useSidecarManager) import this type from here.
export type { SidecarSourceInfo } from './settings/CacheTab';

interface SettingsDialogProps {
  open: boolean;
  focusSources?: boolean;
  onClose: () => void;
  // Sources
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
  // Appearance
  gridFlow: GridFlow;
  onGridFlowChange: (flow: GridFlow) => void;
  histogramStyle: HistogramStyle;
  onHistogramStyleChange: (style: HistogramStyle) => void;
  uiPrefs: UiPreferences;
  onUiPrefsChange: (patch: Partial<UiPreferences>) => void;
  onUiPrefsReset: () => void;
  // Import Preset
  importPreset?: ImportPreset;
  onImportPresetChange?: (update: Partial<ImportPreset>) => void;
  onImportPresetReset?: () => void;
  presetNames?: string[];
  // Sidecar
  sidecarSources?: import('./settings/CacheTab').SidecarSourceInfo[];
  onRegenerateSidecarThumbs?: (sourceId?: string) => Promise<void>;
  onDeleteSidecarThumbs?: (sourceId?: string) => Promise<void>;
  sidecarBusy?: boolean;
  hasNativeFSSidecar?: boolean;
  // RAW development
  rawDevSelected?: import('../storage/repos').PhotoView[];
  rawDevProfiles?: import('../storage/repos').DevelopProfileRow[];
  rawDevLensProfiles?: import('../storage/repos').LensProfileRow[];
  onDeleteRawDevProfile?: (id: number) => void;
  onDeleteLensProfile?: (id: number) => void;
  rawDevBench?: React.ReactNode;
  // License
  licenseStatus?: LicenseStatus;
  onActivateLicense?: (key: string) => Promise<LicenseStatus>;
  onDeactivateLicense?: () => void;
  selfHosted?: boolean;
}

type TopTab = 'sources' | 'appearance' | 'data' | 'rawdev' | 'license';
type SourcesSub = 'sources' | 'import';
type AppearanceSub = 'look' | 'branding';
type DataSub = 'editor' | 'storage' | 'cache';

export function SettingsDialog(props: SettingsDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TopTab>('sources');
  const [sourcesSub, setSourcesSub] = useState<SourcesSub>('sources');
  const [appearanceSub, setAppearanceSub] = useState<AppearanceSub>('look');
  const [dataSub, setDataSub] = useState<DataSub>('editor');
  const [, forceUpdate] = useState(0);
  const rerender = () => forceUpdate((n) => n + 1);

  const { open, focusSources, onClose, selfHosted, licenseStatus } = props;
  useEffect(() => {
    if (!open || !focusSources) return;
    setTab('sources');
    setSourcesSub('sources');
  }, [open, focusSources]);

  if (!open) return null;

  const hasImport = !!(props.importPreset && props.onImportPresetChange);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('settings.title')}</h2>
          <button className="settings-close" onClick={onClose}>×</button>
        </div>
        <div className="settings-layout">
          <div className="settings-sidebar">
            <button
              className={`settings-tab ${tab === 'sources' ? 'active' : ''}`}
              data-testid="settings-tab-sources"
              onClick={() => setTab('sources')}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                <rect x="2" y="2" width="10" height="3" rx="1" /><rect x="2" y="7" width="10" height="3" rx="1" /><circle cx="5" cy="3.5" r="0.8" fill="currentColor" /><circle cx="9" cy="8.5" r="0.8" fill="currentColor" />
              </svg>
              {t('settings.tabs.sourcesImport')}
            </button>
            <button
              className={`settings-tab ${tab === 'appearance' ? 'active' : ''}`}
              data-testid="settings-tab-appearance"
              onClick={() => setTab('appearance')}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                <circle cx="7" cy="7" r="5" /><path d="M7 2a5 5 0 010 10" fill="currentColor" opacity="0.2" />
              </svg>
              {t('settings.tabs.appearance')}
            </button>
            <button
              className={`settings-tab ${tab === 'data' ? 'active' : ''}`}
              data-testid="settings-tab-data"
              onClick={() => setTab('data')}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                <path d="M2 9l5-5 3 3-5 5H2z" /><path d="M8 4l2-2 2 2-2 2" />
              </svg>
              {t('settings.tabs.editorData')}
            </button>
            {props.rawDevBench && (
              <button
                className={`settings-tab ${tab === 'rawdev' ? 'active' : ''}`}
                data-testid="settings-tab-rawdev"
                onClick={() => setTab('rawdev')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <rect x="2" y="3" width="10" height="8" rx="1" /><circle cx="7" cy="7" r="2.2" />
                  <path d="M2 5h2" />
                </svg>
                {t('settings.tabs.rawDevelopment')}
              </button>
            )}
            {selfHosted && LICENSING_ENABLED && (
              <button
                className={`settings-tab ${tab === 'license' ? 'active' : ''}`}
                data-testid="settings-tab-license"
                onClick={() => setTab('license')}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <rect x="2" y="4" width="10" height="7" rx="1" /><path d="M5 4V3a2 2 0 014 0v1" /><circle cx="7" cy="8" r="1" />
                </svg>
                {t('settings.tabs.license')}
                {licenseStatus?.valid && <span className="settings-tab-dot valid" />}
                {licenseStatus && !licenseStatus.valid && selfHosted && <span className="settings-tab-dot invalid" />}
              </button>
            )}
          </div>
          <div className="settings-content">
            {tab === 'sources' && (
              <>
                {hasImport && (
                  <div className="settings-subnav">
                    <button
                      className={`settings-subnav-btn ${sourcesSub === 'sources' ? 'active' : ''}`}
                      data-testid="settings-sub-sources"
                      onClick={() => setSourcesSub('sources')}
                    >{t('settings.tabs.sources')}</button>
                    <button
                      className={`settings-subnav-btn ${sourcesSub === 'import' ? 'active' : ''}`}
                      data-testid="settings-sub-import"
                      onClick={() => setSourcesSub('import')}
                    >{t('settings.sub.importPreset')}</button>
                  </div>
                )}
                {sourcesSub === 'sources' && (
                  <SourcesTab
                    sources={props.sources}
                    onRemoveSource={props.onRemoveSource}
                    onRescanSource={props.onRescanSource}
                    onAddSource={props.onAddSource}
                    scanning={props.scanning}
                    photoCountBySource={props.photoCountBySource}
                    getAutoRefresh={props.getAutoRefresh}
                    onAutoRefreshChange={props.onAutoRefreshChange}
                    autoPushMetadata={props.autoPushMetadata}
                    onAutoPushMetadataChange={props.onAutoPushMetadataChange}
                  />
                )}
                {sourcesSub === 'import' && hasImport && (
                  <ImportTab
                    importPreset={props.importPreset!}
                    onImportPresetChange={props.onImportPresetChange!}
                    onImportPresetReset={props.onImportPresetReset}
                    presetNames={props.presetNames}
                  />
                )}
              </>
            )}
            {tab === 'appearance' && (
              <>
                <div className="settings-subnav">
                  <button
                    className={`settings-subnav-btn ${appearanceSub === 'look' ? 'active' : ''}`}
                    data-testid="settings-sub-look"
                    onClick={() => setAppearanceSub('look')}
                  >{t('settings.sub.look')}</button>
                  <button
                    className={`settings-subnav-btn ${appearanceSub === 'branding' ? 'active' : ''}`}
                    data-testid="settings-sub-branding"
                    onClick={() => setAppearanceSub('branding')}
                  >{t('settings.sub.branding')}</button>
                </div>
                {appearanceSub === 'look' && (
                  <AppearanceTab
                    gridFlow={props.gridFlow}
                    onGridFlowChange={props.onGridFlowChange}
                    histogramStyle={props.histogramStyle}
                    onHistogramStyleChange={props.onHistogramStyleChange}
                    uiPrefs={props.uiPrefs}
                    onUiPrefsChange={props.onUiPrefsChange}
                    onUiPrefsReset={props.onUiPrefsReset}
                  />
                )}
                {appearanceSub === 'branding' && <BrandingTab />}
              </>
            )}
            {tab === 'data' && (
              <>
                <div className="settings-subnav">
                  <button
                    className={`settings-subnav-btn ${dataSub === 'editor' ? 'active' : ''}`}
                    data-testid="settings-sub-editor"
                    onClick={() => setDataSub('editor')}
                  >{t('settings.sub.editor')}</button>
                  <button
                    className={`settings-subnav-btn ${dataSub === 'storage' ? 'active' : ''}`}
                    data-testid="settings-sub-storage"
                    onClick={() => setDataSub('storage')}
                  >{t('settings.tabs.storage')}</button>
                  <button
                    className={`settings-subnav-btn ${dataSub === 'cache' ? 'active' : ''}`}
                    data-testid="settings-sub-cache"
                    onClick={() => setDataSub('cache')}
                  >{t('settings.sub.cacheSidecar')}</button>
                </div>
                {dataSub === 'editor' && <EditorTab rerender={rerender} />}
                {dataSub === 'storage' && <StorageTab />}
                {dataSub === 'cache' && (
                  <CacheTab
                    sidecarSources={props.sidecarSources}
                    onRegenerateSidecarThumbs={props.onRegenerateSidecarThumbs}
                    onDeleteSidecarThumbs={props.onDeleteSidecarThumbs}
                    sidecarBusy={props.sidecarBusy}
                    hasNativeFSSidecar={props.hasNativeFSSidecar}
                    rerender={rerender}
                  />
                )}
              </>
            )}
            {tab === 'rawdev' && props.rawDevBench && (
              <RawDevelopmentTab
                selected={props.rawDevSelected ?? []}
                profiles={props.rawDevProfiles ?? []}
                lensProfiles={props.rawDevLensProfiles ?? []}
                onDeleteProfile={props.onDeleteRawDevProfile ?? (() => {})}
                onDeleteLensProfile={props.onDeleteLensProfile ?? (() => {})}
                bench={props.rawDevBench}
              />
            )}
            {tab === 'license' && selfHosted && LICENSING_ENABLED && (
              <LicenseTab
                licenseStatus={licenseStatus}
                onActivateLicense={props.onActivateLicense}
                onDeactivateLicense={props.onDeactivateLicense}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
