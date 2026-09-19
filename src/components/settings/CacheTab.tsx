import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { thumbMemCache } from '../../cache/ThumbMemCache';
import { gridBufferRows, setGridBufferRows } from '../../config/gridConfig';
import { StaleAssetSection } from './StaleAssetSection';
import { normalizeNumberInput, type NumberInputRange } from './numberInput';

export interface SidecarSourceInfo {
  sourceId: string;
  label: string;
  thumbCount: number;
  thumbSizeKB: number;
  editCount: number;
  editSizeKB: number;
  paths: string[];
}

export interface CacheTabProps {
  sidecarSources?: SidecarSourceInfo[];
  onRegenerateSidecarThumbs?: (sourceId?: string) => Promise<void>;
  onDeleteSidecarThumbs?: (sourceId?: string) => Promise<void>;
  sidecarBusy?: boolean;
  hasNativeFSSidecar?: boolean;
  rerender: () => void;
}

export function CacheTab({
  sidecarSources, onRegenerateSidecarThumbs, onDeleteSidecarThumbs,
  sidecarBusy, hasNativeFSSidecar, rerender,
}: CacheTabProps) {
  const { t } = useTranslation();
  const [selectedSidecarSource, setSelectedSidecarSource] = useState<string | null>(null);
  const allSources = sidecarSources ?? [];
  const totalThumbs = allSources.reduce((s, x) => s + x.thumbCount, 0);
  const totalEdits = allSources.reduce((s, x) => s + x.editCount, 0);
  const selected = selectedSidecarSource ? allSources.find((s) => s.sourceId === selectedSidecarSource) : null;

  return (
    <div className="settings-section">
      <StaleAssetSection rerender={rerender} />
      <h3>{t('settings.cache.heading')}</h3>

      {/* ── Virtual Grid ── */}
      <div className="storage-row">
        <div className="storage-row-info">
          <span className="storage-row-label">{t('settings.cache.gridBuffer')}</span>
          <span className="storage-row-hint">{t('settings.cache.gridBufferHint')}</span>
        </div>
        <SettingsNumberInput
          value={gridBufferRows}
          range={{ min: 1, max: 20, fallback: 3 }}
          width={56}
          onCommit={(n) => { setGridBufferRows(n); rerender(); }}
        />
      </div>

      {/* ── Memory Cache ── */}
      <div className="storage-row">
        <div className="storage-row-info">
          <label className="settings-toggle" style={{ marginBottom: 0 }}>
            <input type="checkbox" checked={thumbMemCache.enabled}
              onChange={(e) => { thumbMemCache.setEnabled(e.target.checked); rerender(); }} />
            <span>{t('settings.cache.memoryCache')}</span>
          </label>
          <span className="storage-row-hint">
            {thumbMemCache.enabled
              ? t('settings.cache.entries', { size: thumbMemCache.size, max: thumbMemCache.max, mb: thumbMemCache.sizeMB })
              : t('settings.cache.disabled')}
          </span>
        </div>
        {thumbMemCache.enabled && (
          <div className="storage-row-controls">
            <SettingsNumberInput
              value={thumbMemCache.max}
              range={{ min: 50, max: 2000, fallback: 200 }}
              step={50}
              width={64}
              onCommit={(n) => { thumbMemCache.setMax(n); rerender(); }}
            />
            <button className="settings-btn-sm" onClick={() => thumbMemCache.clear()} title={t('settings.cache.clear')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3l6 6M9 3L3 9" /></svg>
            </button>
          </div>
        )}
      </div>

      {/* ── Sidecar (index.json + thumbs/) ── */}
      <div className="storage-block" style={{ marginTop: 16 }}>
        <div className="storage-row" style={{ borderBottom: 'none', padding: 0, marginBottom: 6 }}>
          <div className="storage-row-info">
            <h4 style={{ margin: 0, fontSize: 12 }}>{t('settings.cache.sidecarHeading')}</h4>
            <span className="storage-row-hint">{t('settings.cache.sidecarSummary', {
              thumbs: totalThumbs,
              edits: totalEdits,
              size: (() => {
                const kb = allSources.reduce((s, x) => s + x.thumbSizeKB, 0);
                return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
              })(),
            })}</span>
          </div>
          {allSources.length > 0 && (
            <select className="settings-select" value={selectedSidecarSource ?? ''} onChange={(e) => setSelectedSidecarSource(e.target.value || null)} style={{ width: 'auto' }}>
              <option value="">{t('common.all')}</option>
              {allSources.map((s) => (
                <option key={s.sourceId} value={s.sourceId}>{s.label}</option>
              ))}
            </select>
          )}
        </div>
        <div className="storage-actions">
          <button className="settings-btn-primary" onClick={() => onRegenerateSidecarThumbs?.(selectedSidecarSource ?? undefined)} disabled={sidecarBusy}>
            {sidecarBusy
              ? t('settings.cache.generating')
              : selected ? t('settings.cache.regenerateFor', { label: selected.label }) : t('settings.cache.regenerate')}
          </button>
          <button className="settings-btn-sm danger" onClick={() => onDeleteSidecarThumbs?.(selectedSidecarSource ?? undefined)} disabled={sidecarBusy}>
            {selected ? t('settings.cache.deleteDataFor', { label: selected.label }) : t('settings.cache.deleteData')}
          </button>
        </div>

        {!hasNativeFSSidecar && (
          <p className="settings-hint" style={{ marginTop: 12, marginBottom: 0, fontSize: 10, color: 'var(--color-warning, #f39c12)' }}>
            {t('settings.cache.noFsAccessHint')}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Both numbers behind these fields live outside React (a module variable and
 * the cache singleton), so nothing re-renders while they are typed. The draft
 * therefore stays in local state until blur or Enter; `onCommit` stores the
 * normalized value and asks the dialog to re-read it.
 */
function SettingsNumberInput({ value, range, step, width, onCommit }: {
  value: number;
  range: NumberInputRange;
  step?: number;
  width: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  // Follow the stored value whenever it changes elsewhere (reset, reopen).
  useEffect(() => { setDraft(String(value)); }, [value]);

  const commit = () => {
    const next = normalizeNumberInput(draft, range);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="number"
      className="settings-input"
      min={range.min}
      max={range.max}
      step={step ?? 1}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
      style={{ width }}
    />
  );
}
