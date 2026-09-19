/* eslint-disable react-refresh/only-export-components -- Storage hooks and provider share lifecycle-sensitive module state. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FolderStorage,
  isFileSystemAccessSupported,
  isOPFSSupported,
  MemoryStorage,
  pickCatalogFolder,
  type CatalogStorage,
  type StorageKind,
  SyncedStorage,
  type SyncCycleResult,
  type SyncSettings,
} from '../storage';
import {
  clearCatalogHandle,
  ensureHandlePermission,
  loadCatalogHandle,
  saveCatalogHandle,
} from '../storage/handleStore';
import { config } from '../platform/config';
import { STORAGE_KEYS } from '../platform/storageKeys';
import { readSyncSettings, writeSyncSettings } from '../storage/syncSettings';
import { defaultSyncSettings } from './storageDefaults';
import { buildRepositories, type Repositories } from '../storage/repos';
import { bumpRevision, bumpRevisions, createRevisions, pulledTables, type StorageRevisions } from './storageRevisions';
import { setActiveRepos } from '../storage/activeRepos';
import { migrateThumbnailsToSrgb } from '../cache/thumbnailSrgbMigration';
import { catalogLockName, waitForCatalogLock } from '../storage/catalogLock';
import { prepareImportedCatalog, CatalogImportError } from '../storage/importCatalog';
import { readPersistence, requestPersistence, type PersistenceState } from '../storage/persistentStorage';
import {
  shouldAskForPersistence,
  switchLeavesCatalogBehind,
  type OnboardingReason,
} from '../components/storageOptions';
import { attachLifecycleFlush } from '../storage/lifecycleFlush';
import { sourceManager } from '../sources/SourceManager';
import type { PassphraseRequest } from '../components/PassphraseDialog';

const PREF_KEY = STORAGE_KEYS.storagePref;

interface StoragePref {
  kind: StorageKind;
  /** True if the user has made an explicit pick (overrides auto-default). */
  explicit: boolean;
}

function loadPref(): StoragePref | null {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (raw) return JSON.parse(raw) as StoragePref;
  } catch { /* */ }
  return null;
}

function savePref(pref: StoragePref): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(pref)); } catch { /* */ }
}

const PERSISTENCE_ASKED_KEY = STORAGE_KEYS.persistenceAsked;

function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function writeFlag(key: string): void {
  try { localStorage.setItem(key, '1'); } catch { /* */ }
}

/** What to tell the user about a file that cannot become their catalog. */
function importErrorMessage(error: unknown, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (error instanceof CatalogImportError) {
    if (error.reason === 'newer-schema') {
      return t('storage.importNewerSchema', { version: error.foundVersion ?? '?' });
    }
    if (error.reason === 'not-sqlite') return t('storage.importNotSqlite');
    return t('storage.importNotCatalog');
  }
  return (error as Error).message;
}

// passphrasePromptRef gets wired into the provider; non-React callers (open
// flow, encryption toggle) call this via the context value rather than
// poking at a singleton.

/**
 * True if `root` is the catalog already open here. Opening it a second time
 * would find this tab's own lock taken and come up read-only.
 */
async function isOpenCatalog(current: CatalogStorage | null, kind: StorageKind, root: FileSystemDirectoryHandle): Promise<boolean> {
  const currentRoot = current?.info.kind === kind ? current.getRootHandle?.() : null;
  return !!currentRoot && await currentRoot.isSameEntry(root);
}

/** A catalog or thumbnail write that failed; the flush throttle keeps retrying it. */
export interface CatalogWriteError {
  name: string;
  message: string;
  at: number;
}

function describeWriteError(error: unknown): CatalogWriteError {
  const e = (error ?? {}) as { name?: unknown; message?: unknown };
  return {
    name: typeof e.name === 'string' && e.name ? e.name : 'Error',
    message: typeof e.message === 'string' ? e.message : String(error),
    at: Date.now(),
  };
}

