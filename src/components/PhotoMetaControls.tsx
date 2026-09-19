/**
 * Rating, flag and colour label for a set of photos — one block, used by the
 * phone selection sheet and by the desktop gallery context menu, so both
 * surfaces offer exactly the same values and call exactly the same setters
 * (F026).
 */
import { useTranslation } from 'react-i18next';
import { COLOR_LABEL_VALUES, FLAG_VALUES, RATING_VALUES } from '../data/photoMeta';
import type { PhotoColorLabel, PhotoFlag } from '../storage/repos';
import './PhotoMetaControls.css';

export interface PhotoMetaHandlers {
  onSetRating: (rating: number) => void;
  onSetFlag: (flag: PhotoFlag) => void;
  onSetColorLabel: (colorLabel: PhotoColorLabel) => void;
}

interface Props extends PhotoMetaHandlers {
  /** How many photos the click will hit; 0 disables the block. */
  count: number;
  /** Called after any value was handed over, e.g. to close the surface. */
  onAfterApply?: () => void;
}

export function PhotoMetaControls({ count, onSetRating, onSetFlag, onSetColorLabel, onAfterApply }: Props) {
  const { t } = useTranslation();
  const disabled = count === 0;
  const apply = (run: () => void) => () => {
    run();
    onAfterApply?.();
  };

  return (
    <div className="photo-meta-controls" data-testid="photo-meta-controls">
      <div className="pmc-row">
        <span className="pmc-row-label">{t('photoMeta.rating')}</span>
        <div className="pmc-stars" role="group" aria-label={t('photoMeta.rating')}>
          {RATING_VALUES.map((rating) => (
            <button
              key={rating}
              type="button"
              className="pmc-star-btn"
              data-rating={rating}
              disabled={disabled}
              onClick={apply(() => onSetRating(rating))}
              aria-label={rating === 0 ? t('photoMeta.noRating') : t('photoMeta.stars', { count: rating })}
            >
              {rating === 0 ? <span aria-hidden="true">0</span> : <span aria-hidden="true">{rating}★</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="pmc-row">
        <span className="pmc-row-label">{t('photoMeta.flag')}</span>
        <div className="pmc-flags" role="group" aria-label={t('photoMeta.flag')}>
          {FLAG_VALUES.map((flag) => (
            <button
              key={flag ?? 'none'}
              type="button"
              className={`pmc-flag-btn pmc-flag-${flag ?? 'none'}`}
              data-flag={flag ?? 'none'}
              disabled={disabled}
              onClick={apply(() => onSetFlag(flag))}
            >
              {t(`gridToolbar.fb.${flag ?? 'unflagged'}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="pmc-row">
        <span className="pmc-row-label">{t('photoMeta.colorLabel')}</span>
        <div className="pmc-labels" role="group" aria-label={t('photoMeta.colorLabel')}>
          {COLOR_LABEL_VALUES.map((colorLabel) => (
            <button
              key={colorLabel ?? 'none'}
              type="button"
              className={`pmc-label-btn ${colorLabel ? '' : 'pmc-label-none'}`}
              data-label={colorLabel ?? 'none'}
              disabled={disabled}
              onClick={apply(() => onSetColorLabel(colorLabel))}
              aria-label={colorLabel ? t(`uiShell.colorPanels.${colorLabel}`) : t('photoMeta.noLabel')}
            >
              {colorLabel
                ? <span className="pmc-label-dot" style={{ background: `var(--label-${colorLabel})` }} />
                : <span aria-hidden="true">×</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
