import { useTranslation } from 'react-i18next';
import './AlphaBadge.css';

/**
 * Sits next to the wordmark and says the product is pre-release.
 * Purely informational — the long-form warning lives in AlphaNoticeModal.
 */
export function AlphaBadge() {
  const { t } = useTranslation();
  return (
    <span className="alpha-badge" title={t('alpha.badgeTitle')}>
      {t('alpha.badge')}
    </span>
  );
}