export interface StorageContextValue {
  /** Currently opened catalog storage, null while opening. */
  storage: CatalogStorage | null;
  /** Repositories scoped to the active storage; null if storage is null. */
  repos: Repositories | null;
  /** True if the user has explicitly chosen a storage (vs. auto-OPFS-default). */
  explicit: boolean;
  /** Why the storage dialog is up, or null while it is not. */
  showOnboarding: OnboardingReason | null;
  setShowOnboarding: (reason: OnboardingReason | null) => void;
  openError: string | null;
  opening: boolean;
  /** Another tab holds the catalog; nothing this tab changes is saved. */
  readOnly: boolean;
  /** Read-only, and the holding tab has let go since: a reload takes the catalog over. */
  catalogLockFree: boolean;
  /** The last write of the open catalog failed; cleared by the next successful flush. */
  flushError: CatalogWriteError | null;
  /** Retry the flush now. Call from a click: a picked folder may need its permission again. */
  retryFlush: () => Promise<void>;

  caps: { filesystem: boolean; opfs: boolean };

  /** What the browser promises about an OPFS catalog; 'unknown' elsewhere. */
  persistence: PersistenceState;

  openFilesystem: () => Promise<void>;
  openOPFS: () => Promise<void>;
  openMemory: () => Promise<void>;
  /** Install a downloaded catalog into the open folder. True once it is live. */
  importCatalog: (file: File) => Promise<boolean>;
  reset: () => Promise<void>;

  sync: SyncSettings | null;
  setSync: (s: SyncSettings | null) => void;
  syncNow: () => Promise<SyncCycleResult | null>;
  /** Send the whole catalog to the hub again, then sync. */
  resendAll: () => Promise<SyncCycleResult | null>;
  syncing: boolean;
  lastSyncResult: SyncCycleResult | null;
  /** The hub refused the stored token, so it was dropped: ask for a sign-in again. */
  syncSessionExpired: boolean;

  /** Current passphrase dialog request, if any. */
  passphraseRequest: PassphraseRequest | null;
  /** Open the passphrase dialog and resolve with the user's input (or null). */
  requestPassphrase: (opts: Omit<PassphraseRequest, 'resolve'>) => Promise<string | null>;
}

const StorageContext = createContext<StorageContextValue | null>(null);
const StorageRevisionsContext = createContext<StorageRevisions | null>(null);

export function useStorage(): StorageContextValue {
  const ctx = useContext(StorageContext);
  if (!ctx) throw new Error('useStorage must be used inside <StorageProvider>');
  return ctx;
}

/**
 * One write counter per catalog table. Kept out of StorageContext so a write
 * only wakes consumers that explicitly subscribe to catalog revisions.
 */
export function useStorageRevisions(): StorageRevisions {
  const revisions = useContext(StorageRevisionsContext);
  if (!revisions) throw new Error('useStorageRevisions must be used inside <StorageProvider>');
  return revisions;
}

/**
 * Convenience: returns repositories or throws. Components that render only
 * inside a ready-storage tree (App.tsx splash gate enforces this) can use
 * this without null-checking on every call.
 */
export function useRepos(): Repositories {
  const { repos } = useStorage();
  if (!repos) throw new Error('useRepos: storage not ready yet');
  return repos;
}

