import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Password change and "sign out all devices" for the signed-in sync account.
 * Both revoke every token of the account on the server; a password change
 * hands this device a fresh one.
 */
export function SyncAccountSecurity(props: {
  serverUrl: string;
  token: string;
  onTokenReplaced: (token: string) => void;
  onSignedOut: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const post = async (endpoint: 'password' | 'logout-all', body?: unknown) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${props.token}`,
      'Accept-Language': i18n.resolvedLanguage ?? 'de',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${props.serverUrl.replace(/\/+$/, '')}/api/auth/${endpoint}`, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // 204 has no body, and a hub without these routes answers with HTML.
    const data = await res.json().catch(() => ({})) as { token?: string; error?: string };
    return { res, data };
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setChanged(false);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = () => run(async () => {
    const { res, data } = await post('password', { currentPassword, newPassword });
    if (!res.ok || !data.token) {
      setError(data.error ?? `HTTP ${res.status}`);
      return;
    }
    props.onTokenReplaced(data.token);
    setCurrentPassword('');
    setNewPassword('');
    setChanged(true);
  });

  const logoutAll = () => run(async () => {
    const { res, data } = await post('logout-all');
    // A 401 means this token is already revoked: signed out either way.
    if (!res.ok && res.status !== 401) {
      setError(data.error ?? `HTTP ${res.status}`);
      return;
    }
    props.onSignedOut();
  });

  return (
    <div className="settings-field" style={{ marginTop: 12 }}>
      <label className="settings-field-label">{t('storage.changePassword')}</label>
      <input
        type="password" className="settings-input" autoComplete="current-password"
        placeholder={t('storage.currentPassword')} aria-label={t('storage.currentPassword')}
        value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
        disabled={busy} style={{ marginBottom: 6 }}
      />
      <input
        type="password" className="settings-input" autoComplete="new-password"
        placeholder={t('storage.newPassword')} aria-label={t('storage.newPassword')}
        value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
        disabled={busy} style={{ marginBottom: 6 }}
      />
      {error && (
        <div className="settings-hint" style={{ color: 'var(--color-error, #e74c3c)' }}>
          {error}
        </div>
      )}
      {changed && <div className="settings-hint">{t('storage.passwordChanged')}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button type="button" className="settings-btn-primary"
          onClick={() => void changePassword()}
          disabled={busy || !currentPassword || newPassword.length < 8}>
          {busy ? t('storage.pleaseWait') : t('storage.changePassword')}
        </button>
        <button type="button" className="settings-btn-text"
          onClick={() => void logoutAll()} disabled={busy}>
          {t('storage.logoutAll')}
        </button>
      </div>
    </div>
  );
}
