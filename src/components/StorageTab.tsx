import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStorage } from '../contexts/StorageContext';
import { compactThumbBins, type CompactResult, type StorageKind } from '../storage';
import { FolderStorage } from '../storage/FolderStorage';
import { downloadCatalog } from '../storage/downloadCatalog';
import { pruneRetiredEditThumbs } from '../storage/pruneRetiredEditThumbs';
import { getLanguage } from '../i18n';
import { resetAllStorageKeys } from '../platform/storageKeys';
import { syncTokenUsername } from '../platform/syncToken';
import { activeStorageTier, memoryCatalogOffered, serverTierState, storageCalloutKey } from './storageOptions';
import {
  describeProbeError,
  describeProbeResponse,
  probeHealthUrl,
  validateHubUrl,
  type ProbeState,
} from './settings/serverProbe';
import { ServerSection } from './settings/ServerSection';
import { SyncAccountSecurity } from './SyncAccountSecurity';
import './StorageTab.css';

/**
 * Storage tab — replaces the previous Catalog + Sync tabs.
 *
 * Top section: where the catalog lives.
 * Bottom section: optional sync against a hub.
 */
export function StorageTab() {
  const { t } = useTranslation();
  const {
    storage, repos, explicit, caps, opening, openError,
    openFilesystem, openOPFS, openMemory, reset,
    sync, setSync, syncNow, resendAll, syncing, lastSyncResult, syncSessionExpired,
    setShowOnboarding,
    requestPassphrase,
    readOnly,
    flushError,
    persistence,
    importCatalog,
  } = useStorage();

  const [syncMode, setSyncMode] = useState<'login' | 'register'>('login');
  const [syncUser, setSyncUser] = useState('');
  const [syncPass, setSyncPass] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [hubCheck, setHubCheck] = useState<ProbeState>({ kind: 'idle' });
  const [compacting, setCompacting] = useState(false);
  const [lastCompact, setLastCompact] = useState<CompactResult | null>(null);
  const [lastPruned, setLastPruned] = useState(0);
  const [encryptBusy, setEncryptBusy] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [encryptError, setEncryptError] = useState<string | null>(null);
  // Force re-render after toggle (FolderStorage.isEncrypted() return value changes).
  const [encVersion, bumpEnc] = useState(0);
  void encVersion;

  // Row-level errors: the rest of the table went through, these rows wait for their next local write.
  const skippedRows = lastSyncResult?.errors.filter((error) => error.key !== undefined).length ?? 0;

  const currentKind: StorageKind | null = storage?.info.kind ?? null;
  // The same three tiers the storage dialog offers, so the settings do not
  // describe the arrangement in different words than the choice did.
  const tier = activeStorageTier(currentKind, sync ?? null);
  const calloutKey = storageCalloutKey(tier, serverTierState(sync ?? null));
  const isEphemeral = currentKind === 'memory';
  const effectiveSyncMode = registrationEnabled ? syncMode : 'login';
  const accountName = syncTokenUsername(sync?.token);

  const pageOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  // Unlike the server field above, the page's own origin is a valid hub: the
  // self-hosted build serves /api/sync from exactly there.
  const hubUrl = validateHubUrl(sync?.serverUrl ?? '', pageOrigin);

  /**
   * Ask the hub whether it is there, before the login does it for the user.
   *
   * Without this the first sign that an address is wrong is a failed login,
   * whose message describes the credentials rather than the address.
   */
  const runHubCheck = async () => {
    if (!hubUrl.ok) return;
    setHubCheck({ kind: 'checking' });
    try {
      const response = await fetch(probeHealthUrl(hubUrl.url), { mode: 'cors' });
      const body: unknown = await response.json().catch(() => null);
      setHubCheck(describeProbeResponse(response.ok, response.status, body));
    } catch (error) {
      setHubCheck(describeProbeError(error));
    }
  };

  useEffect(() => {
    if (!sync?.serverUrl) return;
    const controller = new AbortController();
    const serverUrl = sync.serverUrl.replace(/\/+$/, '');
    void fetch(`${serverUrl}/api/auth/config`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return false;
        const config = await response.json() as { registrationEnabled?: unknown };
        return config.registrationEnabled === true;
      })
      .then(setRegistrationEnabled)
      .catch(() => setRegistrationEnabled(false));
    return () => controller.abort();
  }, [sync?.serverUrl]);

  const exportSnapshot = () => {
    if (storage) downloadCatalog(storage);
  };

  const submitAuth = async () => {
    if (!sync?.serverUrl || !syncUser || syncPass.length < 8) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      const url = `${sync.serverUrl.replace(/\/+$/, '')}/api/auth/${effectiveSyncMode}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept-Language': getLanguage(),
        },
        body: JSON.stringify({ username: syncUser, password: syncPass }),
      });
      const data = await res.json() as { token?: string; error?: string };
      if (!res.ok || !data.token) {
        setAuthError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setSync({ ...sync, token: data.token });
      setSyncPass('');
    } catch (e) {
      setAuthError((e as Error).message);
    } finally {
      setAuthBusy(false);
    }
  };

  const logout = () => {
    if (sync) setSync({ ...sync, token: undefined });
    setSyncUser('');
    setSyncPass('');
    setAuthError(null);
  };

  return (
    <div className="settings-section storage-tab">
      <h3>{t('storage.heading')}</h3>
      <p className="settings-hint">{t('storage.hint')}</p>

      {calloutKey && (
        <div className="storage-tab-callout">
          {t(calloutKey)}
          <button
            className="settings-btn-text"
            style={{ marginLeft: 12 }}
            onClick={() => setShowOnboarding('switch')}>
            {t('storage.chooseStorage')}
          </button>
        </div>
      )}

      <div className="storage-tab-options">
        {caps.filesystem && (
          <KindRow
            label={t('firstLaunch.tierFolder')}
            active={currentKind === 'filesystem'}
            sub={currentKind === 'filesystem' ? t('storage.ownFolderFolder', { name: storage?.info.label }) : t('storage.ownFolderBrowsers')}
            actionLabel={currentKind === 'filesystem' ? t('storage.chooseOtherFolder') : t('storage.chooseFolder')}
            onAction={openFilesystem}
            busy={opening}
          />
        )}
        {caps.opfs && (
          <KindRow
            label={t('firstLaunch.tierTrial')}
            active={currentKind === 'opfs'}
            sub={currentKind === 'opfs' ? t('storage.opfsActiveSub') : t('storage.opfsInactiveSub')}
            actionLabel={currentKind === 'opfs' ? t('storage.opfsAlreadyActive') : t('storage.useOpfs')}
            onAction={openOPFS}
            busy={opening}
            disabled={currentKind === 'opfs'}
          />
        )}
        {memoryCatalogOffered(caps, currentKind) && (
          <KindRow
            label={t('storage.memoryLabel')}
            active={currentKind === 'memory'}
            sub={currentKind === 'memory' ? t('storage.memoryActiveSub') : t('storage.memoryInactiveSub')}
            actionLabel={currentKind === 'memory' ? t('storage.memoryAlreadyActive') : t('storage.useMemory')}
            onAction={openMemory}
            busy={opening}
            disabled={currentKind === 'memory'}
          />
        )}
      </div>

      {storage && (
        <div className="storage-tab-status">
          <div className="storage-tab-status-row">
            <span className="storage-tab-status-label">{t('storage.active')}</span>
            <span className="storage-tab-status-value">
              {/* The folder name says which catalog; "Origin Private File
                  System" says nothing a user can act on. */}
              {currentKind === 'filesystem'
                ? `${labelForKind(currentKind, t)} — ${storage.info.label}`
                : labelForKind(currentKind!, t)}
            </span>
          </div>
          {readOnly && (
            <div className="storage-tab-status-row">
              <span className="storage-tab-status-label">{t('storage.accessLabel')}</span>
              <span className="storage-tab-status-value storage-tab-warn">{t('storage.readOnlyOtherTab')}</span>
            </div>
          )}
          {currentKind === 'opfs' && persistence !== 'unknown' && (
            <div className="storage-tab-status-row">
              <span className="storage-tab-status-label">{t('storage.persistenceLabel')}</span>
              <span className={`storage-tab-status-value ${persistence === 'persistent' ? '' : 'storage-tab-warn'}`}>
                {persistence === 'persistent' ? t('storage.persistenceGranted') : t('storage.persistenceBestEffort')}
              </span>
            </div>
          )}
          {storage.info.lastFlushAt != null && (
            <div className="storage-tab-status-row">
              <span className="storage-tab-status-label">{t('storage.lastSave')}</span>
              <span className="storage-tab-status-value">{relTime(storage.info.lastFlushAt, t)}</span>
            </div>
          )}
          {flushError && (
            <div className="storage-tab-status-row">
              <span className="storage-tab-status-label">{t('storage.lastError')}</span>
              <span className="storage-tab-status-value storage-tab-warn" title={flushError.message}>
                {flushError.name} — {relTime(flushError.at, t)}
              </span>
            </div>
          )}
          {storage.info.catalogSize != null && storage.info.catalogSize > 0 && (
            <div className="storage-tab-status-row">
              <span className="storage-tab-status-label">{t('storage.size')}</span>
              <span className="storage-tab-status-value">{formatBytes(storage.info.catalogSize)}</span>
            </div>
          )}
        </div>
      )}

      <div className="storage-tab-actions">
        {storage && (
          <button className="settings-btn-text" onClick={exportSnapshot}>
            {t('storage.downloadSnapshot')}
          </button>
        )}
        {storage instanceof FolderStorage && (
          <>
            <input
              ref={importInputRef}
              type="file"
              accept=".sqlite,application/x-sqlite3"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                // Cleared either way, or picking the same file twice fires nothing.
                e.target.value = '';
                if (file) void importCatalog(file);
              }}
            />
            <button className="settings-btn-text"
              disabled={opening || readOnly}
              onClick={() => importInputRef.current?.click()}
              title={t('storage.importCatalogTitle')}>
              {t('storage.importCatalog')}
            </button>
          </>
        )}
        {storage && !isEphemeral && (
          <button className="settings-btn-text"
            disabled={compacting || readOnly}
            onClick={async () => {
              if (!storage) return;
              setCompacting(true);
              try {
                // Retired stamps first, so the compaction below drops their bytes.
                const pruned = repos ? await pruneRetiredEditThumbs(storage.db, repos.thumbnails) : 0;
                const r = await compactThumbBins(storage);
                setLastPruned(pruned);
                setLastCompact(r);
              } finally {
                setCompacting(false);
              }
            }}
            title={t('storage.compactTitle')}>
            {compacting ? t('storage.compacting') : t('storage.compactBins')}
          </button>
        )}
        {storage && isEphemeral && (
          <span className="storage-tab-warn">
            {t('storage.memoryWarn')}
          </span>
        )}
        {explicit && (
          <button className="settings-btn-text" onClick={() => void reset()} title={t('storage.resetChoiceTitle')}>
            {t('storage.resetChoice')}
          </button>
        )}
        <button
          className="settings-btn-text"
          title={t('storage.resetLocalSettingsTitle')}
          onClick={() => {
            if (!confirm(t('storage.resetLocalSettingsConfirm'))) return;
            resetAllStorageKeys();
            window.location.reload();
          }}>
          {t('storage.resetLocalSettings')}
        </button>
      </div>

      {storage instanceof FolderStorage && (
        <div className="storage-tab-actions" style={{ marginTop: 6 }}>
          {storage.isEncrypted() ? (
            <button className="settings-btn-text"
              disabled={encryptBusy || readOnly}
              onClick={async () => {
                if (!storage || !(storage instanceof FolderStorage)) return;
                if (!confirm(t('storage.removeEncryptionConfirm'))) return;
                setEncryptError(null);
                setEncryptBusy(true);
                try {
                  await storage.disableEncryption();
                  bumpEnc((n) => n + 1);
                } catch (e) {
                  setEncryptError((e as Error).message);
                } finally {
                  setEncryptBusy(false);
                }
              }}>
              {encryptBusy ? t('storage.pleaseWait') : t('storage.removeEncryption')}
            </button>
          ) : (
            <button className="settings-btn-text"
              disabled={encryptBusy || readOnly}
              onClick={async () => {
                if (!storage || !(storage instanceof FolderStorage)) return;
                const pass = await requestPassphrase({
                  title: t('storage.encryptDialogTitle'),
                  description: t('storage.encryptDialogDesc'),
                  confirm: true,
                  minLength: 12,
                });
                if (!pass) return;
                setEncryptError(null);
                setEncryptBusy(true);
                try {
                  await storage.enableEncryption(pass);
                  bumpEnc((n) => n + 1);
                } catch (e) {
                  setEncryptError((e as Error).message);
                } finally {
                  setEncryptBusy(false);
                }
              }}
              title={t('storage.encryptCatalogTitle')}>
              {encryptBusy ? t('storage.pleaseWait') : t('storage.encryptCatalog')}
            </button>
          )}
          <span className="storage-tab-warn" style={{ marginLeft: 4 }}>
            {storage.isEncrypted() ? t('storage.encryptedActive') : t('storage.encryptedNot')}
          </span>
        </div>
      )}
      {encryptError && <div className="storage-tab-error">{encryptError}</div>}

      {lastCompact && (
        <div className="storage-tab-sync-status" style={{ marginTop: 8 }}>
          <div className="storage-tab-status-row">
            <span className="storage-tab-status-label">{t('storage.compactionLabel')}</span>
            <span className="storage-tab-status-value">
              {t('storage.compactionSummary', {
                touched: lastCompact.binsTouched,
                skipped: lastCompact.binsSkipped,
                before: formatBytes(lastCompact.bytesBefore),
                after: formatBytes(lastCompact.bytesAfter),
                saved: formatBytes(Math.max(0, lastCompact.bytesBefore - lastCompact.bytesAfter)),
              })}
            </span>
          </div>
          <div className="storage-tab-status-row">
            <span className="storage-tab-status-value">
              {t('storage.prunedEditThumbs', { count: lastPruned })}
            </span>
          </div>
          {lastCompact.errors.length > 0 && (
            <div className="storage-tab-warn">
              {t('storage.compactionErrors', { count: lastCompact.errors.length, first: lastCompact.errors[0] })}
            </div>
          )}
        </div>
      )}

      {openError && (
        <div className="storage-tab-error">{openError}</div>
      )}

      {/* ─────────────── Server section ─────────────── */}

      <ServerSection />

      {/* ─────────────── Sync section ─────────────── */}

      <h3 style={{ marginTop: 28 }}>{t('storage.syncHeading')}</h3>
      <p className="settings-hint">{t('storage.syncHint')}</p>

      <div className="settings-field">
        <label className="settings-field-label">{t('storage.serverUrlLabel')}</label>
        <input
          type="text"
          className="settings-input"
          placeholder="https://sync.example.com"
          value={sync?.serverUrl ?? ''}
          onChange={(e) => {
            // A verdict from the previous address must not stand next to a new
            // one - it would read as if this address had been checked.
            setHubCheck({ kind: 'idle' });
            setSync(e.target.value ? { ...(sync ?? {}), serverUrl: e.target.value } : null);
          }}
        />
        <div className="settings-hint" style={{ marginTop: 6 }}>{t('storage.hub.publicHint')}</div>
      </div>

      {!hubUrl.ok && hubUrl.reason !== 'empty' && (
        <div className="storage-tab-warn">
          {hubUrl.reason === 'invalid' && t('storage.hub.reasonInvalid')}
          {hubUrl.reason === 'mixed-content' && t('storage.hub.reasonMixedContent')}
        </div>
      )}

      {hubUrl.ok && (
        <div className="storage-tab-actions">
          <button
            type="button"
            className="settings-btn-text"
            disabled={hubCheck.kind === 'checking'}
            onClick={() => void runHubCheck()}>
            {hubCheck.kind === 'checking' ? t('storage.hub.checking') : t('storage.hub.check')}
          </button>
        </div>
      )}

      {hubCheck.kind === 'ok' && (
        <div className="storage-tab-sync-status">{t('storage.hub.checkOk')}</div>
      )}
      {hubCheck.kind === 'failed' && (
        <div className="storage-tab-error">
          {t('storage.hub.checkFailed', { detail: hubCheck.detail })}
          {hubCheck.blocked && (
            <div className="settings-hint">
              {t('storage.hub.checkBlocked', { origin: pageOrigin })}
            </div>
          )}
        </div>
      )}
      {hubCheck.kind === 'not-ours' && (
        <div className="storage-tab-error">
          {t('storage.hub.checkNotOurs', { detail: hubCheck.detail })}
        </div>
      )}

      {sync?.serverUrl && !sync.token && (
        <div className="settings-field" style={{ marginTop: 12 }}>
          <label className="settings-field-label">{t('storage.accountLabel')}</label>
          {syncSessionExpired && (
            <div className="settings-hint" style={{ color: 'var(--color-error, #e74c3c)', marginBottom: 8 }}>
              {t('storage.sessionExpired')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button type="button"
              className={`settings-btn-primary ${syncMode === 'login' ? 'active' : ''}`}
              onClick={() => setSyncMode('login')} disabled={authBusy}>
              {t('storage.login')}
            </button>
            {registrationEnabled && (
              <button type="button"
                className={`settings-btn-primary ${syncMode === 'register' ? 'active' : ''}`}
                onClick={() => setSyncMode('register')} disabled={authBusy}>
                {t('storage.register')}
              </button>
            )}
          </div>
          <input
            type="text" className="settings-input" placeholder={t('settings.username')}
            value={syncUser} onChange={(e) => setSyncUser(e.target.value)}
            disabled={authBusy} style={{ marginBottom: 6 }}
          />
          <input
            type="password" className="settings-input" placeholder={t('storage.passwordMin8Placeholder')}
            value={syncPass} onChange={(e) => setSyncPass(e.target.value)}
            disabled={authBusy} style={{ marginBottom: 6 }}
          />
          {authError && (
            <div className="settings-hint" style={{ color: 'var(--color-error, #e74c3c)' }}>
              {authError}
            </div>
          )}
          <button type="button" className="settings-btn-primary"
            onClick={submitAuth}
            disabled={authBusy || !syncUser || syncPass.length < 8}>
            {authBusy ? t('storage.pleaseWait') : effectiveSyncMode === 'login' ? t('storage.login') : t('storage.register')}
          </button>
          {!registrationEnabled && (
            <div className="settings-hint" style={{ marginTop: 6 }}>
              {t('storage.registrationManagedByAdmin')}
            </div>
          )}
        </div>
      )}

      {sync?.token && (
        <div className="settings-field" style={{ marginTop: 12 }}>
          <label className="settings-field-label">{t('storage.accountLabel')}</label>
          <div className="settings-catalog-connected">
            <span className="settings-tab-dot valid" style={{ position: 'static', marginRight: 6 }} />
            <span>{accountName ? t('storage.loggedInAs', { name: accountName }) : t('storage.tokenStored')}</span>
          </div>
          <button type="button" className="settings-btn-text" onClick={logout} style={{ marginTop: 6 }}>
            {t('storage.signOut')}
          </button>
          <SyncAccountSecurity
            serverUrl={sync.serverUrl}
            token={sync.token}
            onTokenReplaced={(token) => setSync({ ...sync, token })}
            onSignedOut={logout}
          />
        </div>
      )}

      {sync?.serverUrl && sync.token && storage && (
        <div className="storage-tab-sync-status">
          <div className="storage-tab-status-row">
            <span className="storage-tab-status-label">{t('storage.statusLabel')}</span>
            <span className="storage-tab-status-value">
              {syncing ? t('storage.syncing') : lastSyncResult ? t('storage.lastSync', { time: relTime(lastSyncResult.finishedAt, t) }) : t('storage.ready')}
            </span>
          </div>
          {lastSyncResult && lastSyncResult.errors.length > 0 && (
            <div className="storage-tab-error">
              {t('storage.syncErrors', { count: lastSyncResult.errors.length, first: lastSyncResult.errors[0].error })}
              {skippedRows > 0 && <> · {t('storage.syncSkipped', { count: skippedRows })}</>}
            </div>
          )}
          <button className="settings-btn-primary" onClick={() => void syncNow()}
            disabled={syncing} style={{ marginTop: 8 }}>
            {t('storage.syncNow')}
          </button>
          <button type="button" className="settings-btn-text" onClick={() => void resendAll()}
            disabled={syncing} style={{ marginTop: 6 }}>
            {t('storage.resendAll')}
          </button>
          <div className="settings-hint">{t('storage.resendAllHint')}</div>
        </div>
      )}

      {/* Migration section removed in Phase 7 (no legacy data path remains). */}
    </div>
  );
}

function KindRow(props: {
  label: string;
  sub: string;
  active: boolean;
  actionLabel: string;
  onAction: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={`storage-tab-kind ${props.active ? 'active' : ''}`}>
      <div className="storage-tab-kind-text">
        <div className="storage-tab-kind-label">{props.label}</div>
        <div className="storage-tab-kind-sub">{props.sub}</div>
      </div>
      <button
        className="settings-btn-text"
        onClick={props.onAction}
        disabled={props.busy || props.disabled}>
        {props.actionLabel}
      </button>
    </div>
  );
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

function labelForKind(k: StorageKind, t: TFunc): string {
  if (k === 'filesystem') return t('storage.kindFilesystem');
  if (k === 'opfs') return t('storage.kindOpfs');
  return t('storage.kindMemory');
}

function relTime(ts: number, t: TFunc): string {
  const dt = Date.now() - ts;
  if (dt < 5_000) return t('storage.justNow');
  if (dt < 60_000) return t('storage.secondsAgo', { n: Math.floor(dt / 1000) });
  if (dt < 3_600_000) return t('storage.minutesAgo', { n: Math.floor(dt / 60_000) });
  if (dt < 86_400_000) return t('storage.hoursAgo', { n: Math.floor(dt / 3_600_000) });
  return new Date(ts).toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
