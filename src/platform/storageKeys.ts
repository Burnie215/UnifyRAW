/**
 * Every browser-storage key this app owns, in one table.
 *
 * Two keys used to be spelled out twice - 'photolib.storage.sync' in api.ts
 * and StorageContext, 'photolib-lang' in i18n and StorageTab - so a change to
 * one side silently disarmed the other (F133). A key lives here; the code that
 * reads and writes its value stays with its feature.
 *
 * The three prefixes ('photolib-', 'photolib.', 'photolib:') stay as they are:
 * CLAUDE.md keeps the `photolib` namespace deliberately as legacy, and renaming
 * would cost a migration per key without buying anything this table does not
 * already give.
 */

/** localStorage keys. The comment says what the stored value looks like. */
export const STORAGE_KEYS = {
  /** `{ serverUrl, token? }` - read and written only by storage/syncSettings.ts. */
  syncSettings: 'photolib.storage.sync',
  /** `{ kind, explicit }` - which catalog storage the user picked. */
  storagePref: 'photolib.storage.pref',
  /** 'de' | 'en' - written by i18n, also read by i18next's language detector. */
  language: 'photolib-lang',
  /** `Partial<Brand>` - white-label override of the product brand. */
  brandOverride: 'photolib.brand.override',
  /** '1' once persistent storage has been asked for in this profile. */
  persistenceAsked: 'photolib.storage.persistenceAsked',
  /** '1' once the one-time linear-math migration toast has been shown. */
  phase2MigrationToastShown: 'photolib.phase2.migrationToastShown',
  /** '1' once the alpha notice has been acknowledged in this profile. */
  alphaNoticeAcknowledged: 'photolib.alphaNoticeAcknowledged',
  /** 'auto' | 'desktop' | 'tablet' | 'phone' - manual layout override. */
  uiModeOverride: 'photolib.uiModeOverride',
  /** Backend origin set under Settings; empty means same origin. */
  backendUrl: 'photolib.backendUrl',
  /** 'smart-preview' | 'libraw-wasm' - preferred RAW decoder. */
  rawDecodeMode: 'photolib.rawDecodeMode',
  /** Long edge of the smart preview, one of SMART_PREVIEW_SIZES. */
  rawDecodeSize: 'photolib.rawDecodeSize',
  /** OutputColorSpaceId of the export/display colour space. */
  outputColorSpace: 'photolib.outputColorSpace',
  /** '1' once the one-off purge of non-sRGB edit thumbnails has run. */
  thumbsSrgbMigrated: 'photolib.thumbs.srgb-v1',
  /** `{ enabled, max }` - in-memory thumbnail cache budget. */
  thumbMemCacheConfig: 'photolib-memcache-config',
  /** `PanelLayout` - zones, collapsed and floating panels. */
  panelLayout: 'photolib-panel-layout',
  /** `ImportPreset` - defaults applied to imported photos. */
  importPreset: 'photolib-import-preset',
  /** `UiPreferences` - font size, accent, theme, sidebar width. */
  uiPreferences: 'photolib-ui-prefs',
  /** 'jpeg' | 'lossless' | 'linear16' - HEIF decode mode. */
  heifMode: 'photolib-heif-mode',
  /** Licence JWT. Dead while LICENSING_ENABLED is false (F047). */
  license: 'photolib-license',
  /** Number of grid rows rendered beyond the viewport. */
  gridBuffer: 'photolib-grid-buffer',
  /** '1' enables the performance logger across reloads. */
  perfLog: 'photolib-perf',
  /** 'true' | 'false' - sidebar source list expanded. */
  sidebarSourcesExpanded: 'photolib-sourcesExpanded',
  /** 'true' | 'false' - sidebar folder tree expanded. */
  sidebarTreeExpanded: 'photolib-treeExpanded',
  /** `Record<string, boolean>` - open sections of the graph node library. */
  graphLibrarySections: 'photolib-graph-library-sections',
} as const;

/**
 * sessionStorage, not localStorage: the chunk-recovery cooldown must not
 * survive the tab that hit the stale deployment.
 */
export const SESSION_KEYS = {
  /** Epoch ms of the last automatic reload after a vite:preloadError. */
  staleAssetReload: 'photolib:stale-asset-reload',
} as const;

/**
 * Prefix of every key usePersistedState owns. Those keys are named at the call
 * site (`usePersistedState('gridMode', …)`), so the prefix covers them instead
 * of one entry each.
 */
export const PERSISTED_STATE_PREFIX = 'photolib-';

/**
 * Drop every setting this app stores in the browser. Deliberately does NOT
 * touch the catalog itself (OPFS, picked folder, IndexedDB handles): losing
 * settings is an annoyance, losing the catalog is data loss, and the two do
 * not belong behind one button.
 */
export function resetAllStorageKeys(): void {
  try {
    for (const key of Object.values(STORAGE_KEYS)) localStorage.removeItem(key);
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PERSISTED_STATE_PREFIX)) localStorage.removeItem(key);
    }
  } catch { /* storage unavailable - nothing stored, nothing to reset */ }
  try {
    for (const key of Object.values(SESSION_KEYS)) sessionStorage.removeItem(key);
  } catch { /* same */ }
}

/**
 * True if this browser profile already holds state of this app. Asked by
 * one-time notices that must not fire on a fresh profile.
 */
export function hasStoredAppState(ignore: readonly string[] = []): boolean {
  try {
    const owned = new Set<string>(Object.values(STORAGE_KEYS));
    return Object.keys(localStorage).some((key) => !ignore.includes(key)
      && (owned.has(key) || key.startsWith(PERSISTED_STATE_PREFIX)));
  } catch {
    return false;
  }
}
