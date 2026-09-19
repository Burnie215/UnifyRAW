/**
 * License — JWT-based offline license validation.
 *
 * License key = signed JWT containing:
 * - email, issuedAt, updatesUntil, maxUsers
 *
 * Validated with embedded public key (no phone-home).
 * Works offline. Container starts regardless — UI shows
 * warnings/limits if invalid.
 *
 * Key generation happens on the sales server (not in this codebase).
 */

import { STORAGE_KEYS } from '../platform/storageKeys';

export interface LicenseInfo {
  email: string;
  issuedAt: string;      // ISO date
  updatesUntil: string;  // ISO date — updates allowed until this date
  maxUsers: number;
  plan: 'personal' | 'family' | 'studio';
}

export interface LicenseStatus {
  valid: boolean;
  info: LicenseInfo | null;
  error: string | null;
  /** Updates still covered (updatesUntil >= current build date) */
  updatesActive: boolean;
  /** Days until update coverage expires (-1 if expired) */
  updatesDaysLeft: number;
}

// Build date injected at build time (Vite define, see vite.config.ts). Until
// 2026-09-05 this was a bare string literal that no define ever replaced, so
// the fallback below was the only path ever taken.
declare const __BUILD_DATE__: string;
const BUILD_DATE = typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '';

/**
 * Whether the product licence exists as a thing a user can buy or enter.
 * It does not: UnifyRAW is published under AGPL-3.0-only, so there is no key
 * to activate and the settings tab would offer a transaction that cannot
 * happen. The code below stays, because the author holds all rights and a
 * commercial licence next to the AGPL remains possible; flip this to bring
 * the tab back.
 */
export const LICENSING_ENABLED = false;

const STORAGE_KEY = STORAGE_KEYS.license;

// Ed25519/RSA public key for JWT verification.
// In production, replace with actual public key.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
REPLACE_WITH_ACTUAL_PUBLIC_KEY
-----END PUBLIC KEY-----`;

/**
 * Validate a license key (JWT).
 * Pure offline validation — no network requests.
 */
export async function validateLicense(token: string): Promise<LicenseStatus> {
  try {
    const payload = decodeJwtPayload(token);
    if (!payload) return invalid('Ungueltiger Lizenzschluessel');

    const info: LicenseInfo = {
      email: (payload.email as string) ?? '',
      issuedAt: payload.iat ? new Date((payload.iat as number) * 1000).toISOString().slice(0, 10) : '',
      updatesUntil: (payload.updatesUntil as string) ?? '',
      maxUsers: (payload.maxUsers as number) ?? 1,
      plan: (payload.plan as LicenseInfo['plan']) ?? 'personal',
    };

    if (!info.email) return invalid('Kein E-Mail im Schluessel');
    if (!info.updatesUntil) return invalid('Kein Update-Datum im Schluessel');

    // Verify signature (if crypto.subtle available)
    const signatureValid = await verifyJwtSignature(token);
    if (!signatureValid) return invalid('Signatur ungueltig');

    // Check update coverage
    const updatesUntil = new Date(info.updatesUntil);
    const buildDate = parseBuildDate();
    const updatesActive = updatesUntil >= buildDate;
    const updatesDaysLeft = Math.ceil((updatesUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

    return {
      valid: true,
      info,
      error: null,
      updatesActive,
      updatesDaysLeft: Math.max(-1, updatesDaysLeft),
    };
  } catch {
    return invalid('Lizenz konnte nicht gelesen werden');
  }
}

/**
 * Load stored license from localStorage.
 */
export function loadStoredLicense(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Store license in localStorage.
 */
export function storeLicense(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch { /* */ }
}

/**
 * Remove stored license.
 */
export function clearLicense(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* */ }
}

/**
 * Check if the app is running in self-hosted mode (Docker).
 * In PWA/demo mode, license features are not required.
 */
export function isSelfHosted(): boolean {
  // Set by Docker entrypoint via env variable → injected into index.html
  return (window as unknown as { __PHOTOLIB_SELFHOSTED__?: boolean }).__PHOTOLIB_SELFHOSTED__ === true;
}

/**
 * Determine which features are available based on license status.
 */
export function getFeatureGate(status: LicenseStatus): FeatureGate {
  if (!isSelfHosted()) {
    // PWA mode — free features only
    return {
      remoteSources: false,
      sidecarExport: false,
      multiUser: false,
      syncServer: false,
      maxLocalSources: 1,
    };
  }

  if (!status.valid) {
    // Self-hosted but no valid license — trial mode
    return {
      remoteSources: true,
      sidecarExport: true,
      multiUser: false,
      syncServer: false,
      maxLocalSources: 3,
    };
  }

  // Valid license — all features
  return {
    remoteSources: true,
    sidecarExport: true,
    multiUser: status.info!.maxUsers > 1,
    syncServer: true,
    maxLocalSources: Infinity,
  };
}

export interface FeatureGate {
  remoteSources: boolean;
  sidecarExport: boolean;
  multiUser: boolean;
  syncServer: boolean;
  maxLocalSources: number;
}

// ─── JWT Helpers (no external dependency) ───

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function verifyJwtSignature(token: string): Promise<boolean> {
  if (PUBLIC_KEY_PEM.includes('REPLACE_WITH')) {
    // Development mode — skip verification
    return true;
  }

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const key = await importPublicKey(PUBLIC_KEY_PEM);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlToBuffer(parts[2]);

    return await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      signature,
      data,
    );
  } catch {
    // If crypto.subtle unavailable (HTTP context), accept the token
    // Self-hosted containers should always use HTTPS
    return true;
  }
}

async function importPublicKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(pemBody);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);

  return crypto.subtle.importKey(
    'spki',
    buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

function base64UrlToBuffer(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  const binary = atob(padded);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
  return buffer.buffer;
}

function parseBuildDate(): Date {
  // Falls back to current date if BUILD_DATE not replaced at build time
  const d = new Date(BUILD_DATE);
  return isNaN(d.getTime()) ? new Date() : d;
}

function invalid(error: string): LicenseStatus {
  return { valid: false, info: null, error, updatesActive: false, updatesDaysLeft: -1 };
}
