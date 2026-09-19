import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { config, getBackendUrl, setBackendUrl, validateBackendUrl } from '../../platform/config';
import { useStorage } from '../../contexts/StorageContext';
import {
  describeProbeError,
  describeProbeResponse,
  probeHealthUrl,
  type ProbeState,
} from './serverProbe';

/**
 * The UI of `config.backendUrl` — the second branch of `hasBackend()`, which
 * decoder, transport and the `/api` guard all read but which had no way in
 * (ONLINE_MODE_PLAN §P9 promised the field, F036 found it missing).
 *
 * Saving only writes the key. Decoder strategies and the transport default are
 * read at render time and a source keeps the transport it was stored with, so
 * a reload is the honest way to let the change take effect everywhere.
 */
export function ServerSection() {
  const { t } = useTranslation();
  const { sync, setSync } = useStorage();
  const [input, setInput] = useState(getBackendUrl);
  const [stored, setStored] = useState(getBackendUrl);
  const [check, setCheck] = useState<ProbeState>({ kind: 'idle' });
  const [changed, setChanged] = useState(false);

  const pageOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const result = validateBackendUrl(input, pageOrigin);

  const edit = (value: string) => {
    setInput(value);
    setCheck({ kind: 'idle' });
    setChanged(false);
  };

  const runCheck = async () => {
    if (!result.ok) return;
    setCheck({ kind: 'checking' });
    try {
      const response = await fetch(probeHealthUrl(result.url), { mode: 'cors' });
      // Read the body, not just the status: a static host answers every path
      // with index.html, so an app address would pass a status-only check.
      const body: unknown = await response.json().catch(() => null);
      setCheck(describeProbeResponse(response.ok, response.status, body));
    } catch (error) {
      // The browser gives the page no reason for a refused cross-origin call:
      // a missing CORS entry, a private-network target and a dead host all
      // arrive as the same TypeError. The message names all three.
      setCheck(describeProbeError(error));
    }
  };

  const save = () => {
    if (!result.ok) return;
    setBackendUrl(result.url);
    setStored(result.url);
    setInput(result.url);
    // Decision 2 of AP21: /api/sync is served by this very backend and its
    // bearer comes out of the sync settings. An address the user already
    // entered there stays untouched.
    if (!sync?.serverUrl) setSync({ ...(sync ?? {}), serverUrl: result.url });
    setChanged(true);
  };

  const remove = () => {
    setBackendUrl('');
    setStored('');
    setInput('');
    setCheck({ kind: 'idle' });
    setChanged(true);
  };

  const body = (
    <>
      <p className="settings-hint">{t('storage.server.hint')}</p>
      <p className="settings-hint">{t('storage.server.consequences')}</p>

      <div className="settings-field">
        <label className="settings-field-label" htmlFor="backend-url-input">
          {t('storage.server.label')}
        </label>
        <input
          id="backend-url-input"
          type="text"
          className="settings-input"
          placeholder={t('storage.server.placeholder')}
          value={input}
          onChange={(e) => edit(e.target.value)}
        />
      </div>

      {!result.ok && result.reason !== 'empty' && (
        <div className="storage-tab-warn">
          {result.reason === 'invalid' && t('storage.server.reasonInvalid')}
          {result.reason === 'mixed-content' && t('storage.server.reasonMixedContent')}
          {result.reason === 'own-origin' && t('storage.server.reasonOwnOrigin')}
        </div>
      )}

      <div className="storage-tab-actions">
        <button
          type="button"
          className="settings-btn-text"
          disabled={!result.ok || check.kind === 'checking'}
          onClick={() => void runCheck()}>
          {check.kind === 'checking' ? t('storage.server.checking') : t('storage.server.check')}
        </button>
        <button
          type="button"
          className="settings-btn-primary"
          disabled={!result.ok || result.url === stored}
          onClick={save}>
          {t('storage.server.save')}
        </button>
        {stored !== '' && (
          <button type="button" className="settings-btn-text" onClick={remove}>
            {t('storage.server.remove')}
          </button>
        )}
      </div>

      {check.kind === 'ok' && (
        <div className="storage-tab-sync-status">{t('storage.server.checkOk')}</div>
      )}
      {check.kind === 'failed' && (
        <div className="storage-tab-error">
          {t('storage.server.checkFailed', { detail: check.detail })}
          {check.blocked && (
            <div className="settings-hint">
              {t('storage.server.checkBlocked', { origin: pageOrigin })}
            </div>
          )}
        </div>
      )}
      {check.kind === 'not-ours' && (
        <div className="storage-tab-error">
          {t('storage.server.checkNotOurs', { detail: check.detail })}
        </div>
      )}

      {changed && (
        <div className="settings-hint">
          {t('storage.server.reloadHint')}
          <button
            type="button"
            className="settings-btn-text"
            style={{ marginLeft: 8 }}
            onClick={() => window.location.reload()}>
            {t('storage.reload')}
          </button>
        </div>
      )}
    </>
  );

  if (config.mode === 'hosted') {
    return (
      <details style={{ marginTop: 28 }}>
        <summary className="settings-field-label">{t('storage.server.heading')}</summary>
        <p className="settings-hint">{t('storage.server.selfhostNote')}</p>
        {body}
      </details>
    );
  }

  return (
    <>
      <h3 style={{ marginTop: 28 }}>{t('storage.server.heading')}</h3>
      {body}
    </>
  );
}
