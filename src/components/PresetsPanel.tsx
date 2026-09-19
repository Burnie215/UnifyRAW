import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PresetRow } from '../storage/repos';
import type { PresetImportResult } from '../hooks/usePresets';
import { ADJUSTMENT_PANEL_FIELDS } from '../engine/adjustmentFields';
import { CompactSlider } from '../ui/CompactSlider';
import './PresetsPanel.css';

const PRESET_GROUP_KEYS = Object.keys(ADJUSTMENT_PANEL_FIELDS);

interface PresetsPanelProps {
  presets: PresetRow[];
  onApply: (preset: PresetRow, strength: number) => void;
  onSave: (name: string, category?: string, groups?: string[]) => void;
  onDelete: (id: number) => void;
  onExport: (preset: PresetRow) => void;
  onImport: (contents: string, fileName?: string) => PresetImportResult | void;
  imageUrl?: string | null;
  /** WebGL-rendered thumbnails per preset ID */
  presetThumbnails?: Map<number, string>;
  activePresetSyncId?: string | null;
  presetStrength?: number;
  onStrengthChange?: (strength: number) => void;
  /** Open the alignment bench to build a preset against several photos at once. */
  onOpenBench?: () => void;
  /**
   * False in the gallery, where applying a preset creates one preset layer per
   * selected photo at the fixed default strength of 100.
   */
  showStrength?: boolean;
}

