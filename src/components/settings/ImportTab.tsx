import type { ImportPreset } from '../../hooks/useImportPreset';
import type { OrganizePattern } from '../../hooks/useAutoOrganize';

export interface ImportTabProps {
  importPreset: ImportPreset;
  onImportPresetChange: (update: Partial<ImportPreset>) => void;
  onImportPresetReset?: () => void;
  presetNames?: string[];
}

export function ImportTab({
  importPreset, onImportPresetChange, onImportPresetReset, presetNames,
}: ImportTabProps) {
  return (
    <div className="settings-section">
      <h3>Import-Voreinstellungen</h3>
      <p className="settings-hint">Diese Einstellungen werden auf jedes neu importierte Foto angewandt.</p>

      <div className="settings-import-grid">
        <label className="settings-toggle">
          <input type="checkbox" checked={importPreset.autoOrganize}
            onChange={(e) => onImportPresetChange({ autoOrganize: e.target.checked })} />
          <span>Auto-Organize (Datum-Sammlungen)</span>
        </label>
        {importPreset.autoOrganize && (
          <div className="settings-sub">
            <label className="settings-field-label">Muster</label>
            <select className="settings-select" value={importPreset.organizePattern}
              onChange={(e) => onImportPresetChange({ organizePattern: e.target.value as OrganizePattern })}>
              <option value="year">Jahr</option>
              <option value="year-month">Jahr / Monat</option>
              <option value="year-month-day">Jahr / Monat / Tag</option>
            </select>
          </div>
        )}

        <label className="settings-toggle">
          <input type="checkbox" checked={importPreset.autoStack}
            onChange={(e) => onImportPresetChange({ autoStack: e.target.checked })} />
          <span>Burst-Erkennung (Auto-Stack)</span>
        </label>

        <div className="settings-field">
          <label className="settings-field-label">Standard-Rating</label>
          <select className="settings-select" value={importPreset.defaultRating}
            onChange={(e) => onImportPresetChange({ defaultRating: Number(e.target.value) })}>
            <option value="0">Keins</option>
            <option value="1">★</option>
            <option value="2">★★</option>
            <option value="3">★★★</option>
            <option value="4">★★★★</option>
            <option value="5">★★★★★</option>
          </select>
        </div>

        <div className="settings-field">
          <label className="settings-field-label">Standard-Flag</label>
          <select className="settings-select" value={importPreset.defaultFlag ?? ''}
            onChange={(e) => onImportPresetChange({ defaultFlag: e.target.value === 'pick' ? 'pick' : null })}>
            <option value="">Keins</option>
            <option value="pick">Pick</option>
          </select>
        </div>

        <div className="settings-field">
          <label className="settings-field-label">Standard-Farblabel</label>
          <select className="settings-select" value={importPreset.defaultLabel ?? ''}
            onChange={(e) => onImportPresetChange({ defaultLabel: e.target.value || null })}>
            <option value="">Keins</option>
            <option value="red">Rot</option>
            <option value="yellow">Gelb</option>
            <option value="green">Gruen</option>
            <option value="blue">Blau</option>
            <option value="purple">Lila</option>
          </select>
        </div>

        <div className="settings-field">
          <label className="settings-field-label">Standard-Keywords</label>
          <input type="text" className="settings-input" placeholder="Kommagetrennt, z.B. Import, 2026"
            value={importPreset.defaultKeywords.join(', ')}
            onChange={(e) => onImportPresetChange({
              defaultKeywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
            })} />
        </div>

        <div className="settings-field">
          <label className="settings-field-label">Copyright</label>
          <input type="text" className="settings-input" placeholder="© Name"
            value={importPreset.copyright}
            onChange={(e) => onImportPresetChange({ copyright: e.target.value })} />
        </div>

        <div className="settings-field">
          <label className="settings-field-label">Develop-Preset</label>
          <select className="settings-select" value={importPreset.developPreset}
            onChange={(e) => onImportPresetChange({ developPreset: e.target.value })}>
            <option value="">Keins</option>
            {(presetNames ?? []).map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        {onImportPresetReset && (
          <button className="settings-btn-text" onClick={onImportPresetReset}
            style={{ marginTop: 8 }}>
            Zuruecksetzen
          </button>
        )}
      </div>
    </div>
  );
}
