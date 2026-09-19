import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Adjustments } from '../types';
import { defaultAdjustments } from '../types';
import type { PhotoView } from '../storage/repos';
import type { KeywordAggregation } from '../data/keywordTree';
import type { ExifData } from '../hooks/useExif';

import { Histogram } from '../components/Histogram';
import { KeywordsPanel } from '../components/KeywordsPanel';
import { MetadataPanel } from '../components/MetadataPanel';
import { CompactSlider as Slider } from './CompactSlider';

/**
 * The tone and colour keys this panel owns. Reset and the fan-out onto a
 * multi-selection touch only these, so a photo's crop, curves or layers
 * survive a Quick Develop pass.
 */
export const QUICK_DEVELOP_KEYS = [
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'clarity', 'vibrance', 'saturation',
] as const satisfies readonly (keyof Adjustments)[];

export interface LibraryPanelContentProps {
  // Selection
  selectedPhotos: PhotoView[];
  selectedPhoto: PhotoView | null;
  // Image for histogram
  imageUrl?: string | null;
  // Quick Develop
  adjustments?: Adjustments | null;
  /** Emits only the keys the user changed, never a whole Adjustments object. */
  onQuickDevChange?: (patch: Partial<Adjustments>) => void;
  /** Fan-out onto the rest of the selection, while it is still running. */
  quickDevProgress?: { done: number; total: number } | null;
  /**
   * True while the first edit of a not-yet-identified photo is fetching the
   * original to hash it. The sliders stay live through it: that first edit is
   * written onto the master row and is what creates the identity (F022).
   */
  quickDevIdentifying?: boolean;
  // EXIF
  exif?: ExifData | null;
  // Keywords
  allKeywords: KeywordAggregation[];
  onAddKeywords: (photoIds: number[], keywords: string[]) => void;
  onRemoveKeyword: (photoIds: number[], keyword: string) => void;
  onKeywordFilter?: (keyword: string) => void;
  keywordFilter?: string;
}

export function useLibraryPanelContent(props: LibraryPanelContentProps) {
  const { t } = useTranslation();
  const {
    selectedPhotos, selectedPhoto,
    imageUrl, adjustments, onQuickDevChange, quickDevProgress, quickDevIdentifying = false, exif,
    allKeywords, onAddKeywords, onRemoveKeyword, onKeywordFilter, keywordFilter,
  } = props;

  const set = (key: keyof Adjustments, value: unknown) => {
    onQuickDevChange?.({ [key]: value } as Partial<Adjustments>);
  };

  return useMemo(() => {
    const map = new Map<string, React.ReactNode>();

    // Histogram
    map.set('histogram', (
      <Histogram imageUrl={imageUrl ?? null} />
    ));

    // Keywords
    map.set('keywords', (
      <KeywordsPanel
        selectedPhotos={selectedPhotos}
        onAddKeywords={onAddKeywords}
        onRemoveKeyword={onRemoveKeyword}
        allKeywords={allKeywords}
        onKeywordFilter={onKeywordFilter}
        activeKeyword={keywordFilter}
      />
    ));

    // Metadata
    if (exif) {
      map.set('metadata', (
        <MetadataPanel exif={exif} />
      ));
    }

    // Quick Develop
    if (adjustments && onQuickDevChange) {
      const resetPatch = Object.fromEntries(
        QUICK_DEVELOP_KEYS.map((key) => [key, defaultAdjustments[key]]),
      ) as Partial<Adjustments>;
      map.set('quickdev', (
        <div className="quickdev-panel">
          <div className="quickdev-actions">
            <button className="quickdev-reset-btn" onClick={() => onQuickDevChange(resetPatch)}>
              {t('uiShell.libraryPanel.reset')}
            </button>
          </div>
          {quickDevIdentifying && (
            <div className="quickdev-progress">{t('uiShell.libraryPanel.identifying')}</div>
          )}
          {quickDevProgress && (
            <div className="quickdev-progress">
              {t('uiShell.libraryPanel.applyingToSelection', {
                done: quickDevProgress.done, total: quickDevProgress.total,
              })}
            </div>
          )}
          <Slider label={t('panels.raw.exposure')} value={adjustments.exposure} min={-100} max={100} onChange={(v) => set('exposure', v)} />
          <Slider label={t('panels.raw.contrast')} value={adjustments.contrast} min={-100} max={100} onChange={(v) => set('contrast', v)} />
          <Slider label={t('panels.raw.highlights')} value={adjustments.highlights} min={-100} max={100} onChange={(v) => set('highlights', v)} />
          <Slider label={t('panels.raw.shadows')} value={adjustments.shadows} min={-100} max={100} onChange={(v) => set('shadows', v)} />
          <Slider label={t('panels.raw.whites')} value={adjustments.whites} min={-100} max={100} onChange={(v) => set('whites', v)} />
          <Slider label={t('panels.raw.blacks')} value={adjustments.blacks} min={-100} max={100} onChange={(v) => set('blacks', v)} />
          <Slider label={t('panels.raw.clarity')} value={adjustments.clarity} min={-100} max={100} onChange={(v) => set('clarity', v)}
            trackGradient="linear-gradient(to right, #555, #ccc)" />
          <Slider label={t('panels.raw.vibrance')} value={adjustments.vibrance} min={-100} max={100} onChange={(v) => set('vibrance', v)}
            trackGradient="linear-gradient(to right, #666, #e67e22)" />
          <Slider label={t('panels.raw.saturation')} value={adjustments.saturation} min={-100} max={100} onChange={(v) => set('saturation', v)}
            trackGradient="linear-gradient(to right, #777, #e74c3c, #e67e22, #f1c40f, #2ecc71, #3498db, #9b59b6)" />
        </div>
      ));
    }

    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, selectedPhotos, selectedPhoto, imageUrl, adjustments, quickDevProgress, quickDevIdentifying, exif, allKeywords, keywordFilter]);
}
