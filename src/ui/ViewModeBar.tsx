import { useTranslation } from 'react-i18next';
import { useAdaptiveLayout } from '../contexts/AdaptiveLayoutContext';
import type { GridMode, LibraryViewMode } from '../types';
import { GridDisplayControls } from './GridDisplayControls';
import './ViewModeBar.css';

interface ViewModeBarProps {
  mode: LibraryViewMode;
  onModeChange: (mode: LibraryViewMode) => void;
  photoCount: number;
  selectedCount: number;
  /** Layout + thumbnail size of the grid, shown on the right of this bar. */
  gridMode: GridMode;
  onGridModeChange: (mode: GridMode) => void;
  tileSize: number;
  onTileSizeChange: (size: number) => void;
}

const VIEW_MODES: LibraryViewMode[] = ['grid', 'loupe', 'compare', 'survey'];

export function ViewModeBar({
  mode, onModeChange, photoCount, selectedCount,
  gridMode, onGridModeChange, tileSize, onTileSizeChange,
}: ViewModeBarProps) {
  const { t } = useTranslation();
  const { screen } = useAdaptiveLayout();
  const label = (candidate: LibraryViewMode) => t(`uiShell.viewMode.${candidate}`);

  // Phone mode selection is part of the on-demand library controls sheet.
  if (screen === 'phone') return null;

  return (
    <div className="view-mode-bar">
      <div className="vmb-left">
        <span className="vmb-count">
          {selectedCount > 0
            ? t('uiShell.viewMode.countSelected', { selected: selectedCount, total: photoCount })
            : t('uiShell.viewMode.countPhotos', { count: photoCount })}
        </span>
      </div>
      <div className="vmb-center">
        {VIEW_MODES.map((candidate) => (
          <button
            key={candidate}
            className={`vmb-btn ${mode === candidate ? 'active' : ''}`}
            onClick={() => onModeChange(candidate)}
            title={t(`uiShell.viewMode.${candidate}Tooltip`)}
          >
            <ModeIcon mode={candidate} />
            {label(candidate)}
          </button>
        ))}
      </div>
      <div className="vmb-right">
        {mode === 'grid' && (
          <GridDisplayControls
            gridMode={gridMode}
            onGridModeChange={onGridModeChange}
            tileSize={tileSize}
            onTileSizeChange={onTileSizeChange}
          />
        )}
      </div>
    </div>
  );
}

function ModeIcon({ mode }: { mode: LibraryViewMode }) {
  if (mode === 'grid') {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
        <rect x="1" y="1" width="5" height="5" rx="1" />
        <rect x="8" y="1" width="5" height="5" rx="1" />
        <rect x="1" y="8" width="5" height="5" rx="1" />
        <rect x="8" y="8" width="5" height="5" rx="1" />
      </svg>
    );
  }
  if (mode === 'loupe') {
    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1" y="1" width="12" height="12" rx="2" /></svg>;
  }
  if (mode === 'compare') {
    return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1" y="1" width="12" height="12" rx="2" /><line x1="7" y1="1" x2="7" y2="13" /></svg>;
  }
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="1" y="1" width="5" height="12" rx="1" /><rect x="8" y="1" width="5" height="12" rx="1" /></svg>;
}
