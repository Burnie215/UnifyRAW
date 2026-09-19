import { useTranslation } from 'react-i18next';
import type { CompareMode } from '../components/BeforeAfter';
import type { BlockReason } from '../engine/graph';
import { formatBlockReason } from '../i18n/gateReasons';

interface EditorDisplayControlsProps {
  compareMode: CompareMode;
  onCompareModeChange: (mode: CompareMode) => void;
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onPanReset: () => void;
  renderMode?: 'classic' | 'graph';
  onRenderModeChange?: (mode: 'classic' | 'graph') => void;
  /**
   * How many nodes stand in the way of going back to the classic view.
   * 0 (the default) means the way back is open. The count is what the user
   * sees on the locked button, so it counts NODES, not findings — one node
   * can break several rules at once.
   */
  classicBlockedCount?: number;
  /** One of the reasons, for the tooltip. Arrives as the engine's key and is
   *  put into words here. The full list lives in the graph editor, where the
   *  offending nodes can be jumped to. */
  classicBlockedReason?: BlockReason;
}

const COMPARE_MODES: CompareMode[] = ['off', 'split', 'side-by-side', 'toggle'];

/**
 * How the open photo is being displayed: pipeline view, before/after and zoom.
 * Rendered into the status bar so it sits bottom-right, next to the zoom
 * percentage and in the same place as the library's display controls.
 */
export function EditorDisplayControls({
  compareMode, onCompareModeChange,
  zoom, onZoomChange, onPanReset,
  renderMode = 'classic', onRenderModeChange,
  classicBlockedCount = 0, classicBlockedReason,
}: EditorDisplayControlsProps) {
  const { t } = useTranslation();
  // The gate. Purple and locked rather than hidden: the user has to be able
  // to see that the way back exists and why it is closed right now.
  const classicLocked = classicBlockedCount > 0;
  const classicTitle = classicLocked
    ? [
      t('editor.modeClassicBlocked', { count: classicBlockedCount }),
      classicBlockedReason && formatBlockReason(classicBlockedReason, t),
    ].filter(Boolean).join(' — ')
    : t('editor.modeClassic');

  return (
    <div className="sb-display-controls">
      {onRenderModeChange && (
        <div className="render-mode-toggle">
          <button
            className={`toolbar-icon-btn ${renderMode === 'classic' ? 'active' : ''}`
              + (classicLocked ? ' gate-blocked' : '')}
            onClick={() => onRenderModeChange('classic')}
            disabled={classicLocked}
            title={classicTitle}
          >
            {t('editor.modeClassicShort')}
            {classicLocked && <span className="gate-count">{classicBlockedCount}</span>}
          </button>
          <button
            className={`toolbar-icon-btn ${renderMode === 'graph' ? 'active' : ''}`}
            onClick={() => onRenderModeChange('graph')}
            title={t('editor.modeGraph')}
          >
            {t('editor.modeGraphShort')}
          </button>
        </div>
      )}

      <button
        className={`toolbar-icon-btn ${compareMode !== 'off' ? 'active' : ''}`}
        onClick={() => onCompareModeChange(COMPARE_MODES[(COMPARE_MODES.indexOf(compareMode) + 1) % COMPARE_MODES.length])}
        title={t('editor.compareTitle')}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="1" width="12" height="12" rx="2" /><line x1="7" y1="1" x2="7" y2="13" />
        </svg>
      </button>

      <button
        className="toolbar-icon-btn"
        onClick={() => { onZoomChange(1); onPanReset(); }}
        title={t('editor.fit')}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="1" width="10" height="10" rx="1" />
        </svg>
      </button>
      <button
        className="toolbar-icon-btn"
        onClick={() => onZoomChange(Math.min(8, zoom + 0.5))}
        title={t('editor.zoomInTitle')}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 2v8M2 6h8" />
        </svg>
      </button>
    </div>
  );
}
