import { useState, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CompactSlider as Slider } from '../ui/CompactSlider';
import './SkyReplacementPanel.css';

interface SkyReplacementPanelProps {
  skyBlob: Blob | null;
  skyOpacity: number;
  skyEdgeFeather: number;
  skyHorizonOffset: number;
  skyFlip: boolean;
  onSkyBlobChange: (blob: Blob | null) => void;
  onSkyOpacityChange: (v: number) => void;
  onSkyEdgeFeatherChange: (v: number) => void;
  onSkyHorizonOffsetChange: (v: number) => void;
  onSkyFlipChange: (v: boolean) => void;
  /** Trigger AI sky detection to create a mask */
  onDetectSky?: () => void;
  aiLoading?: boolean;
}

export function SkyReplacementPanel({
  skyBlob, skyOpacity, skyEdgeFeather, skyHorizonOffset, skyFlip,
  onSkyBlobChange, onSkyOpacityChange, onSkyEdgeFeatherChange,
  onSkyHorizonOffsetChange, onSkyFlipChange, onDetectSky, aiLoading,
}: SkyReplacementPanelProps) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    onSkyBlobChange(file);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
  }, [onSkyBlobChange, previewUrl]);

  const handleClear = useCallback(() => {
    onSkyBlobChange(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    if (fileRef.current) fileRef.current.value = '';
  }, [onSkyBlobChange, previewUrl]);

  return (
    <div className="sky-panel">
      {/* Sky image selection */}
      <div className="sky-image-row">
        {previewUrl || skyBlob ? (
          <div className="sky-preview-wrap">
            <img
              src={previewUrl ?? (skyBlob ? URL.createObjectURL(skyBlob) : '')}
              alt={t('panels.skyReplacement.skyAlt')}
              className="sky-preview-img"
            />
            <button className="sky-clear-btn" onClick={handleClear} title={t('panels.skyReplacement.remove')}>×</button>
          </div>
        ) : (
          <button className="sky-select-btn" onClick={() => fileRef.current?.click()}
            title={t('panels.skyReplacement.selectImageTitle')}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
              <path d="M1 10c2-4 4-6 7-6s5 3 7 6" />
              <circle cx="12" cy="4" r="2" />
              <path d="M1 13h14" strokeDasharray="2 2" />
            </svg>
            {t('panels.skyReplacement.selectImage')}
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/*" onChange={handleFile} style={{ display: 'none' }} />
      </div>

      {/* AI Sky Detection */}
      {onDetectSky && (
        <button className="sky-detect-btn" onClick={onDetectSky} disabled={aiLoading}
          title={t('panels.skyReplacement.detectTitle')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path d="M7 1v2M7 11v2M1 7h2M11 7h2" />
            <circle cx="7" cy="7" r="3" />
          </svg>
          {aiLoading ? t('panels.skyReplacement.detecting') : t('panels.skyReplacement.detect')}
        </button>
      )}

      {/* Controls (only visible when sky image is set) */}
      {skyBlob && (
        <div className="sky-controls">
          <Slider label={t('panels.skyReplacement.opacity')} value={Math.round(skyOpacity * 100)} min={0} max={100}
            onChange={(v) => onSkyOpacityChange(v / 100)} />
          <Slider label={t('panels.skyReplacement.edgeFeather')} value={skyEdgeFeather} min={0} max={100} defaultValue={15}
            onChange={onSkyEdgeFeatherChange} />
          <Slider label={t('panels.skyReplacement.horizonOffset')} value={skyHorizonOffset} min={-50} max={50}
            onChange={onSkyHorizonOffsetChange} />
          <button className={`sky-flip-btn ${skyFlip ? 'active' : ''}`}
            onClick={() => onSkyFlipChange(!skyFlip)} title={t('panels.skyReplacement.flipTitle')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M7 1v12M3 4l-2 3 2 3M11 4l2 3-2 3" />
            </svg>
            {t('panels.skyReplacement.flip')}
          </button>
        </div>
      )}
    </div>
  );
}
