import { useTranslation } from 'react-i18next';
import type { Adjustments } from '../types';
import { defaultAdjustments } from '../types';
import './HistoryPanel.css';

interface HistoryPanelProps {
  history: Adjustments[];
  currentAdjustments: Adjustments;
  onRestore: (adjustments: Adjustments) => void;
  /** Restore to a specific history index (preserves full document state including layers) */
  onRestoreToIndex?: (index: number) => void;
}

const CATEGORY_DEFS: [string, (keyof Adjustments)[]][] = [
  ['exposure', ['exposure']],
  ['contrast', ['contrast']],
  ['highlightsShadows', ['highlights', 'shadows', 'whites', 'blacks']],
  ['whiteBalance', ['temperature', 'tint']],
  ['presence', ['clarity', 'texture', 'dehaze', 'vibrance', 'saturation']],
  ['toneCurve', ['toneCurve']],
  ['levels', ['levels']],
  ['hsl', ['hsl']],
  ['colorEditor', ['colorEditorMode', 'advancedSectors', 'skinToneSector', 'skinToneUniformity']],
  ['colorGrading', ['colorGrading']],
  ['sharpness', ['sharpness', 'sharpenRadius', 'sharpenMasking']],
  ['noiseReduction', ['noiseReduction']],
  ['blackAndWhite', ['bwEnabled', 'bwMix']],
  ['vignette', ['vignette', 'vignetteFeather']],
  ['grain', ['grain', 'grainSize']],
  ['transform', ['rotation', 'cropAspect', 'flipH', 'flipV', 'perspectiveV', 'perspectiveH', 'distortion']],
];

/**
 * Detect which category changed between two adjustment states. Returns a category key.
 */
function detectChangeKey(prev: Adjustments, next: Adjustments): string {
  for (const [key, fields] of CATEGORY_DEFS) {
    for (const field of fields) {
      if (JSON.stringify(prev[field]) !== JSON.stringify(next[field])) {
        return key;
      }
    }
  }
  return 'adjustment';
}

export function HistoryPanel({ history, currentAdjustments, onRestore, onRestoreToIndex }: HistoryPanelProps) {
  const { t } = useTranslation();
  const entries: { index: number; key: string }[] = [];

  if (history.length > 0) {
    entries.push({ index: 0, key: detectChangeKey(defaultAdjustments, history[0]) });
    for (let i = 1; i < history.length; i++) {
      entries.push({ index: i, key: detectChangeKey(history[i - 1], history[i]) });
    }
    const lastKey = detectChangeKey(history[history.length - 1], currentAdjustments);
    if (lastKey !== 'adjustment' || JSON.stringify(history[history.length - 1]) !== JSON.stringify(currentAdjustments)) {
      entries.push({ index: history.length, key: lastKey });
    }
  }

  return (
    <div className="history-panel">
      {entries.length === 0 && (
        <div className="history-empty">{t('panels.history.empty')}</div>
      )}
      <div className="history-list">
        {entries.map((entry, i) => (
          <button
            key={i}
            className={`history-entry ${i === entries.length - 1 ? 'current' : ''}`}
            onClick={() => {
              if (entry.index < history.length) {
                // Prefer document-level restore (preserves layers/masks)
                if (onRestoreToIndex) {
                  onRestoreToIndex(entry.index);
                } else {
                  onRestore(history[entry.index]);
                }
              }
            }}
          >
            <span className="history-index">{entry.index + 1}</span>
            <span className="history-label">{t(`panels.history.categories.${entry.key}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
