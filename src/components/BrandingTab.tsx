import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type Brand,
  getBrandOverride,
  getDefaultBrand,
  resetBrand,
  updateBrandField,
  useBrand,
} from '../brand';
import './BrandingTab.css';

type AssetField = 'faviconPath' | 'wordmarkPath';
type AssetMode = 'default' | 'upload' | 'url';

const MAX_DATA_URL_BYTES = 1_500_000; // ~1.5 MB after base64 — sensible localStorage budget

/**
 * Branding tab — edit the active product brand at runtime.
 *
 * Persists under STORAGE_KEYS.brandOverride. Changes apply
 * immediately to every component reading via `useBrand()`, plus the document
 * head (title, favicon, theme-color) via `applyBrandToDocument()`.
 *
 * No license gate: feature tiers do not exist (dec-own-license), so the only
 * gate the product has is the build. White-label is meant to be a self-hosted
 * build feature - SettingsDialog already carries the `selfHosted` flag for
 * that, but does not yet gate this tab with it.
 */
export function BrandingTab() {
  const { t } = useTranslation();
  const brand = useBrand();
  const def = getDefaultBrand();
  const [err, setErr] = useState<string | null>(null);

  const onText = (field: keyof Brand) => (value: string) => {
    setErr(null);
    updateBrandField(field, value);
  };

  const overriddenCount = Object.keys(getBrandOverride() ?? {}).length;

  return (
    <div className="settings-section branding-tab">
      <h3>{t('branding.heading')}</h3>
      <p className="settings-hint">{t('branding.hint')}</p>

      <BrandPreview brand={brand} />

      <div className="branding-grid">
        <label className="branding-field">
          <span>{t('branding.name')}</span>
          <input
            type="text"
            value={brand.name}
            onChange={(e) => onText('name')(e.target.value)}
            placeholder={def.name}
          />
        </label>

        <label className="branding-field">
          <span>{t('branding.shortName')}</span>
          <input
            type="text"
            value={brand.shortName}
            onChange={(e) => onText('shortName')(e.target.value)}
            placeholder={def.shortName}
          />
        </label>

        <label className="branding-field branding-field-wide">
          <span>{t('branding.tagline')}</span>
          <input
            type="text"
            value={brand.tagline}
            onChange={(e) => onText('tagline')(e.target.value)}
            placeholder={def.tagline}
          />
        </label>

        <label className="branding-field">
          <span>{t('branding.themeColor')}</span>
          <div className="branding-color-row">
            <input
              type="color"
              value={brand.themeColor}
              onChange={(e) => onText('themeColor')(e.target.value)}
            />
            <input
              type="text"
              value={brand.themeColor}
              onChange={(e) => onText('themeColor')(e.target.value)}
              placeholder={def.themeColor}
            />
          </div>
        </label>

        <label className="branding-field">
          <span>{t('branding.copyright')}</span>
          <input
            type="text"
            value={brand.copyright}
            onChange={(e) => onText('copyright')(e.target.value)}
            placeholder={def.copyright}
          />
        </label>
      </div>

      <AssetPicker
        label={t('branding.faviconLabel')}
        hint={t('branding.faviconHint')}
        field="faviconPath"
        currentValue={brand.faviconPath}
        defaultValue={def.faviconPath}
        onError={setErr}
      />

      <AssetPicker
        label={t('branding.wordmarkLabel')}
        hint={t('branding.wordmarkHint')}
        field="wordmarkPath"
        currentValue={brand.wordmarkPath}
        defaultValue={def.wordmarkPath}
        onError={setErr}
      />

      {err && <div className="branding-error">{err}</div>}

      <div className="branding-actions">
        <button
          className="settings-btn-sm"
          disabled={overriddenCount === 0}
          onClick={() => {
            resetBrand();
            setErr(null);
          }}>
          {t('branding.resetDefault')}
        </button>
        <span className="settings-hint">{t('branding.overriddenCount', { count: overriddenCount })}</span>
      </div>
    </div>
  );
}

