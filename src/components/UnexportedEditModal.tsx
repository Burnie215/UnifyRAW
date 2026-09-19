import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './UnexportedEditModal.css';

interface Props {
  /** The source the edit would be pushed back to, for the body text. */
  sourceLabel?: string;
  /** Leave the editor anyway. */
  onLeave: () => void;
  /** Open the export dialog with the source preselected, and stay. */
  onExport: () => void;
  /** Stay in the editor, change nothing. */
  onCancel: () => void;
  /** The "do not ask again" box; unchecking it again lives in the settings. */
  onSuppress: (suppressed: boolean) => void;
}

/**
 * Asked when the editor is left with an edit the export ledger has never seen
 * (or has only seen an older version of). Whether it is asked at all is
 * decided by `shouldWarnUnexportedEdit` in src/export/unexportedEdit.ts — this
 * component only shows the question.
 */
export function UnexportedEditModal({ sourceLabel, onLeave, onExport, onCancel, onSuppress }: Props) {
  const { t } = useTranslation();
  const exportRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    exportRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="unexported-edit-backdrop" onClick={onCancel}>
      <div
        className="unexported-edit-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unexported-edit-heading"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="unexported-edit-heading">{t('dialogs.unexportedEdit.header')}</h3>
        <p>
          {sourceLabel
            ? t('dialogs.unexportedEdit.bodyWithSource', { source: sourceLabel })
            : t('dialogs.unexportedEdit.body')}
        </p>
        <label className="unexported-edit-suppress">
          <input type="checkbox" onChange={(e) => onSuppress(e.target.checked)} />
          {t('dialogs.unexportedEdit.dontAskAgain')}
        </label>
        <p className="unexported-edit-suppress-hint">{t('dialogs.unexportedEdit.dontAskAgainHint')}</p>
        <div className="unexported-edit-actions">
          <button className="btn-secondary" onClick={onLeave}>
            {t('dialogs.unexportedEdit.leave')}
          </button>
          <button ref={exportRef} className="btn-primary" onClick={onExport}>
            {t('dialogs.unexportedEdit.exportNow')}
          </button>
        </div>
      </div>
    </div>
  );
}
