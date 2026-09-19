import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useBrand } from '../brand';
import './AlphaNoticeModal.css';

/**
 * First-load warning: the build is alpha, so a library without a backup has
 * no business being connected to it. Sits above every other overlay
 * (FirstLaunchModal included) because it has to be read before a catalog or
 * a source is picked.
 */
export function AlphaNoticeModal({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  const brand = useBrand();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  return (
    <div className="alpha-notice-overlay">
      <div
        className="alpha-notice-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="alpha-notice-heading"
        aria-describedby="alpha-notice-body"
      >
        <div className="alpha-notice-kicker">{t('alpha.badge')}</div>
        <h2 id="alpha-notice-heading">{t('alpha.noticeHeading', { brand: brand.name })}</h2>
        <div id="alpha-notice-body">
          <p className="alpha-notice-text">{t('alpha.noticeIntro', { brand: brand.name })}</p>
          <p className="alpha-notice-warning">{t('alpha.noticeWarning')}</p>
          <p className="alpha-notice-text">{t('alpha.noticeBackup')}</p>
        </div>
        <button ref={confirmRef} className="alpha-notice-confirm" onClick={onDismiss}>
          {t('alpha.noticeConfirm')}
        </button>
      </div>
    </div>
  );
}