export function PresetsPanel({
  presets, onApply, onSave, onDelete, onExport, onImport, imageUrl, presetThumbnails,
  activePresetSyncId, presetStrength = 100, onStrengthChange, onOpenBench,
  showStrength = true,
}: PresetsPanelProps) {
  const { t } = useTranslation();
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveCategory, setSaveCategory] = useState('');
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(() => new Set(PRESET_GROUP_KEYS));
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [importStatus, setImportStatus] = useState<{ text: string; warning: boolean } | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() => new Set());
  const [strength, setStrength] = useState(presetStrength);

  useEffect(() => setStrength(presetStrength), [presetStrength, activePresetSyncId]);

  const categories = [...new Set(presets.map((p) => p.category).filter(Boolean))] as string[];

  const toggleGroup = (key: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const allSelected = selectedGroups.size === PRESET_GROUP_KEYS.length;

  const toggleCategory = (category: string) => {
    setExpandedCategories((previous) => {
      const next = new Set(previous);
      if (next.has(category)) next.delete(category); else next.add(category);
      return next;
    });
  };

  const handleStrengthChange = (value: number) => {
    setStrength(value);
    if (activePresetSyncId) onStrengthChange?.(value);
  };

  const handleSave = () => {
    if (!saveName.trim()) return;
    onSave(saveName.trim(), saveCategory.trim() || undefined, Array.from(selectedGroups));
    setSaveName('');
    setSaveCategory('');
    setShowSave(false);
    setSelectedGroups(new Set(PRESET_GROUP_KEYS));
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.xmp,application/rdf+xml';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      let imported = 0;
      let warnings = 0;
      let failed = 0;
      for (const file of files) {
        try {
          const result = onImport(await file.text(), file.name);
          imported++;
          warnings += result?.warnings.length ?? 0;
        } catch (error) {
          failed++;
          console.error(`[PresetImport] ${file.name}:`, error);
        }
      }
      if (files.length > 0) {
        setImportStatus({
          text: t('panels.presets.importResult', { imported, warnings, failed }),
          warning: warnings > 0 || failed > 0,
        });
      }
    };
    input.click();
  };

  const grouped = new Map<string, PresetRow[]>();
  for (const p of presets) {
    const cat = p.category || t('panels.presets.uncategorized');
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(p);
  }

  return (
    <div className="presets-panel">
      <div className="presets-actions">
        <button className="preset-action-btn" onClick={() => setShowSave(!showSave)}>
          {t('panels.presets.save')}
        </button>
        <button className="preset-action-btn" onClick={handleImport}>
          {t('panels.presets.import')}
        </button>
        {onOpenBench && (
          <button className="preset-action-btn" onClick={onOpenBench} data-testid="open-bench">
            {t('panels.presets.bench')}
          </button>
        )}
        <div className="preset-view-toggle">
          <button className={`preset-vt-btn ${viewMode === 'grid' ? 'active' : ''}`} onClick={() => setViewMode('grid')} title={t('panels.presets.viewGrid')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><rect x="0" y="0" width="4" height="4" rx="0.5" /><rect x="6" y="0" width="4" height="4" rx="0.5" /><rect x="0" y="6" width="4" height="4" rx="0.5" /><rect x="6" y="6" width="4" height="4" rx="0.5" /></svg>
          </button>
          <button className={`preset-vt-btn ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')} title={t('panels.presets.viewList')}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M0 2h10M0 5h10M0 8h10" /></svg>
          </button>
        </div>
      </div>

      {importStatus && (
        <div className={`preset-import-status ${importStatus.warning ? 'warning' : ''}`}>
          <span>{importStatus.text}</span>
          <button onClick={() => setImportStatus(null)} aria-label={t('panels.presets.dismiss')}>×</button>
        </div>
      )}

      {showStrength && (
      <div className="preset-strength">
        <CompactSlider
          label={t('panels.presets.strength')}
          value={strength}
          min={0}
          max={100}
          defaultValue={100}
          onChange={handleStrengthChange}
        />
      </div>
      )}

      {showSave && (
        <div className="preset-save-form">
          <input
            type="text"
            placeholder={t('panels.presets.namePlaceholder')}
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            autoFocus
          />
          <input
            type="text"
            placeholder={t('panels.presets.categoryPlaceholder')}
            value={saveCategory}
            onChange={(e) => setSaveCategory(e.target.value)}
            list="preset-categories"
          />
          <datalist id="preset-categories">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>

          {/* Group checkboxes */}
          <div className="preset-groups">
            <label className="preset-group-toggle" onClick={() => {
              if (allSelected) setSelectedGroups(new Set());
              else setSelectedGroups(new Set(PRESET_GROUP_KEYS));
            }}>
              <input type="checkbox" checked={allSelected} readOnly />
              <span>{t('panels.presets.all')}</span>
            </label>
            {PRESET_GROUP_KEYS.map((key) => (
              <label key={key} className="preset-group-check">
                <input type="checkbox" checked={selectedGroups.has(key)} onChange={() => toggleGroup(key)} />
                <span>{t(`panels.presets.groups.${key}`)}</span>
              </label>
            ))}
          </div>

          <button className="preset-save-btn" onClick={handleSave}>{t('panels.presets.saveButton')}</button>
        </div>
      )}

      <div className={viewMode === 'grid' ? 'presets-grid' : 'presets-list'}>
        {presets.length === 0 && <div className="presets-empty">{t('panels.presets.empty')}</div>}
        {[...grouped.entries()].map(([cat, items]) => (
          <div key={cat} className="preset-group">
            <button
              type="button"
              className="preset-group-label"
              onClick={() => toggleCategory(cat)}
              aria-expanded={expandedCategories.has(cat)}
            >
              <span className={`preset-group-chevron ${expandedCategories.has(cat) ? 'expanded' : ''}`}>›</span>
              <span>{cat}</span>
              <span className="preset-group-count">{items.length}</span>
            </button>
            {expandedCategories.has(cat) && (viewMode === 'grid' ? (
              <div className="preset-grid-items">
                {items.map((p) => (
                  <PresetThumb
                    key={p.id}
                    preset={p}
                    imageUrl={imageUrl}
                    thumbnailUrl={presetThumbnails?.get(p.id!)}
                    active={p.syncId === activePresetSyncId}
                    onApply={() => onApply(p, strength)}
                    onDelete={() => {
                      if (confirmDelete === p.id) { onDelete(p.id!); setConfirmDelete(null); }
                      else setConfirmDelete(p.id!);
                    }}
                    onExport={() => onExport(p)}
                    confirmDelete={confirmDelete === p.id}
                  />
                ))}
              </div>
            ) : (
              items.map((p) => (
                <div key={p.id} className={`preset-item ${p.syncId === activePresetSyncId ? 'active' : ''}`}>
                  <button className="preset-name" onClick={() => onApply(p, strength)}>
                    {p.name}
                  </button>
                  <div className="preset-item-actions">
                    <button className="preset-icon-btn" title={t('panels.presets.export')} onClick={() => onExport(p)}>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M5 1v6M2 4l3-3 3 3M1 8h8" />
                      </svg>
                    </button>
                    {confirmDelete === p.id ? (
                      <button className="preset-icon-btn danger" onClick={() => { onDelete(p.id!); setConfirmDelete(null); }}>
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 5l2 2 4-5" /></svg>
                      </button>
                    ) : (
                      <button className="preset-icon-btn" title={t('panels.presets.delete')} onClick={() => setConfirmDelete(p.id!)}>
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 2l6 6M8 2L2 8" /></svg>
                      </button>
                    )}
                  </div>
                </div>
              ))
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Preset thumbnail — uses WebGL-rendered image, shows source image while loading */
function PresetThumb({ preset, imageUrl, thumbnailUrl, onApply, onDelete, onExport, confirmDelete, active }: {
  preset: PresetRow; imageUrl?: string | null; thumbnailUrl?: string;
  onApply: () => void; onDelete: () => void; onExport: () => void; confirmDelete: boolean; active: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className={`preset-thumb ${active ? 'active' : ''}`} onClick={onApply}>
      <div className="preset-thumb-preview">
        {thumbnailUrl ? (
          <img src={thumbnailUrl} alt="" draggable={false} />
        ) : imageUrl ? (
          <img src={imageUrl} alt="" draggable={false} className="preset-thumb-loading" />
        ) : (
          <div className="preset-thumb-placeholder" />
        )}
      </div>
      <div className="preset-thumb-name">{preset.name}</div>
      <button
        className="preset-thumb-export"
        onClick={(e) => { e.stopPropagation(); onExport(); }}
        title={t('panels.presets.export')}
        aria-label={t('panels.presets.export')}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M5 1v6M2 4l3-3 3 3M1 8h8" />
        </svg>
      </button>
      <button
        className={`preset-thumb-del ${confirmDelete ? 'danger' : ''}`}
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        title={confirmDelete ? t('panels.presets.confirm') : t('panels.presets.delete')}
      >
        {confirmDelete ? '✓' : '×'}
      </button>
    </div>
  );
}
