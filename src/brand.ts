/**
 * Brand — single source of truth for product identity.
 *
 * The default brand (UnifyRAW) ships with the app. A white-label installation
 * overrides it from the Branding tab in the settings; there is no license gate
 * (feature tiers were discarded, see dec-own-license). An override only ever
 * stores the fields that differ from the default, so later changes to the
 * default still reach an installation that renamed one field years ago.
 *
 * UI components should read via {@link useBrand} (reactive) or {@link getBrand}
 * (one-shot). Document head (title, meta, favicon) is synced by
 * {@link applyBrandToDocument} on boot and on every override.
 */

import { useSyncExternalStore } from 'react';
import { STORAGE_KEYS } from './platform/storageKeys';

export interface Brand {
  /** Full product name. Shown in titles, headings, About dialog. */
  name: string;
  /** Compact name for PWA short_name and narrow UI. */
  shortName: string;
  /** One-line description. Used in meta tags and About. */
  tagline: string;
  /** Path (or data: URL) to favicon. Served from /public by default. */
  faviconPath: string;
  /** Path to wordmark image. Null = render {@link name} as text. */
  wordmarkPath: string | null;
  /** PWA / status-bar theme color (CSS color string). */
  themeColor: string;
  /** Copyright line in About dialog. */
  copyright: string;
  /** Vendor name used in API integrations (Immich deviceId etc). Stable across rebrands. */
  vendorId: string;
}

const DEFAULT_BRAND: Brand = {
  name: 'UnifyRAW',
  shortName: 'UnifyRAW',
  tagline: 'Foto-Bibliothek und RAW-Editor',
  faviconPath: '/favicon.svg',
  wordmarkPath: '/wordmark.svg',
  themeColor: '#1a1a1a',
  copyright: 'UnifyRAW',
  vendorId: 'PhotoLib',
};

const OVERRIDE_STORAGE_KEY = STORAGE_KEYS.brandOverride;

/**
 * Keep only the fields that actually differ from the default. This is what
 * makes an override forward-compatible: a field left on its default value is
 * simply absent, so a later change to DEFAULT_BRAND still reaches this
 * installation. Returns null when nothing differs.
 */
function diffAgainstDefault(candidate: Partial<Brand>): Partial<Brand> | null {
  const diff: Partial<Brand> = {};
  for (const key of Object.keys(DEFAULT_BRAND) as (keyof Brand)[]) {
    const value = candidate[key];
    if (value === undefined || value === DEFAULT_BRAND[key]) continue;
    diff[key] = value as never;
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

function readPersistedOverride(): Partial<Brand> | null {
  try {
    const raw = localStorage.getItem(OVERRIDE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Installations from before the diff form hold a complete Brand object;
    // normalising on read is what lets default changes reach them again.
    return parsed && typeof parsed === 'object' ? diffAgainstDefault(parsed as Partial<Brand>) : null;
  } catch {
    return null;
  }
}

function writePersistedOverride(override: Partial<Brand> | null): void {
  try {
    if (override && Object.keys(override).length > 0) {
      localStorage.setItem(OVERRIDE_STORAGE_KEY, JSON.stringify(override));
    } else {
      localStorage.removeItem(OVERRIDE_STORAGE_KEY);
    }
  } catch {
    // localStorage may be unavailable (private mode, quota) — runtime override
    // still works for the session, it just doesn't survive a reload.
  }
}

let currentOverride: Partial<Brand> | null = readPersistedOverride();
let active: Brand = currentOverride ? { ...DEFAULT_BRAND, ...currentOverride } : DEFAULT_BRAND;
const listeners = new Set<() => void>();

export function getBrand(): Brand {
  return active;
}

/** Returns the active override (partial), or null when running on defaults. */
export function getBrandOverride(): Partial<Brand> | null {
  return currentOverride;
}

/** Returns the built-in default brand (read-only reference). */
export function getDefaultBrand(): Brand {
  return DEFAULT_BRAND;
}

/**
 * Override brand fields at runtime. Pass `null` to reset to default.
 * Persists to localStorage, syncs document head, and notifies subscribers.
 */
export function setBrandOverride(override: Partial<Brand> | null): void {
  currentOverride = override ? diffAgainstDefault(override) : null;
  active = currentOverride ? { ...DEFAULT_BRAND, ...currentOverride } : DEFAULT_BRAND;
  writePersistedOverride(currentOverride);
  applyBrandToDocument();
  for (const l of listeners) l();
}

/** Set one field, leaving the other overridden fields alone. */
export function updateBrandField<K extends keyof Brand>(field: K, value: Brand[K]): void {
  const next: Partial<Brand> = { ...(currentOverride ?? {}) };
  next[field] = value;
  setBrandOverride(next);
}

/** Convenience: clear all overrides and revert to the default brand. */
export function resetBrand(): void {
  setBrandOverride(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook — re-renders when the active brand changes. */
export function useBrand(): Brand {
  return useSyncExternalStore(subscribe, getBrand, getBrand);
}

/**
 * Reflect the active brand into the document head. Call once at boot,
 * and after every {@link setBrandOverride}. Safe to call before React mounts.
 */
export function applyBrandToDocument(): void {
  if (typeof document === 'undefined') return;
  const b = active;
  document.title = b.name;
  setMeta('description', `${b.name} — ${b.tagline}`);
  setMeta('theme-color', b.themeColor);
  setLink('icon', b.faviconPath, 'image/svg+xml');
}

function setMeta(name: string, content: string): void {
  let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

function setLink(rel: string, href: string, type?: string): void {
  let el = document.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
  if (!el) {
    el = document.createElement('link');
    el.rel = rel;
    document.head.appendChild(el);
  }
  el.href = href;
  if (type) el.type = type;
}
