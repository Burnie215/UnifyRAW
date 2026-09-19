import { useTranslation } from 'react-i18next';
import type { GridMode } from '../types';
import './GridDisplayControls.css';

interface GridDisplayControlsProps {
  gridMode: GridMode;
  onGridModeChange: (mode: GridMode) => void;
  tileSize: number;
  onTileSizeChange: (size: number) => void;
}

/**
 * How the library is displayed: layout and thumbnail size. Lives in the bottom
 * bar next to the view-mode buttons, which is also where the editor keeps its
 * display controls — one place for "how do I see this", in both views.
 */
export function GridDisplayControls({
  gridMode, onGridModeChange, tileSize, onTileSizeChange,
}: GridDisplayControlsProps) {
  const { t } = useTranslation();

  return (
    <div className="grid-display-controls">
      <div className="view-modes">
        <button
          className={`view-mode-btn ${gridMode === 'tiles' ? 'active' : ''}`}
          onClick={() => onGridModeChange('tiles')}
          title={t('gridToolbar.viewModes.tiles')}
        >
          <TilesIcon />
        </button>
        <button
          className={`view-mode-btn ${gridMode === 'list' ? 'active' : ''}`}
          onClick={() => onGridModeChange('list')}
          title={t('gridToolbar.viewModes.list')}
        >
          <ListIcon />
        </button>
        <button
          className={`view-mode-btn ${gridMode === 'gallery' ? 'active' : ''}`}
          onClick={() => onGridModeChange('gallery')}
          title={t('gridToolbar.viewModes.gallery')}
        >
          <GalleryIcon />
        </button>
        <button
          className={`view-mode-btn ${gridMode === 'timeline' ? 'active' : ''}`}
          onClick={() => onGridModeChange('timeline')}
          title={t('gridToolbar.viewModes.timeline')}
        >
          <TimelineIcon />
        </button>
      </div>

      {gridMode !== 'list' && (
        <div className="size-slider" title={t('gridToolbar.sizeTitle')}>
          <SmallIcon />
          <input
            type="range"
            min={80}
            max={400}
            value={tileSize}
            aria-label={t('gridToolbar.sizeTitle')}
            onChange={(e) => onTileSizeChange(Number(e.target.value))}
          />
          <LargeIcon />
        </div>
      )}
    </div>
  );
}

function TilesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="1" y="1" width="5" height="5" rx="1" />
      <rect x="8" y="1" width="5" height="5" rx="1" />
      <rect x="1" y="8" width="5" height="5" rx="1" />
      <rect x="8" y="8" width="5" height="5" rx="1" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 3h12M1 7h12M1 11h12" />
    </svg>
  );
}

function GalleryIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <rect x="1" y="1" width="12" height="8" rx="1" />
      <rect x="1" y="11" width="3" height="2" rx="0.5" />
      <rect x="5.5" y="11" width="3" height="2" rx="0.5" />
      <rect x="10" y="11" width="3" height="2" rx="0.5" />
    </svg>
  );
}

function TimelineIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M2 2v10M2 12h10" />
      <rect x="4" y="3" width="2" height="4" rx="0.5" fill="currentColor" opacity="0.5" />
      <rect x="7" y="5" width="2" height="2" rx="0.5" fill="currentColor" opacity="0.5" />
      <rect x="10" y="1" width="2" height="6" rx="0.5" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

function SmallIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" opacity={0.4}>
      <rect x="1" y="1" width="3" height="3" rx="0.5" />
      <rect x="6" y="1" width="3" height="3" rx="0.5" />
      <rect x="1" y="6" width="3" height="3" rx="0.5" />
      <rect x="6" y="6" width="3" height="3" rx="0.5" />
    </svg>
  );
}

function LargeIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" opacity={0.4}>
      <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
    </svg>
  );
}
