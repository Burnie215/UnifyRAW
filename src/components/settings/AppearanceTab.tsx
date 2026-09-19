import { useTranslation } from 'react-i18next';
import type { GridFlow, HistogramStyle } from '../../types';
import { LanguageToggle } from './LanguageToggle';
import { StyleOption } from './StyleOption';
import { HistogramPreview } from './HistogramPreview';
import { ACCENT_COLORS, type AccentPreset, type SidebarWidth, type ThemeMode, type UiSize, type UiPreferences } from '../../hooks/useUiPreferences';
import { useAdaptiveLayout } from '../../contexts/AdaptiveLayoutContext';
import { usePanelLayoutContext } from '../../contexts/PanelLayoutContext';
import type { AdaptiveUiMode } from '../../platform/adaptiveLayout';

export interface AppearanceTabProps {
  gridFlow: GridFlow;
  onGridFlowChange: (flow: GridFlow) => void;
  histogramStyle: HistogramStyle;
  onHistogramStyleChange: (style: HistogramStyle) => void;
  uiPrefs: UiPreferences;
  onUiPrefsChange: (patch: Partial<UiPreferences>) => void;
  onUiPrefsReset: () => void;
}

// Letters, not words — the same in every language.
const SIZE_LABELS: Record<UiSize, string> = { sm: 'S', md: 'M', lg: 'L' };