export function StorageProvider({ children }: { children: React.ReactNode }) {
  const [storage, setStorage] = useState<CatalogStorage | null>(null);
  const [explicit, setExplicit] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState(true);
  const [revisions, setRevisions] = useState<StorageRevisions>(createRevisions);
  const [sync, setSyncState] = useState<SyncSettings | null>(() => {
    const fromStorage = readSyncSettings();
    if (fromStorage) return fromStorage;
    return defaultSyncSettings(config, typeof window !== 'undefined' ? window.location.origin : null);
  });
  const [syncing, setSyncing] = useState(false);
  const [syncSessionExpired, setSyncSessionExpired] = useState(false);
  const [lastSyncResult, setLastSyncResult] = useState<SyncCycleResult | null>(null);
  const [showOnboarding, setShowOnboarding] = useState<OnboardingReason | null>(null);
  const [persistence, setPersistence] = useState<PersistenceState>('unknown');
  const [passphraseRequest, setPassphraseRequest] = useState<PassphraseRequest | null>(null);
  const { t } = useTranslation();

  const requestPassphrase = useCallback((opts: Omit<PassphraseRequest, 'resolve'>): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      setPassphraseRequest({
        ...opts,
        resolve: (value) => {
          setPassphraseRequest(null);
          resolve(value);
        },
      });
    });
  }, []);

  const passphraseProviderRef = useRef<() => Promise<string | null>>(() =>
    requestPassphrase({
      title: t('dialogs.passphrase.catalogTitle'),
      description: t('dialogs.passphrase.catalogDescription'),
    })
  );
  // Keep the ref aimed at the latest closure so async callbacks always
  // hit the current state setter.
  useEffect(() => {
    passphraseProviderRef.current = () => requestPassphrase({
      title: t('dialogs.passphrase.catalogTitle'),
      description: t('dialogs.passphrase.catalogDescription'),
    });
  }, [requestPassphrase, t]);

  const promptPassphrase = useCallback(() => passphraseProviderRef.current(), []);

  const syncedRef = useRef<SyncedStorage | null>(null);

  const caps = useMemo(() => ({
    filesystem: isFileSystemAccessSupported(),
    opfs: isOPFSSupported(),
  }), []);

  // The singletons are rewired during render on purpose: child effects
  // (useSources -> sourceManager.reconnectAll) run before any effect of this
  // provider and must already see the new repositories.
  const repos = useMemo<Repositories | null>(() => {
    if (!storage) {
      sourceManager.setRepos(null);
      setActiveRepos(null);
      return null;
    }
    const r = buildRepositories(storage, (table) => setRevisions((rev) => bumpRevision(rev, table)));
    sourceManager.setRepos(r);
    setActiveRepos(r);
    return r;
  }, [storage]);

  const [lockFreeFor, setLockFreeFor] = useState<CatalogStorage | null>(null);
  const readOnly = storage?.info.readOnly === true;
  const catalogLockFree = readOnly && lockFreeFor === storage;

  useEffect(() => {
    const root = storage?.info.readOnly ? storage.getRootHandle?.() : null;
    if (!storage || !root) return;
    const controller = new AbortController();
    waitForCatalogLock(catalogLockName(storage.info.kind, root), controller.signal)
      .then(() => setLockFreeFor(storage))
      .catch(() => undefined);
    return () => controller.abort();
  }, [storage]);

  // The previous storage closes only after the new one is committed: until
  // then the singletons above still hand out its repositories, and its
  // close() persists whatever they wrote in the meantime. Closes chain, so a
  // quick double switch closes in order.
  const previousStorageRef = useRef<CatalogStorage | null>(null);
  const closingRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const prev = previousStorageRef.current;
    previousStorageRef.current = storage;
    if (!prev || prev === storage) return;
    closingRef.current = closingRef.current
      .then(() => prev.close())
      .catch((e) => console.warn('[storage] close failed', e));
  }, [storage]);

  useEffect(() => (storage ? attachLifecycleFlush(storage) : undefined), [storage]);

  // What the browser promises about this catalog, and the one moment it is
  // worth asking for more. OPFS starts out evictable, and the ask is a
  // permission prompt in Firefox - so it waits for a catalog with photos in
  // it, where a refusal is worth knowing about and a grant worth having.
  useEffect(() => {
    let cancelled = false;
    void readPersistence().then((state) => { if (!cancelled) setPersistence(state); });
    return () => { cancelled = true; };
  }, [storage]);

  useEffect(() => {
    if (!repos || !storage) return;
    const askedBefore = readFlag(PERSISTENCE_ASKED_KEY);
    if (!shouldAskForPersistence(storage.info.kind, repos.photos.count(), askedBefore)) return;
    writeFlag(PERSISTENCE_ASKED_KEY);
    let cancelled = false;
    void requestPersistence().then((state) => { if (!cancelled) setPersistence(state); });
    return () => { cancelled = true; };
  }, [repos, storage, revisions.photos]);

  // Developed thumbnails render in sRGB since 2026-09-12 (F124). A profile
  // that had a wider output space set has them baked in a space no gallery
  // tile ever displayed, so they are dropped once, here, where a catalog has
  // just been opened and its repositories exist. A read-only tab is skipped
  // on purpose: its deletes are no-ops, and it would leave the marker behind
  // for the tab that owns the catalog.
  useEffect(() => {
    if (!repos || readOnly) return;
    void migrateThumbnailsToSrgb(repos)
      .catch((e) => console.warn('[storage] sRGB thumbnail migration failed', e));
  }, [repos, readOnly]);

  const [writeFailure, setWriteFailure] = useState<{ storage: CatalogStorage; error: CatalogWriteError } | null>(null);
  const flushError = writeFailure?.storage === storage ? writeFailure.error : null;

  useEffect(() => {
    if (!storage?.on) return;
    const offError = storage.on('error', ({ error, op }) => {
      if (op !== 'flush' && op !== 'thumb-write') return;
      setWriteFailure({ storage, error: describeWriteError(error) });
    });
    const offFlush = storage.on('flush', () => {
      setWriteFailure((current) => (current?.storage === storage ? null : current));
    });
    return () => { offError(); offFlush(); };
  }, [storage]);

  const retryFlush = useCallback(async () => {
    if (!storage) return;
    const root = storage.info.kind === 'filesystem' ? storage.getRootHandle?.() : null;
    // First, while the click's user activation lasts: requestPermission needs it.
    if (root && !await ensureHandlePermission(root)) return;
    await storage.flushNow();
  }, [storage]);

  // Initial open: prefer last user choice, otherwise auto-OPFS.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pref = loadPref();
        if (pref) {
          setExplicit(pref.explicit);
          await openFromPref(pref);
        } else if (isOPFSSupported()) {
          // No prior choice: ask. Opening browser storage unasked was the
          // quiet answer, and it left every user in the one tier the browser
          // is allowed to clear without telling anyone.
          setShowOnboarding('first-run');
        } else {
          // Browser too old for OPFS — show onboarding for Memory or FS pick.
          setShowOnboarding('no-durable-storage');
        }
      } catch (e) {
        if (!cancelled) setOpenError((e as Error).message);
      } finally {
        if (!cancelled) setOpening(false);
      }
    })();
    async function openFromPref(pref: StoragePref): Promise<void> {
      if (pref.kind === 'filesystem') {
        const handle = await loadCatalogHandle();
        if (!handle || !await ensureHandlePermission(handle)) {
          setOpenError(t('storage.folderUnreachable'));
          setShowOnboarding('folder-lost');
          return;
        }
        const s = await FolderStorage.open(handle, 'filesystem', { passphraseProvider: promptPassphrase });
        if (!cancelled) setStorage(s);
      } else if (pref.kind === 'opfs') {
        const root = await navigator.storage.getDirectory();
        const s = await FolderStorage.open(root, 'opfs', { passphraseProvider: promptPassphrase });
        if (!cancelled) setStorage(s);
      } else {
        const s = await MemoryStorage.create();
        if (!cancelled) setStorage(s);
      }
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!storage || !sync?.serverUrl) {
      syncedRef.current = null;
      return;
    }
    syncedRef.current = new SyncedStorage(storage, sync, {
      onAfterPull: async (merged) => {
        // Pull merged new rows directly into sql.js, bypassing the repos and
        // their per-table bump — so bump every table the pull actually
        // changed here, or the hooks reading those tables would never see the
        // pulled rows. Then re-run reconnectAll() so newly-pulled sources get
        // a SourceProvider.
        setRevisions((r) => bumpRevisions(r, pulledTables(merged)));
        if ((merged.sources ?? 0) > 0) {
          try { await sourceManager.reconnectAll(); } catch { /* */ }
        }
      },
      // Edit thumbs aren't synced (would inflate bandwidth + need encrypted
      // blob storage). Instead trigger a local background render on this
      // device — same adjustments + same source = same pixels.
      onEditPulled: (edit) => {
        void import('../engine/ThumbnailRenderer').then((mod) => {
          mod.queueEditThumbnail(edit.contentHash, edit.adjustments, edit.document ?? undefined);
        }).catch(() => { /* */ });
      },
      // The hub refused this token: keeping it would only repeat the same
      // 401 every 30s behind a UI that claims to be signed in.
      onUnauthorized: () => {
        const next = { ...sync, token: undefined };
        setSyncSessionExpired(true);
        setSyncState(next);
        writeSyncSettings(next);
      },
    });
  }, [storage, sync]);

  // Auto-sync polling: when sync is configured + a token is set, run a
  // cycle every 30s + one immediately. Stops cleanly when sync goes away.
  useEffect(() => {
    if (!syncedRef.current || !sync?.token) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight || !syncedRef.current) return;
      inFlight = true;
      try {
        setSyncing(true);
        const result = await syncedRef.current.sync();
        if (!cancelled) setLastSyncResult(result);
      } catch { /* surfaced via lastSyncResult.errors */ }
      finally {
        inFlight = false;
        if (!cancelled) setSyncing(false);
      }
    };
    // first tick immediately so login → catalog feels instant
    void tick();
    const id = setInterval(() => { void tick(); }, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [storage, sync?.serverUrl, sync?.token]);

  /**
   * Asks before a switch that leaves the open catalog where it is. A window
   * confirm rather than a dialog component on purpose: it is the same
   * question the storage tab already asks before resetting local settings,
   * and it has to block the open that follows it.
   */
  const confirmSwitch = useCallback((target: StorageKind): boolean => {
    const photos = repos?.photos.count() ?? 0;
    if (!switchLeavesCatalogBehind(storage?.info.kind ?? null, target, photos)) return true;
    return confirm(t('storage.switchLeavesBehindConfirm', { photos, label: storage?.info.label ?? '' }));
  }, [repos, storage, t]);

  const openFilesystem = useCallback(async () => {
    setOpening(true);
    setOpenError(null);
    try {
      const handle = await pickCatalogFolder();
      if (!handle) { setOpening(false); return; }
      // After the picker, not before: showDirectoryPicker needs the click's
      // user activation, and a modal in between is no place to spend it.
      if (!await isOpenCatalog(storage, 'filesystem', handle)) {
        if (!confirmSwitch('filesystem')) { setOpening(false); return; }
        // A catalog still closing holds its lock; opening it now would come up read-only.
        await closingRef.current;
        const s = await FolderStorage.open(handle, 'filesystem', { passphraseProvider: promptPassphrase });
        await saveCatalogHandle(handle);
        setStorage(s);
      }
      const next = { kind: 'filesystem' as const, explicit: true };
      setExplicit(true); savePref(next);
      setShowOnboarding(null);
    } catch (e) {
      setOpenError((e as Error).message);
    } finally {
      setOpening(false);
    }
  }, [storage, promptPassphrase, confirmSwitch]);

  const openOPFS = useCallback(async () => {
    if (!confirmSwitch('opfs')) return;
    setOpening(true); setOpenError(null);
    try {
      const root = await navigator.storage.getDirectory();
      if (!await isOpenCatalog(storage, 'opfs', root)) {
        await closingRef.current;
        const s = await FolderStorage.open(root, 'opfs', { passphraseProvider: promptPassphrase });
        setStorage(s);
      }
      const next = { kind: 'opfs' as const, explicit: true };
      setExplicit(true); savePref(next);
      setShowOnboarding(null);
    } catch (e) {
      setOpenError((e as Error).message);
    } finally {
      setOpening(false);
    }
  }, [storage, promptPassphrase, confirmSwitch]);

  const openMemory = useCallback(async () => {
    if (!confirmSwitch('memory')) return;
    setOpening(true); setOpenError(null);
    try {
      const s = await MemoryStorage.create();
      setStorage(s);
      const next = { kind: 'memory' as const, explicit: true };
      setExplicit(true); savePref(next);
      setShowOnboarding(null);
    } catch (e) {
      setOpenError((e as Error).message);
    } finally {
      setOpening(false);
    }
  }, [confirmSwitch]);

  /**
   * Installs a downloaded catalog into the folder that is open.
   *
   * The bytes go in through the open storage, which still holds the cipher and
   * the lock, and the folder is then opened again so every repository is built
   * against the catalog that now lies there. Memory has no file to replace,
   * and a read-only tab must not write one.
   */
  const importCatalog = useCallback(async (file: File): Promise<boolean> => {
    if (!(storage instanceof FolderStorage) || readOnly) return false;
    setOpenError(null);
    const root = storage.getRootHandle();
    const kind = storage.info.kind;
    let prepared;
    try {
      prepared = await prepareImportedCatalog(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      setOpenError(importErrorMessage(e, t));
      return false;
    }
    const here = repos?.photos.count() ?? 0;
    if (!confirm(t('storage.importConfirm', { photos: prepared.photos, current: here }))) return false;

    setOpening(true);
    try {
      await storage.replaceCatalogWith(prepared.bytes);
      // Straight to the reopened storage, without a null in between: dropping
      // the catalog would unmount the app around this dialog, and the user
      // would never see what the import did.
      setStorage(await FolderStorage.open(root, kind, { passphraseProvider: promptPassphrase }));
      return true;
    } catch (e) {
      setOpenError((e as Error).message);
      return false;
    } finally {
      setOpening(false);
    }
  }, [storage, readOnly, repos, promptPassphrase, t]);

  const reset = useCallback(async () => {
    setStorage(null);
    await clearCatalogHandle().catch(() => undefined);
    try { localStorage.removeItem(PREF_KEY); } catch { /* */ }
    setExplicit(false);
    setOpenError(null);
    setShowOnboarding('switch');
  }, []);

  const setSync = useCallback((s: SyncSettings | null) => {
    if (s?.token) setSyncSessionExpired(false);
    setSyncState(s);
    writeSyncSettings(s);
  }, []);

  const syncNow = useCallback(async (): Promise<SyncCycleResult | null> => {
    if (!syncedRef.current) return null;
    setSyncing(true);
    try {
      const result = await syncedRef.current.sync();
      setLastSyncResult(result);
      return result;
    } finally {
      setSyncing(false);
    }
  }, []);

  const resendAll = useCallback(async (): Promise<SyncCycleResult | null> => {
    if (!syncedRef.current) return null;
    setSyncing(true);
    try {
      const result = await syncedRef.current.resendAll();
      setLastSyncResult(result);
      return result;
    } finally {
      setSyncing(false);
    }
  }, []);

  const value = useMemo<StorageContextValue>(() => ({
    storage,
    repos,
    explicit,
    showOnboarding,
    setShowOnboarding,
    openError,
    opening,
    readOnly,
    catalogLockFree,
    flushError,
    retryFlush,
    caps,
    persistence,
    openFilesystem,
    openOPFS,
    openMemory,
    importCatalog,
    reset,
    sync,
    setSync,
    syncNow,
    resendAll,
    syncing,
    lastSyncResult,
    syncSessionExpired,
    passphraseRequest,
    requestPassphrase,
  }), [storage, repos, explicit, showOnboarding, openError, opening, readOnly, catalogLockFree, flushError, retryFlush, caps, persistence, openFilesystem, openOPFS, openMemory, importCatalog, reset, sync, setSync, syncNow, resendAll, syncing, lastSyncResult, syncSessionExpired, passphraseRequest, requestPassphrase]);

  return (
    <StorageRevisionsContext.Provider value={revisions}>
      <StorageContext.Provider value={value}>{children}</StorageContext.Provider>
    </StorageRevisionsContext.Provider>
  );
}
