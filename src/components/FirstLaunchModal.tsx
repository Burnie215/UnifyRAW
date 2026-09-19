import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStorage } from '../contexts/StorageContext';
import {
  folderTierAvailable,
  memoryCatalogOffered,
  multiDeviceAnswer,
  onboardingCopy,
  serverTierState,
} from './storageOptions';
import { validateBackendUrl } from '../platform/config';
import { useBrand } from '../brand';
import './FirstLaunchModal.css';

/**
 * Where the user's work is going to live, asked as three tiers rather than as
 * three storage technologies: try it out, keep it in a folder, or put it on
 * your own server.
 *
 * The dialog opens on the first run, and again for a folder that went missing,
 * a browser with no durable storage, or a deliberate switch - the reason picks
 * the heading, because those ask different things.
 *
 * The folder tier stays on screen where the browser cannot offer it, greyed
 * out and with the reason named: a missing option teaches nothing, a disabled
 * one with a reason does.
 */
export function FirstLaunchModal() {
  const { t } = useTranslation();
  const {
    explicit, storage, caps, opening, openError, sync, setSync,
    openFilesystem, openOPFS, openMemory, showOnboarding, setShowOnboarding,
  } = useStorage();
  const brand = useBrand();
  const [serverOpen, setServerOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => sync?.serverUrl ?? '');

  // Auto-close once the user has picked a storage and it opened cleanly.
  useEffect(() => {
    if (explicit && storage) setShowOnboarding(null);
  }, [explicit, storage, setShowOnboarding]);

  const reason = showOnboarding ?? 'switch';
  const copy = onboardingCopy(reason);
  const firstRun = reason === 'first-run';

  // Two devices are answered by the hub or by "you need one", never by a
  // catalog in a cloud folder. The selfhost build pre-fills its own origin
  // here (defaultSyncSettings), so this address is the one to name.
  const multiDevice = multiDeviceAnswer(sync?.serverUrl);
  const folderAvailable = folderTierAvailable(caps);
  const serverState = serverTierState(sync ?? null);

  // The local store the browser can offer. A hub keeps its catalog on top of
  // one of these too, so the server tier opens it as well.
  const openLocalStore = caps.opfs ? openOPFS : openMemory;

  const pageOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const urlOk = validateBackendUrl(serverUrl, pageOrigin).ok;

  const connectServer = async () => {
    if (!urlOk) return;
    // The address first, so the catalog that opens next already belongs to it.
    setSync({ ...(sync ?? {}), serverUrl: serverUrl.trim().replace(/\/+$/, '') });
    await openLocalStore();
  };

  return (
    <div className="first-launch-overlay">
      <div className="first-launch-dialog">
        <h2>{t(copy.heading)}</h2>
        <p className="first-launch-intro">
          {t(copy.intro, { brand: brand.name })}
        </p>

        {copy.multiDevice && (
          <p className="first-launch-hint">
            {multiDevice === 'hub'
              ? t('firstLaunch.multiDeviceHub', { origin: sync?.serverUrl })
              : t('firstLaunch.multiDeviceOwnServer')}
          </p>
        )}

        <div className="first-launch-options">
          {/* 1. Try it out — the browser's own storage. */}
          {(caps.opfs || memoryCatalogOffered(caps, storage?.info.kind ?? null)) && (
            <button
              className="first-launch-option"
              onClick={() => void openLocalStore()}
              disabled={opening}>
              <div className="first-launch-option-title">{t('firstLaunch.tierTrial')}</div>
              <div className="first-launch-option-desc">
                {caps.opfs ? t('firstLaunch.tierTrialDesc') : t('firstLaunch.tierTrialDescMemory')}
              </div>
            </button>
          )}

          {/* 2. A folder on this computer. */}
          <button
            className={`first-launch-option ${folderAvailable ? 'recommended' : 'unavailable'}`}
            onClick={openFilesystem}
            disabled={opening || !folderAvailable}>
            <div className="first-launch-option-title">{t('firstLaunch.tierFolder')}</div>
            <div className="first-launch-option-desc">
              {folderAvailable ? t('firstLaunch.tierFolderDesc') : t('firstLaunch.tierFolderUnavailable')}
            </div>
            {folderAvailable && <div className="first-launch-option-badge">{t('firstLaunch.recommended')}</div>}
          </button>

          {/* 3. The user's own server. */}
          <div className={`first-launch-option first-launch-option-group ${serverOpen ? 'expanded' : ''}`}>
            <button
              className="first-launch-option-head"
              onClick={() => setServerOpen((open) => !open)}
              disabled={opening}>
              <div className="first-launch-option-title">{t('firstLaunch.tierServer')}</div>
              <div className="first-launch-option-desc">
                {serverState === 'needs-address'
                  ? t('firstLaunch.tierServerDescNoAddress')
                  : t('firstLaunch.tierServerDescKnown', { origin: sync?.serverUrl })}
              </div>
            </button>

            {serverOpen && (
              <div className="first-launch-server">
                <input
                  type="text"
                  className="first-launch-server-input"
                  placeholder="https://photo.example.com"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  disabled={opening}
                />
                <button
                  className="first-launch-server-connect"
                  onClick={() => void connectServer()}
                  disabled={opening || !urlOk}>
                  {t('firstLaunch.tierServerConnect')}
                </button>
                <div className="first-launch-server-note">{t('firstLaunch.tierServerSignInNote')}</div>
              </div>
            )}
          </div>
        </div>

        {/* On the first run there is nothing behind the dialog to go back to. */}
        {!firstRun && (
          <button
            className="first-launch-cancel"
            onClick={() => setShowOnboarding(null)}
            disabled={opening}>
            {t('firstLaunch.later')}
          </button>
        )}

        {openError && (
          <div className="first-launch-error">{openError}</div>
        )}

        {opening && (
          <div className="first-launch-busy">{t('firstLaunch.openingCatalog')}</div>
        )}
      </div>
    </div>
  );
}