export function AppearanceTab({
  gridFlow, onGridFlowChange,
  histogramStyle, onHistogramStyleChange,
  uiPrefs, onUiPrefsChange, onUiPrefsReset,
}: AppearanceTabProps) {
  const { t } = useTranslation();
  const { screen, uiMode, detectedScreen, setUiMode } = useAdaptiveLayout();
  // Read straight from the one owner instead of threading a callback through
  // the dialog: the panel layout has a single instance above this tree.
  const { resetLayout } = usePanelLayoutContext();
  return (
    <div className="settings-section">
      <h3>{t('settings.appearance.uiMode')}</h3>
      <p className="settings-hint">{t('settings.appearance.uiModeHint')}</p>
      <div className="ui-segmented ui-mode-segmented" role="group" aria-label={t('settings.appearance.uiMode')}>
        {(['auto', 'desktop', 'tablet', 'phone'] as AdaptiveUiMode[]).map((mode) => (
          <button
            key={mode}
            className={`ui-segmented-btn ${uiMode === mode ? 'active' : ''}`}
            aria-pressed={uiMode === mode}
            data-testid={`ui-mode-${mode}`}
            onClick={() => setUiMode(mode)}
          >
            <span>{t(`settings.appearance.uiModes.${mode}`)}</span>
          </button>
        ))}
      </div>
      <p className="ui-mode-status" role="status">
        {t('settings.appearance.uiModeStatus', {
          active: t(`settings.appearance.uiModes.${screen}`),
          detected: t(`settings.appearance.uiModes.${detectedScreen}`),
        })}
      </p>
      <p className="settings-hint ui-mode-viewport-hint">{t('settings.appearance.uiModeViewportHint')}</p>

      <div style={{ height: 24 }} />
      <h3>{t('settings.language')}</h3>
      <p className="settings-hint">{t('settings.languageHint')}</p>
      <LanguageToggle />

      <div style={{ height: 24 }} />
      <h3>{t('settings.appearance.fontSize')}</h3>
      <p className="settings-hint">{t('settings.appearance.fontSizeHint')}</p>
      <div className="ui-segmented">
        {(['sm', 'md', 'lg'] as UiSize[]).map((s) => (
          <button
            key={s}
            className={`ui-segmented-btn ${uiPrefs.fontSize === s ? 'active' : ''}`}
            onClick={() => onUiPrefsChange({ fontSize: s })}
            title={t(`settings.appearance.sizeHints.${s}`)}
          >
            <span style={{ fontSize: s === 'sm' ? 11 : s === 'md' ? 13 : 16 }}>{SIZE_LABELS[s]}</span>
            <span className="ui-segmented-hint">{t(`settings.appearance.sizeHints.${s}`)}</span>
          </button>
        ))}
      </div>

      <div style={{ height: 24 }} />
      <h3>{t('settings.appearance.accent')}</h3>
      <p className="settings-hint">{t('settings.appearance.accentHint')}</p>
      <div className="ui-swatch-grid">
        {(Object.keys(ACCENT_COLORS) as AccentPreset[]).map((preset) => (
          <button
            key={preset}
            className={`ui-swatch ${uiPrefs.accent === preset ? 'active' : ''}`}
            style={{ background: ACCENT_COLORS[preset].base }}
            onClick={() => onUiPrefsChange({ accent: preset })}
            title={preset}
            aria-label={preset}
          >
            {uiPrefs.accent === preset && (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--accent-fg)" strokeWidth="2">
                <path d="M3 7l3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        ))}
      </div>

      <div style={{ height: 24 }} />
      <h3>{t('settings.appearance.theme')}</h3>
      <p className="settings-hint">{t('settings.appearance.themeHint')}</p>
      <div className="ui-segmented">
        {(['dark', 'light', 'system'] as ThemeMode[]).map((m) => (
          <button
            key={m}
            className={`ui-segmented-btn ${uiPrefs.theme === m ? 'active' : ''}`}
            onClick={() => onUiPrefsChange({ theme: m })}
          >
            <span>{m === 'dark' ? t('settings.themeDark') : m === 'light' ? t('settings.themeLight') : t('settings.appearance.themeSystem')}</span>
          </button>
        ))}
      </div>

      <div style={{ height: 24 }} />
      <h3>{t('settings.appearance.sidebarWidth')}</h3>
      <p className="settings-hint">{t('settings.appearance.sidebarWidthHint')}</p>
      <div className="ui-segmented">
        {(['narrow', 'normal', 'wide'] as SidebarWidth[]).map((w) => (
          <button
            key={w}
            className={`ui-segmented-btn ${uiPrefs.sidebarWidth === w ? 'active' : ''}`}
            onClick={() => onUiPrefsChange({ sidebarWidth: w })}
          >
            <span>{t(`settings.appearance.sidebarWidths.${w}`)}</span>
          </button>
        ))}
      </div>

      <div style={{ height: 24 }} />
      <h3>{t('settings.appearance.density')}</h3>
      <p className="settings-hint">{t('settings.appearance.densityHint')}</p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={uiPrefs.compact}
          onChange={(e) => onUiPrefsChange({ compact: e.target.checked })}
        />
        {t('settings.appearance.compact')}
      </label>

      <div style={{ height: 16 }} />
      <button className="settings-btn-text" onClick={onUiPrefsReset}>
        {t('settings.appearance.resetLook')}
      </button>

      <div style={{ height: 8 }} />
      <button className="settings-btn-text" data-testid="reset-panel-layout" onClick={resetLayout}>
        {t('settings.appearance.resetPanelLayout')}
      </button>
      <p className="settings-hint">{t('settings.appearance.resetPanelLayoutHint')}</p>

      <div style={{ height: 24 }} />
      <h3>{t('settings.appearance.exportReminder')}</h3>
      <p className="settings-hint">{t('settings.appearance.exportReminderHint')}</p>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={uiPrefs.exportReminder}
          onChange={(e) => onUiPrefsChange({ exportReminder: e.target.checked })}
        />
        {t('settings.appearance.exportReminderToggle')}
      </label>

      <div style={{ height: 24 }} />
      <h3>{t('settings.appearance.galleryFlow')}</h3>
      <p className="settings-hint">{t('settings.appearance.galleryFlowHint')}</p>
      <div className="ui-segmented" role="group" aria-label={t('settings.appearance.galleryFlow')}>
        {(['fill', 'center', 'left'] as GridFlow[]).map((flow) => (
          <button
            key={flow}
            className={`ui-segmented-btn ${gridFlow === flow ? 'active' : ''}`}
            aria-pressed={gridFlow === flow}
            onClick={() => onGridFlowChange(flow)}
          >
            <span>{t(`settings.appearance.gridFlows.${flow}`)}</span>
            <span className="ui-segmented-hint">{t(`settings.appearance.gridFlowHints.${flow}`)}</span>
          </button>
        ))}
      </div>

      <div style={{ height: 24 }} />
      <h3>{t('settings.appearance.histogramStyle')}</h3>
      <p className="settings-hint">{t('settings.appearance.histogramStyleHint')}</p>
      <div className="settings-style-grid">
        <StyleOption
          name={t('settings.appearance.histogramStyles.filled')}
          description={t('settings.appearance.histogramStyles.filledHint')}
          active={histogramStyle === 'filled'}
          onClick={() => onHistogramStyleChange('filled')}
        >
          <HistogramPreview style="filled" />
        </StyleOption>
        <StyleOption
          name={t('settings.appearance.histogramStyles.lines')}
          description={t('settings.appearance.histogramStyles.linesHint')}
          active={histogramStyle === 'lines'}
          onClick={() => onHistogramStyleChange('lines')}
        >
          <HistogramPreview style="lines" />
        </StyleOption>
        <StyleOption
          name={t('settings.appearance.histogramStyles.hybrid')}
          description={t('settings.appearance.histogramStyles.hybridHint')}
          active={histogramStyle === 'hybrid'}
          onClick={() => onHistogramStyleChange('hybrid')}
        >
          <HistogramPreview style="hybrid" />
        </StyleOption>
      </div>
    </div>
  );
}
