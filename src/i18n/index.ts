import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { mergeLocaleModules } from './mergeLocales';
import { STORAGE_KEYS } from '../platform/storageKeys';

export const SUPPORTED_LANGUAGES = ['de', 'en'] as const;
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

const STORAGE_KEY = STORAGE_KEYS.language;

// Every ./locales/<lang>.json and ./locales/<lang>/*.json; a new namespace file
// is picked up without touching this file. The merge order is spelled out in
// mergeLocales.ts, and locales.test.ts keeps each leaf key in one file.
const modules = import.meta.glob<{ default: Record<string, unknown> }>(
  './locales/**/*.json',
  { eager: true },
);

const resources = mergeLocaleModules(modules, SUPPORTED_LANGUAGES);

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'de',
    supportedLngs: SUPPORTED_LANGUAGES,
    nonExplicitSupportedLngs: true,
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: STORAGE_KEY,
      caches: ['localStorage'],
    },
    returnNull: false,
  });

export function setLanguage(lang: SupportedLanguage): void {
  void i18n.changeLanguage(lang);
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
  document.documentElement.lang = lang;
}

export function getLanguage(): SupportedLanguage {
  const cur = (i18n.resolvedLanguage || i18n.language || 'de').slice(0, 2);
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(cur) ? (cur as SupportedLanguage) : 'de';
}

document.documentElement.lang = getLanguage();

export default i18n;
