import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
// Shares the confirm-dialog styling; removing from the catalog and deleting in
// the source are different questions but the same kind of dialog.
import './ConfirmDeleteDialog.css';

interface Props {
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Asked before taking two or more photos out of the catalog. A single photo
 * goes straight out with an undo toast instead.
 */
export function ConfirmRemoveDialog({ count, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="confirm-delete-backdrop" onClick={onCancel}>
      <div className="confirm-delete-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{t('library.confirmRemove.header', { count })}</h3>
        <p>{t('library.confirmRemove.body')}</p>
        <div className="confirm-delete-actions">
          <button onClick={onCancel} className="btn-secondary">{t('common.cancel')}</button>
          <button onClick={onConfirm} className="btn-destructive" autoFocus>{t('common.remove')}</button>
        </div>
      </div>
    </div>
  );
}
