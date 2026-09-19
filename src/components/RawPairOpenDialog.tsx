import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../storage/repos';
import './RawPairOpenDialog.css';

interface Props {
  display: PhotoView;
  raw: PhotoView;
  /** Receives the pick and whether it should apply to the rest of the session. */
  onPick: (photo: PhotoView, remember: boolean) => void;
  onCancel: () => void;
}

/**
 * Asked when a grouped RAW+JPEG photo is opened: both files carry their own
 * edit stack, so the choice decides which one is being worked on.
 */
export function RawPairOpenDialog({ display, raw, onPick, onCancel }: Props) {
  const { t } = useTranslation();
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="raw-pair-backdrop" onClick={onCancel}>
      <div className="raw-pair-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{t('dialogs.rawPair.header')}</h3>
        <p>{t('dialogs.rawPair.body')}</p>

        <div className="raw-pair-choices">
          <button className="raw-pair-choice" onClick={() => onPick(display, remember)} autoFocus>
            <span className="raw-pair-kind">{t('dialogs.rawPair.display')}</span>
            <span className="raw-pair-name" title={display.name}>{display.name}</span>
          </button>
          <button className="raw-pair-choice" onClick={() => onPick(raw, remember)}>
            <span className="raw-pair-kind">{t('dialogs.rawPair.raw')}</span>
            <span className="raw-pair-name" title={raw.name}>{raw.name}</span>
          </button>
        </div>

        <label className="raw-pair-remember">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t('dialogs.rawPair.remember')}
        </label>

        <div className="raw-pair-actions">
          <button className="btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
        </div>
      </div>
    </div>
  );
}
