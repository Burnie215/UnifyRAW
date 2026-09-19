import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  allStrategies, getRawDecodeMode, setRawDecodeMode, type RawDecodeMode,
  getSmartPreviewSize, setSmartPreviewSize, SMART_PREVIEW_SIZES, type SmartPreviewSize,
  prefetchManager, getCacheStats, clearAllSmartPreviews,
  isLocalRawSourceType,
} from '../../engine/raw';
import {
  OUTPUT_COLOR_SPACES, getOutputColorSpace, setOutputColorSpace, type OutputColorSpaceId,
} from '../../engine/outputColorSpaces';
import {
  listIccProfiles, addIccProfile, deleteIccProfile, type IccProfileInfo,
} from '../../engine/iccStorage';
import { RawDecoder } from '../../engine/RawDecoder';
import { getHeifMode, setHeifMode, type HeifMode } from '../../engine/HeifDecoder';
import { sourceManager } from '../../sources';
import { useRepos } from '../../contexts/StorageContext';
import { makeRawCacheKey } from '../../engine/raw/cacheKey';

export function EditorTab({ rerender }: { rerender: () => void }) {
  const { t } = useTranslation();
  const current = getRawDecodeMode();
  const strategies = allStrategies();
  const selected = strategies.find((s) => s.id === current) ?? strategies[0];
  const currentSize = getSmartPreviewSize();
  const repos = useRepos();
  const [bulkState, setBulkState] = useState<{ done: number; total: number; running: boolean }>({ done: 0, total: 0, running: false });
  const bulkCtrlRef = useRef<AbortController | null>(null);
  const [cacheStats, setCacheStats] = useState<{ files: number; bytes: number } | null>(null);
  const [iccProfiles, setIccProfiles] = useState<IccProfileInfo[]>([]);
  const [iccUploadError, setIccUploadError] = useState<string | null>(null);
  const iccInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getCacheStats().then((s) => { if (!cancelled) setCacheStats(s); });
    listIccProfiles().then((p) => { if (!cancelled) setIccProfiles(p); });
    return () => { cancelled = true; };
  }, []);

  const refreshIcc = async () => {
    setIccProfiles(await listIccProfiles());
  };

  const onIccUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setIccUploadError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await addIccProfile(file);
      await refreshIcc();
    } catch (err) {
      setIccUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (iccInputRef.current) iccInputRef.current.value = '';
    }
  };

  const onIccDelete = async (id: string) => {
    await deleteIccProfile(id);
    await refreshIcc();
  };

  const refreshStats = async () => {
    const s = await getCacheStats();
    setCacheStats(s);
  };

  const onClearCache = async () => {
    const { removed, bytes } = await clearAllSmartPreviews();
    console.log(`[settings] cleared ${removed} smart preview files (${Math.round(bytes / 1024 / 1024)} MB)`);
    await refreshStats();
  };

  const onChange = (mode: RawDecodeMode) => {
    setRawDecodeMode(mode);
    rerender();
  };

  const onSizeChange = (size: SmartPreviewSize) => {
    setSmartPreviewSize(size);
    rerender();
  };

  const currentHeifMode = getHeifMode();
  const onHeifModeChange = (mode: HeifMode) => {
    setHeifMode(mode);
    rerender();
  };

  const currentOcs = getOutputColorSpace();
  const onOcsChange = (id: OutputColorSpaceId) => {
    setOutputColorSpace(id);
    rerender();
  };

  const startBulk = async () => {
    const photos = repos.photos.list();
    // Local browser-owned files are deliberately excluded: they are decoded
    // with libraw-wasm and must never be uploaded by Smart Preview prefetch.
    const rawPhotos = photos.filter((p) => {
      if (!RawDecoder.isRawFile(p.name)) return false;
      return !isLocalRawSourceType(sourceManager.get(p.sourceId)?.type);
    });
    if (rawPhotos.length === 0) {
      setBulkState({ done: 0, total: 0, running: false });
      return;
    }
    const controller = new AbortController();
    bulkCtrlRef.current = controller;
    setBulkState({ done: 0, total: rawPhotos.length, running: true });

    const items = rawPhotos.map((p) => ({
      cacheKey: makeRawCacheKey(p),
      sourceType: sourceManager.get(p.sourceId)?.type,
      getFile: async (signal?: AbortSignal) => {
        const src = sourceManager.get(p.sourceId);
        if (!src) return null;
        return src.getFile(
          { sourcePhotoId: p.sourcePhotoId, sourceId: p.sourceId, name: p.name },
          signal,
        ).catch(() => null);
      },
    }));

    try {
      await prefetchManager.bulk(items, {
        size: getSmartPreviewSize(),
        signal: controller.signal,
        onProgress: (done, total) => setBulkState({ done, total, running: true }),
      });
    } finally {
      setBulkState((s) => ({ ...s, running: false }));
      bulkCtrlRef.current = null;
    }
  };

  const stopBulk = () => {
    bulkCtrlRef.current?.abort();
  };

  return (
    <div className="settings-section">
      <h3>{t('settings.editor.rawDecoder')}</h3>
      <p className="settings-hint">{t('settings.editor.rawDecoderHint')}</p>

      <div className="settings-import-grid">
        <div className="settings-field">
          <label className="settings-field-label">{t('settings.editor.engine')}</label>
          <select className="settings-select" value={current}
            onChange={(e) => onChange(e.target.value as RawDecodeMode)}>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>{s.displayName}</option>
            ))}
          </select>
        </div>
        <p className="settings-hint" style={{ marginTop: 4 }}>
          {selected.description}
        </p>

        <div className="settings-field" style={{ marginTop: 16 }}>
          <label className="settings-field-label">{t('settings.editor.smartPreviewSize')}</label>
          <select className="settings-select" value={currentSize}
            onChange={(e) => onSizeChange(Number(e.target.value) as SmartPreviewSize)}>
            {SMART_PREVIEW_SIZES.map((s) => (
              <option key={s} value={s}>
                {s === 1200
                  ? t('settings.editor.smartPreviewSizes.standard', { size: s })
                  : s === 1800
                    ? t('settings.editor.smartPreviewSizes.medium', { size: s })
                    : t('settings.editor.smartPreviewSizes.large', { size: s })}
              </option>
            ))}
          </select>
        </div>
        <p className="settings-hint" style={{ marginTop: 4 }}>{t('settings.editor.smartPreviewHint')}</p>

        <div className="settings-field" style={{ marginTop: 16 }}>
          <label className="settings-field-label">{t('settings.editor.heif')}</label>
          <select className="settings-select" value={currentHeifMode}
            onChange={(e) => onHeifModeChange(e.target.value as HeifMode)}>
            <option value="jpeg">{t('settings.editor.heifModes.jpeg')}</option>
            <option value="lossless">{t('settings.editor.heifModes.lossless')}</option>
            <option value="linear16">{t('settings.editor.heifModes.linear16')}</option>
          </select>
        </div>
        <p className="settings-hint" style={{ marginTop: 4 }}>{t('settings.editor.heifHint')}</p>

        <div className="settings-field" style={{ marginTop: 16 }}>
          <label className="settings-field-label">{t('settings.editor.outputColorSpace')}</label>
          <select className="settings-select" value={currentOcs}
            onChange={(e) => onOcsChange(e.target.value as OutputColorSpaceId)}>
            {(Object.values(OUTPUT_COLOR_SPACES)).map((ocs) => (
              <option key={ocs.id} value={ocs.id}>{ocs.displayName}{ocs.free ? '' : ' (Pro)'}</option>
            ))}
          </select>
        </div>
        <p className="settings-hint" style={{ marginTop: 4 }}>
          {OUTPUT_COLOR_SPACES[currentOcs].description}
        </p>

        <div className="settings-field" style={{ marginTop: 16 }}>
          <label className="settings-field-label">{t('settings.editor.pregenerate')}</label>
          {!bulkState.running ? (
            <button className="settings-btn-text" onClick={startBulk}>
              {t('settings.editor.pregenerateStart')}
            </button>
          ) : (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {t('settings.editor.pregenerateProgress', { done: bulkState.done, total: bulkState.total })}
              </div>
              <button className="settings-btn-text" onClick={stopBulk} style={{ marginTop: 4 }}>
                {t('common.cancel')}
              </button>
            </>
          )}
        </div>
        <p className="settings-hint" style={{ marginTop: 4 }}>{t('settings.editor.pregenerateHint')}</p>

        <div className="settings-field" style={{ marginTop: 16 }}>
          <label className="settings-field-label">{t('settings.editor.rawCache')}</label>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {cacheStats === null
              ? t('settings.editor.rawCacheComputing')
              : cacheStats.files === 0
                ? t('settings.editor.rawCacheEmpty')
                : t('settings.editor.rawCacheFiles', {
                  count: cacheStats.files,
                  mb: (cacheStats.bytes / 1024 / 1024).toFixed(1),
                })}
          </div>
          {cacheStats !== null && cacheStats.files > 0 && (
            <button className="settings-btn-text" onClick={onClearCache} style={{ marginTop: 4 }}>
              {t('settings.clearCache')}
            </button>
          )}
        </div>
        <p className="settings-hint" style={{ marginTop: 4 }}>{t('settings.editor.rawCacheHint')}</p>

        <div className="settings-field" style={{ marginTop: 16 }}>
          <label className="settings-field-label">{t('settings.editor.icc')}</label>
          <p className="settings-hint" style={{ marginTop: 4 }}>
            {t('settings.editor.iccHint', { used: iccProfiles.length })}
          </p>
          <input ref={iccInputRef} type="file" accept=".icc,.icm" onChange={onIccUpload} style={{ marginTop: 4 }} />
          {iccUploadError && (
            <div style={{ fontSize: 11, color: 'var(--danger, #e74c3c)', marginTop: 4 }}>{iccUploadError}</div>
          )}
          {iccProfiles.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {iccProfiles.map((p) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1, fontSize: 12 }}>
                    <div style={{ color: 'var(--text-primary)' }}>{p.description || p.fileName}</div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                      {p.deviceClass ?? '?'} · {p.colorSpace ?? '?'} → {p.connectionSpace ?? '?'} · v{p.version ?? '?'} · {Math.round(p.byteSize / 1024)} KB
                    </div>
                  </div>
                  <button className="settings-btn-text" onClick={() => onIccDelete(p.id)} title={t('common.delete')}>×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
