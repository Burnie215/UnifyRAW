import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setLanguage, getLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '../../i18n';

export function LanguageToggle() {
  const { t } = useTranslation();
  const [cur, setCur] = useState<SupportedLanguage>(getLanguage());
  return (
    <div className="settings-lang-toggle" role="group" aria-label={t('settings.language')}>
      {SUPPORTED_LANGUAGES.map((lang) => (
        <button
          key={lang}
          type="button"
          className={`settings-lang-toggle-btn ${cur === lang ? 'active' : ''}`}
          aria-pressed={cur === lang}
          onClick={() => {
            if (cur === lang) return;
            setCur(lang);
            setLanguage(lang);
          }}
        >
          {lang.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
