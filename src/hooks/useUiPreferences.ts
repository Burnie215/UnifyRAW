import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS } from '../platform/storageKeys';

export type UiSize = 'sm' | 'md' | 'lg';
export type AccentPreset = 'blue' | 'green' | 'orange' | 'purple' | 'red' | 'gray';
export type ThemeMode = 'dark' | 'light' | 'system';
export type SidebarWidth = 'narrow' | 'normal' | 'wide';

export interface UiPreferences {
  fontSize: UiSize;
  accent: AccentPreset;
  theme: ThemeMode;
  compact: boolean;
  sidebarWidth: SidebarWidth;
  /**
   * Ask before leaving the editor with an edit the source has never seen.
   * Not a look, but it lives here because it is the same per-device store and
   * the same settings pane switches it back on.
   */
  exportReminder: boolean;
}

const STORAGE_KEY = STORAGE_KEYS.uiPreferences;

const DEFAULTS: UiPreferences = {
  fontSize: 'md',
  accent: 'blue',
  theme: 'dark',
  compact: false,
  sidebarWidth: 'normal',
  exportReminder: true,
};

/**
 * What the "reset the look" button restores. The export reminder survives it:
 * the button names the five look settings, and silently switching a warning
 * back on is not what someone asks for when they reset their colours.
 */
export function resetLookPreferences(prefs: UiPreferences): UiPreferences {
  return { ...DEFAULTS, exportReminder: prefs.exportReminder };
}

const SIDEBAR_WIDTHS: Record<SidebarWidth, string> = {
  narrow: '180px',
  normal: '220px',
  wide:   '280px',
};

export const ACCENT_COLORS: Record<AccentPreset, { base: string; hover: string }> = {
  blue:   { base: '#4a9eff', hover: '#6bb3ff' },
  green:  { base: '#2ecc71', hover: '#48d984' },
  orange: { base: '#f39c12', hover: '#f5b03d' },
  purple: { base: '#9b59b6', hover: '#b07cc8' },
  red:    { base: '#e74c3c', hover: '#ec6c5e' },
  gray:   { base: '#7f8c8d', hover: '#95a5a6' },
};

function load(): UiPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* */ }
  return { ...DEFAULTS };
}

function save(prefs: UiPreferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* */ }
}

/** Lumineszenz-Check für Foreground-Kontrast. WCAG AA approximation. */
function pickForeground(hex: string): '#000000' | '#ffffff' {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.55 ? '#000000' : '#ffffff';
}

function resolveTheme(theme: ThemeMode): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

/** Apply prefs to <html> attributes + CSS custom properties. */
function apply(prefs: UiPreferences) {
  const root = document.documentElement;
  if (prefs.fontSize === 'md') root.removeAttribute('data-ui-size');
  else root.setAttribute('data-ui-size', prefs.fontSize);

  const resolvedTheme = resolveTheme(prefs.theme);
  if (resolvedTheme === 'dark') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', resolvedTheme);

  if (prefs.compact) root.setAttribute('data-ui-density', 'compact');
  else root.removeAttribute('data-ui-density');

  root.style.setProperty('--sidebar-width', SIDEBAR_WIDTHS[prefs.sidebarWidth]);

  const accent = ACCENT_COLORS[prefs.accent];
  root.style.setProperty('--accent', accent.base);
  root.style.setProperty('--accent-hover', accent.hover);
  root.style.setProperty('--accent-fg', pickForeground(accent.base));
}

/**
 * Mount once at the App root. Reflects UI preferences into CSS custom
 * properties on <html>. Per-device (no sync) — see the UI customization
 * plan's open question about sync conflicts.
 */
export function useUiPreferences() {
  const [prefs, setPrefs] = useState<UiPreferences>(load);

  useEffect(() => { apply(prefs); }, [prefs]);

  // System-theme: re-apply when the OS preference flips while "system" is active.
  useEffect(() => {
    if (prefs.theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => apply(prefs);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [prefs]);

  const update = useCallback((patch: Partial<UiPreferences>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      save(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setPrefs((prev) => {
      const next = resetLookPreferences(prev);
      save(next);
      return next;
    });
  }, []);

  return { prefs, update, reset };
}
