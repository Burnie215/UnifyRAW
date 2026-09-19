/**
 * Die eine Wahrheit darueber, was welche Quelle kann.
 *
 * Vor dieser Datei lag diese Information an vier Stellen verstreut:
 * `ENABLED_SOURCES` (AddSourceDialog), `BROWSER_DIRECT_SOURCE_TYPES`
 * (platform/sourceTransport), `isLocalRawSourceType` (engine/raw/sourcePolicy)
 * und der Factory-`switch` in SourceManager. Die Online-Version ist genau ein
 * Filter ueber diese Tabelle. Siehe plans/ONLINE_MODE_PLAN.md §P1.
 */

import type { RawDecodeMode } from '../engine/raw/RawDecoderStrategy';
import { config } from '../platform/config';
import type { SourceTransportMode } from '../platform/sourceTransport';

export type SourceType =
  | 'local' | 'local-files' | 'immich' | 'immich-v3' | 'lychee' | 'webdav'
  | 'photoprism' | 'piwigo' | 'synology' | 'librephotos' | 'nextcloud-photos' | 'ente'
  | 'dropbox' | 'google-drive' | 'onedrive' | 'google-photos' | 'flickr' | 'smugmug' | 's3'
  | 'server-path' | 'ftp' | 'smb' | 'ssh' | 'nfs' | 'photolib-library';

/**
 * `browser-native` sind Quellen, deren Bytes den Browser nie verlassen
 * (File System Access API). Die beiden anderen Werte sind die Transportarten
 * einer HTTP-Quelle und decken sich mit `SourceTransportMode`.
 */
export type SourceTransport = SourceTransportMode | 'browser-native';
export type BackgroundThumbnailRoute = 'source-endpoint' | 'local-original' | 'none';

export interface SourceCapability {
  /**
   * Architektonisch, nicht Umsetzungsstand: braucht diese Quelle zwingend
   * einen Server, der etwas tut, das ein Browser nicht kann (Dateisystem,
   * SMB/NFS/SSH-Protokolle)?
   */
  requiresBackend: boolean;
  /** Beste Transportart, die der Code heute fuer diese Quelle beherrscht. */
  transport: SourceTransport;
  /** In der Quellenauswahl waehlbar (frueher `ENABLED_SOURCES`). */
  implemented: boolean;
  /**
   * Im Online-Build freigegeben. Nicht aus den anderen Feldern ableitbar:
   * eine browser-direct-faehige Quelle bleibt gesperrt, solange die
   * Ende-zu-Ende-Pruefung aus §P4 gegen eine echte Instanz aussteht.
   */
  onlineReady: boolean;
  /** Erlaubte RAW-Decoder, erster = Standard. */
  decodeModes: readonly RawDecodeMode[];
  /** Route a library-wide background pass may use for a small thumbnail. */
  backgroundThumbnail: BackgroundThumbnailRoute;
}

/** Quellen hinter dem Backend-Proxy duerfen den Smart Preview nutzen. */
const PROXY_DECODE_MODES: readonly RawDecodeMode[] = ['smart-preview', 'libraw-wasm'];
/** Quellen, deren Originale im Browser bleiben, dekodieren dort auch. */
const BROWSER_DECODE_MODES: readonly RawDecodeMode[] = ['libraw-wasm'];

const browserNative = (): SourceCapability => ({
  requiresBackend: false,
  transport: 'browser-native',
  implemented: true,
  onlineReady: true,
  decodeModes: BROWSER_DECODE_MODES,
  backgroundThumbnail: 'local-original',
});

/** Koennte prinzipiell direkt, ist es aber nicht — laeuft nur ueber den Proxy. */
const proxyOnly = (implemented = false): SourceCapability => ({
  requiresBackend: false,
  transport: 'server-proxy',
  implemented,
  onlineReady: false,
  decodeModes: PROXY_DECODE_MODES,
  backgroundThumbnail: 'source-endpoint',
});

/** Braucht zwingend einen Server — im Online-Build nur mit Selfhost erreichbar. */
const backendOnly = (implemented = false): SourceCapability => ({
  requiresBackend: true,
  transport: 'server-proxy',
  implemented,
  onlineReady: false,
  decodeModes: PROXY_DECODE_MODES,
  backgroundThumbnail: 'source-endpoint',
});

