import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './ConfirmDeleteDialog.css';

interface Props {
  count: number;
  /** Optional: human label like "auf Immich (test-immich)". When omitted, generic wording. */
  sourceLabel?: string;
  /** The source provides a reversible managed trash instead of permanent deletion. */
  moveToTrash?: boolean;
  busy?: boolean;
  /** While busy: show "done / total" progress and a bar */
  progress?: { done: number; total: number };
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteDialog({ count, sourceLabel, moveToTrash, busy, progress, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
      if (e.key === 'Enter' && !busy) onConfirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel, onConfirm]);

  const pct = progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : null;

  return (
    <div className="confirm-delete-backdrop" onClick={() => !busy && onCancel()}>
      <div className="confirm-delete-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3>{t('dialogs.confirmDelete.header', { count })}</h3>
        <p>
          {moveToTrash
            ? t('dialogs.confirmDelete.bodyTrash', { source: sourceLabel })
            : sourceLabel
            ? t('dialogs.confirmDelete.bodyWithSource', { source: sourceLabel })
            : t('dialogs.confirmDelete.bodyGeneric')}
        </p>
        {busy && progress && (
          <div className="confirm-delete-progress">
            <div className="confirm-delete-progress-label">
              {t('dialogs.confirmDelete.progress', { done: progress.done, total: progress.total, pct: pct ?? 0 })}
            </div>
            <div className="confirm-delete-progress-bar">
              <div className="confirm-delete-progress-fill" style={{ width: `${pct ?? 0}%` }} />
            </div>
          </div>
        )}
        <div className="confirm-delete-actions">
          <button onClick={onCancel} disabled={busy} className="btn-secondary">{t('common.cancel')}</button>
          <button onClick={onConfirm} disabled={busy} className="btn-destructive" autoFocus>
            {busy
              ? t(moveToTrash ? 'dialogs.confirmDelete.movingToTrash' : 'dialogs.confirmDelete.deleting')
              : t(moveToTrash ? 'dialogs.confirmDelete.moveToTrash' : 'common.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
