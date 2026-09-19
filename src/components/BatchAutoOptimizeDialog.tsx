import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { formatAutoOptimizeEta } from '../engine/BatchAutoOptimize';
import './BatchAutoOptimizeDialog.css';

export interface BatchAutoOptimizeStatus {
  done: number;
  total: number;
  currentName: string | null;
  etaMs: number | null;
  failed: number;
  /** Photos whose RAW development fell back to the embedded camera JPEG, so
   *  the analysis saw an 8-bit JPEG instead of RAW pixels (F039). */
  embeddedJpeg: number;
  running: boolean;
  cancelRequested: boolean;
  cancelled: boolean;
}

interface Props {
  status: BatchAutoOptimizeStatus;
  onCancel: () => void;
  onClose: () => void;
}

export function BatchAutoOptimizeDialog({ status, onCancel, onClose }: Props) {
  const { t, i18n } = useTranslation();
  const percent = status.total > 0 ? Math.round(status.done / status.total * 100) : 0;
  const language = i18n.resolvedLanguage?.startsWith('en') ? 'en' : 'de';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (status.running) onCancel();
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [status.running, onCancel, onClose]);

  const summary = status.running
    ? t('batchAutoOptimize.progress', { done: status.done, total: status.total })
    : status.cancelled
      ? t('batchAutoOptimize.cancelled', { done: status.done, total: status.total })
      : status.failed > 0
        ? t('batchAutoOptimize.completeWithErrors', { done: status.done, failed: status.failed })
        : t('batchAutoOptimize.complete', { count: status.done });

  return (
    <div className="batch-auto-backdrop">
      <div className="batch-auto-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-auto-title">
        <h3 id="batch-auto-title">{t('batchAutoOptimize.title')}</h3>
        <div className="batch-auto-summary">{summary}</div>
        {!status.running && status.embeddedJpeg > 0 && (
          <div className="batch-auto-summary">
            {t('batchAutoOptimize.embeddedJpegCount', { count: status.embeddedJpeg, total: status.done })}
          </div>
        )}
        <div
          className="batch-auto-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={status.total}
          aria-valuenow={status.done}
          aria-label={summary}
        >
          <div className="batch-auto-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="batch-auto-percent">{percent}%</div>

        {status.running && (
          <div className="batch-auto-details">
            <div className="batch-auto-current" title={status.currentName ?? undefined}>
              {status.cancelRequested
                ? t('batchAutoOptimize.cancelling')
                : status.currentName ?? t('batchAutoOptimize.preparing')}
            </div>
            {status.etaMs !== null && !status.cancelRequested && (
              <div>{t('batchAutoOptimize.remaining', {
                duration: formatAutoOptimizeEta(status.etaMs, language),
              })}</div>
            )}
          </div>
        )}

        <div className="batch-auto-actions">
          {status.running ? (
            <button className="btn-secondary" onClick={onCancel} disabled={status.cancelRequested}>
              {status.cancelRequested ? t('batchAutoOptimize.cancelling') : t('common.cancel')}
            </button>
          ) : (
            <button className="btn-primary" onClick={onClose} autoFocus>{t('common.close')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