function BrandPreview({ brand }: { brand: Brand }) {
  return (
    <div className="branding-preview" style={{ borderColor: brand.themeColor }}>
      <div className="branding-preview-icon">
        {brand.faviconPath && (
          <img src={brand.faviconPath} alt="" onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }} />
        )}
      </div>
      <div className="branding-preview-text">
        {brand.wordmarkPath ? (
          <img className="branding-preview-wordmark" src={brand.wordmarkPath} alt={brand.name} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <div className="branding-preview-name">{brand.name}</div>
        )}
        <div className="branding-preview-tagline">{brand.tagline}</div>
      </div>
    </div>
  );
}

interface AssetPickerProps {
  label: string;
  hint: string;
  field: AssetField;
  currentValue: string | null;
  defaultValue: string | null;
  onError: (msg: string | null) => void;
}

function AssetPicker({ label, hint, field, currentValue, defaultValue, onError }: AssetPickerProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isOnDefault = currentValue === defaultValue;
  const isDataUrl = !!currentValue && currentValue.startsWith('data:');
  const isCustomUrl = !!currentValue && !isDataUrl && !isOnDefault;
  const initialMode: AssetMode = isOnDefault ? 'default' : isDataUrl ? 'upload' : 'url';

  const [mode, setMode] = useState<AssetMode>(initialMode);
  const [urlDraft, setUrlDraft] = useState(isCustomUrl ? currentValue : '');

  const apply = (value: string | null) => {
    onError(null);
    updateBrandField(field, value);
  };

  const handleFile = async (file: File) => {
    onError(null);
    if (file.size > MAX_DATA_URL_BYTES) {
      onError(t('branding.fileTooLarge', { kb: (file.size / 1024).toFixed(0), limitKb: MAX_DATA_URL_BYTES / 1024 }));
      return;
    }
    if (!file.type.startsWith('image/')) {
      onError(t('branding.imagesOnly'));
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      apply(dataUrl);
    } catch {
      onError(t('branding.fileReadFailed'));
    }
  };

  const handleUrlSubmit = () => {
    const trimmed = urlDraft.trim();
    if (!trimmed) {
      apply(null);
      return;
    }
    const validationErr = validateAssetUrl(trimmed, t);
    if (validationErr) {
      onError(validationErr);
      return;
    }
    apply(trimmed);
  };

  return (
    <div className="branding-asset">
      <div className="branding-asset-header">
        <strong>{label}</strong>
        <div className="branding-asset-modes">
          <button
            className={`branding-mode ${mode === 'default' ? 'active' : ''}`}
            onClick={() => { setMode('default'); apply(defaultValue); }}>
            {t('branding.modeDefault')}
          </button>
          <button
            className={`branding-mode ${mode === 'upload' ? 'active' : ''}`}
            onClick={() => setMode('upload')}>
            {t('branding.modeUpload')}
          </button>
          <button
            className={`branding-mode ${mode === 'url' ? 'active' : ''}`}
            onClick={() => setMode('url')}>
            {t('branding.modeUrl')}
          </button>
        </div>
      </div>
      <p className="settings-hint">{hint}</p>

      {mode === 'upload' && (
        <div className="branding-upload">
          <button
            className="settings-btn-sm"
            onClick={() => fileInputRef.current?.click()}>
            {t('branding.chooseFile')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/svg+xml,image/png,image/jpeg,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = '';
            }}
          />
          {isDataUrl && (
            <span className="branding-upload-info">
              {t('branding.embedded', { kb: Math.round((currentValue?.length ?? 0) / 1024) })}
            </span>
          )}
        </div>
      )}

      {mode === 'url' && (
        <div className="branding-url-row">
          <input
            type="url"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onBlur={handleUrlSubmit}
            onKeyDown={(e) => { if (e.key === 'Enter') handleUrlSubmit(); }}
            placeholder="https://example.com/logo.svg"
          />
          <button className="settings-btn-sm" onClick={handleUrlSubmit}>{t('branding.apply')}</button>
        </div>
      )}

      {currentValue && (
        <div className="branding-asset-preview">
          <img src={currentValue} alt="" onError={(e) => { (e.target as HTMLImageElement).style.opacity = '0.2'; }} />
        </div>
      )}
    </div>
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function validateAssetUrl(url: string, t: (k: string) => string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'data:') {
      return t('branding.onlyHttpsOrData');
    }
    return null;
  } catch {
    return t('branding.invalidUrl');
  }
}
