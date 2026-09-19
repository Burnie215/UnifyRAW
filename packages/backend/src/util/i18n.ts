/**
 * Minimal Accept-Language driven message lookup for backend error responses.
 * Frontend i18n is handled by react-i18next; this just keeps the few
 * user-facing API error strings in sync.
 */
import type { Request } from 'express';

type Lang = 'de' | 'en';

const messages: Record<string, Record<Lang, string>> = {
  'auth.userPassRequired': {
    de: 'Benutzername und Passwort erforderlich',
    en: 'Username and password required',
  },
  'auth.passwordTooShort': {
    de: 'Passwort muss mindestens 8 Zeichen haben',
    en: 'Password must be at least 8 characters',
  },
  'auth.userExists': {
    de: 'Benutzer existiert bereits',
    en: 'User already exists',
  },
  'auth.invalidCredentials': {
    de: 'Ungültige Anmeldedaten',
    en: 'Invalid credentials',
  },
  'auth.notAuthenticated': {
    de: 'Nicht authentifiziert',
    en: 'Not authenticated',
  },
};

export function pickLang(req: Request): Lang {
  const h = String(req.headers['accept-language'] ?? '').toLowerCase();
  // Very small parser: first tag, q-values ignored.
  const first = h.split(',')[0]?.trim() ?? '';
  if (first.startsWith('de')) return 'de';
  if (first.startsWith('en')) return 'en';
  return 'de';
}

export function tr(req: Request, key: string): string {
  const lang = pickLang(req);
  return messages[key]?.[lang] ?? key;
}