/** HTTP-Quelle, die der Browser direkt ansprechen kann (CORS am Nutzer-Server). */
const browserDirect = (onlineReady: boolean): SourceCapability => ({
  requiresBackend: false,
  transport: 'browser-direct',
  implemented: true,
  onlineReady,
  decodeModes: PROXY_DECODE_MODES,
  backgroundThumbnail: 'source-endpoint',
});

export const SOURCE_CAPABILITIES: Readonly<Record<SourceType, SourceCapability>> = {
  // ─── Browser-eigene Quellen ───
  'local': browserNative(),
  'local-files': browserNative(),

  // ─── Direkt aus dem Browser erreichbar ───
  // Sondierung 2026-09-05 gegen Test-Instanzen von Immich (v2, v3) und Lychee bestanden.
  'immich': browserDirect(true),
  'immich-v3': browserDirect(true),
  'lychee': browserDirect(true),
  // WebDAV beherrscht browser-direct (Transport-Umschalter im Selfhost-Build),
  // hat die Ende-zu-Ende-Pruefung aus §P4 aber nicht durchlaufen — es gibt
  // keine WebDAV-Testinstanz. Online gesperrt (Entscheidung 3), bis sie steht.
  'webdav': browserDirect(false),

  // ─── Koennten prinzipiell direkt, sind es aber nicht ───
  'photoprism': proxyOnly(),
  'piwigo': proxyOnly(),
  'synology': proxyOnly(),
  'librephotos': proxyOnly(),
  'nextcloud-photos': proxyOnly(),
  // Ente liefert verschluesselte Blobs; ohne die libsodium-Kette im Client
  // waeren die Bilder Rauschen (siehe AddSourceDialog). Code entfernt, Tag
  // attic/pre-deadcode-2026-09.
  'ente': proxyOnly(),
  'dropbox': proxyOnly(),
  'google-drive': proxyOnly(),
  'onedrive': proxyOnly(),
  'google-photos': proxyOnly(),
  'flickr': proxyOnly(),
  'smugmug': proxyOnly(),
  's3': { ...proxyOnly(), backgroundThumbnail: 'none' },

  // ─── Brauchen einen Server ───
  'server-path': backendOnly(),
  // FTP, SMB, SSH und NFS haben nie einen Backend-Endpunkt bekommen; Code
  // entfernt, Tag attic/pre-deadcode-2026-09. Die Typen bleiben, damit
  // Alt-Zeilen im Katalog ihren Namen behalten und loeschbar bleiben.
  'ftp': backendOnly(),
  'smb': backendOnly(),
  'ssh': backendOnly(),
  'nfs': backendOnly(),
  'photolib-library': backendOnly(true),
};

export const SOURCE_TYPES = Object.keys(SOURCE_CAPABILITIES) as SourceType[];

export function isKnownSourceType(type: string | null | undefined): type is SourceType {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(SOURCE_CAPABILITIES, type);
}

export function sourceCapability(type: string | null | undefined): SourceCapability | null {
  return isKnownSourceType(type) ? SOURCE_CAPABILITIES[type] : null;
}

/**
 * What the source picker shows for a source in this build (§P2).
 *
 * `coming-soon` used to be the answer for everything outside ENABLED_SOURCES,
 * which promised SMB and NFS a browser future they will never have. The three
 * states separate "not built yet" from "built, but needs a server".
 */
export type SourceAvailability = 'available' | 'selfhost-only' | 'coming-soon';

export function sourceAvailability(
  type: SourceType,
  mode: 'hosted' | 'online' = config.mode,
): SourceAvailability {
  const cap = SOURCE_CAPABILITIES[type];
  if (cap.implemented && (mode === 'hosted' || cap.onlineReady)) return 'available';
  // Online, a source is server-bound either architecturally (SMB, FTP) or
  // because only its proxy path is proven (WebDAV, until §P4 is measured).
  if (mode === 'online' && (cap.requiresBackend || cap.implemented)) return 'selfhost-only';
  return 'coming-soon';
}
