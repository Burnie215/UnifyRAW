import { useState } from 'react';
import type { LicenseStatus } from '../../engine/License';

export interface LicenseTabProps {
  licenseStatus?: LicenseStatus;
  onActivateLicense?: (key: string) => Promise<LicenseStatus>;
  onDeactivateLicense?: () => void;
}

export function LicenseTab({ licenseStatus, onActivateLicense, onDeactivateLicense }: LicenseTabProps) {
  const [licenseKey, setLicenseKey] = useState('');
  const [licenseMsg, setLicenseMsg] = useState<string | null>(null);

  return (
    <div className="settings-section">
      <h3>Lizenz</h3>
      {licenseStatus?.valid ? (
        <div className="license-active">
          <div className="license-badge valid">Aktiv</div>
          <div className="license-info-grid">
            <span className="license-label">E-Mail</span>
            <span>{licenseStatus.info?.email}</span>
            <span className="license-label">Plan</span>
            <span>{licenseStatus.info?.plan}</span>
            <span className="license-label">Max. Benutzer</span>
            <span>{licenseStatus.info?.maxUsers}</span>
            <span className="license-label">Updates bis</span>
            <span className={licenseStatus.updatesActive ? '' : 'license-expired'}>
              {licenseStatus.info?.updatesUntil}
              {licenseStatus.updatesActive
                ? ` (${licenseStatus.updatesDaysLeft} Tage)`
                : ' (abgelaufen)'}
            </span>
          </div>
          {onDeactivateLicense && (
            <button className="settings-btn-sm" onClick={onDeactivateLicense} style={{ marginTop: 12 }}>
              Lizenz entfernen
            </button>
          )}
        </div>
      ) : (
        <div className="license-activate">
          <p className="settings-hint">Gib deinen Lizenzschluessel ein um alle Features freizuschalten.</p>
          <textarea
            className="license-key-input"
            placeholder="Lizenzschluessel einfuegen..."
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            rows={3}
          />
          <button className="settings-btn-primary" disabled={!licenseKey.trim()}
            onClick={async () => {
              if (!onActivateLicense) return;
              const result = await onActivateLicense(licenseKey.trim());
              if (result.valid) {
                setLicenseMsg('Lizenz erfolgreich aktiviert!');
                setLicenseKey('');
              } else {
                setLicenseMsg(result.error ?? 'Ungueltig');
              }
            }}>
            Aktivieren
          </button>
          {licenseMsg && <div className={`license-msg ${licenseStatus?.valid ? 'success' : 'error'}`}>{licenseMsg}</div>}
        </div>
      )}
    </div>
  );
}
