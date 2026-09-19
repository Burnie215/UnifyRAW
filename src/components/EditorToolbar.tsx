import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CompareMode } from './BeforeAfter';
import type { PhotoView } from '../storage/repos';
import { extensionOf, isRawName } from '../data/rawPairing';
import type { MaskType } from '../engine/Mask';
import type { SegmentationType } from '../engine/ai';
import { MaskToolbar } from './MaskToolbar';
import { useAdjustments } from '../contexts/AdjustmentsContext';
import { useAdaptiveLayout } from '../contexts/AdaptiveLayoutContext';
import { usePhonePanelActions } from '../ui/phonePanelContext';
import { PanelResetIcon } from '../ui/ModularPanel';
import { defaultAdjustments } from '../types';


interface EditorToolbarProps {
  photoName: string;
  /** RAW/JPEG sibling of the open photo; enables the switch button. */
  pairPartner?: PhotoView | null;
  onSwitchPairPartner?: (photo: PhotoView) => void;
  onBack: () => void;
  onExport?: () => void;
  saving: boolean;
  compareMode: CompareMode;
  onCompareModeChange: (mode: CompareMode) => void;
  // Mask toolbar
  maskTool: MaskType | 'spot-heal' | 'spot-clone' | null;
  masksExist: boolean;
  onMaskToolSelect: (tool: MaskType | 'spot-heal' | 'spot-clone' | null) => void;
  brushRadius: number;
  brushFeather: number;
  brushFlow: number;
  brushErase: boolean;
  onBrushRadiusChange: (v: number) => void;
  onBrushFeatherChange: (v: number) => void;
  onBrushFlowChange: (v: number) => void;
  onBrushEraseToggle: () => void;
  showMaskOverlay: boolean;
  onToggleMaskOverlay: () => void;
  onAIMask: (type: SegmentationType) => void;
  aiLoading: boolean;
  /** Name of the active adjustment layer (shown as indicator when editing a layer) */
  activeLayerName?: string;
  // Zoom controls (direct props to avoid context issues)
  zoom: number;
  fitScale: number;
  onZoomChange: (z: number) => void;
  onPanReset: () => void;
  // Phase 4: render-mode toggle (Klassisch / Graph)
  renderMode?: 'classic' | 'graph';
  onRenderModeChange?: (mode: 'classic' | 'graph') => void;
}

export function EditorToolbar({
  photoName, pairPartner, onSwitchPairPartner, onBack, onExport, saving,
  compareMode, onCompareModeChange,
  maskTool, masksExist, onMaskToolSelect,
  brushRadius, brushFeather, brushFlow, brushErase,
  onBrushRadiusChange, onBrushFeatherChange, onBrushFlowChange, onBrushEraseToggle,
  showMaskOverlay, onToggleMaskOverlay,
  onAIMask, aiLoading, activeLayerName,
  zoom, fitScale, onZoomChange, onPanReset,
  renderMode = 'classic', onRenderModeChange,
}: EditorToolbarProps) {
  const { t } = useTranslation();
  const { canUndo, canRedo, onUndo, onRedo, onChange, hasChanges } = useAdjustments();
  const adaptiveLayout = useAdaptiveLayout();
  const phonePanels = usePhonePanelActions();

  if (adaptiveLayout.screen === 'phone') {
    return (
      <>
        <PhoneEditorToolbar
          onBack={onBack}
          onExport={onExport}
          saving={saving}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={onUndo}
          onRedo={onRedo}
          compareMode={compareMode}
          onCompareModeChange={onCompareModeChange}
          zoom={zoom}
          fitScale={fitScale}
          onZoomChange={onZoomChange}
          onPanReset={onPanReset}
          renderMode={renderMode}
          onRenderModeChange={onRenderModeChange}
          toolsAvailable={phonePanels.available}
          onOpenTools={phonePanels.openToolPicker}
        />
        {maskTool && (
          <MaskToolbar
            activeTool={maskTool}
            onSelectTool={onMaskToolSelect}
            brushRadius={brushRadius}
            brushFeather={brushFeather}
            brushFlow={brushFlow}
            brushErase={brushErase}
            onBrushRadiusChange={onBrushRadiusChange}
            onBrushFeatherChange={onBrushFeatherChange}
            onBrushFlowChange={onBrushFlowChange}
            onBrushEraseToggle={onBrushEraseToggle}
            showMaskOverlay={showMaskOverlay}
            onToggleMaskOverlay={onToggleMaskOverlay}
            onAIMask={onAIMask}
            aiLoading={aiLoading}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div className="editor-toolbar">
        <button className="back-btn" onClick={onBack} title={t('editor.backToLibrary')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 3L5 8l5 5" />
          </svg>
          {t('editor.library')}
        </button>
        <span className="editor-filename">{photoName}</span>
        {pairPartner && onSwitchPairPartner && (
          <button
            className="editor-pair-switch"
            onClick={() => onSwitchPairPartner(pairPartner)}
            title={t(isRawName(pairPartner.name) ? 'editor.switchToRaw' : 'editor.switchToDisplay', {
              name: pairPartner.name,
            })}
          >
            <SwitchIcon />
            {extensionOf(pairPartner.name).toUpperCase()}
          </button>
        )}
        {activeLayerName && (
          <span className="editor-active-layer" title={t('editor.editingLayer', { name: activeLayerName })}>
            {activeLayerName}
          </span>
        )}
        <div className="toolbar-spacer" />

        {/* Display controls (pipeline view, compare, zoom) live in the status
            bar, bottom right — same place as the library's display controls. */}

        {/* Reset — same icon and accent colour the panels use to say "this has
            been changed", so one glance covers the whole edit. */}
        {hasChanges && (
          <button
            className="toolbar-icon-btn toolbar-reset-btn"
            onClick={() => onChange({ ...defaultAdjustments })}
            title={t('uiShell.metaPanels.reset')}
            aria-label={t('uiShell.metaPanels.reset')}
          >
            <PanelResetIcon size={14} />
          </button>
        )}

        {/* Undo/Redo */}
        <button className="toolbar-icon-btn" onClick={onUndo} disabled={!canUndo} title={t('editor.undoTitle')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 5h6a3 3 0 010 6H7" /><path d="M5 3L3 5l2 2" />
          </svg>
        </button>
        <button className="toolbar-icon-btn" onClick={onRedo} disabled={!canRedo} title={t('editor.redoTitle')}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M11 5H5a3 3 0 000 6h2" /><path d="M9 3l2 2-2 2" />
          </svg>
        </button>

        {/* Export */}
        {onExport && (
          <button className="toolbar-icon-btn" onClick={onExport} title={t('editor.exportTitle')}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M7 1v8M3 5l4-4 4 4" /><path d="M2 10v2h10v-2" />
            </svg>
          </button>
        )}

        {saving && <span className="save-indicator">{t('editor.savingShort')}</span>}
      </div>

      {/* Mask toolbar */}
      {(maskTool || masksExist) && (
        <MaskToolbar
          activeTool={maskTool}
          onSelectTool={onMaskToolSelect}
          brushRadius={brushRadius}
          brushFeather={brushFeather}
          brushFlow={brushFlow}
          brushErase={brushErase}
          onBrushRadiusChange={onBrushRadiusChange}
          onBrushFeatherChange={onBrushFeatherChange}
          onBrushFlowChange={onBrushFlowChange}
          onBrushEraseToggle={onBrushEraseToggle}
          showMaskOverlay={showMaskOverlay}
          onToggleMaskOverlay={onToggleMaskOverlay}
          onAIMask={onAIMask}
          aiLoading={aiLoading}
        />
      )}
    </>
  );
}

interface PhoneEditorToolbarProps {
  onBack: () => void;
  onExport?: () => void;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  compareMode: CompareMode;
  onCompareModeChange: (mode: CompareMode) => void;
  zoom: number;
  fitScale: number;
  onZoomChange: (zoom: number) => void;
  onPanReset: () => void;
  renderMode: 'classic' | 'graph';
  onRenderModeChange?: (mode: 'classic' | 'graph') => void;
  toolsAvailable: boolean;
  onOpenTools: (returnFocusTo?: HTMLElement | null) => void;
}

function PhoneEditorToolbar({
  onBack, onExport, saving, canUndo, canRedo, onUndo, onRedo,
  compareMode, onCompareModeChange, zoom, fitScale, onZoomChange, onPanReset,
  renderMode, onRenderModeChange, toolsAvailable, onOpenTools,
}: PhoneEditorToolbarProps) {
  const { t } = useTranslation();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

  const closeOverflow = useCallback((restoreFocus = true) => {
    setOverflowOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => overflowTriggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!overflowOpen) return;
    const frame = window.requestAnimationFrame(() => {
      overflowMenuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeOverflow();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeOverflow, overflowOpen]);

  const runAndClose = useCallback((action: () => void) => {
    action();
    closeOverflow();
  }, [closeOverflow]);

  const cycleCompareMode = useCallback(() => {
    const modes: CompareMode[] = ['off', 'split', 'side-by-side', 'toggle'];
    onCompareModeChange(modes[(modes.indexOf(compareMode) + 1) % modes.length]);
  }, [compareMode, onCompareModeChange]);

  const handleOverflowKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
    if (items.length === 0) return;

    if (event.key === 'Tab') {
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }

    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1 + items.length) % items.length;
    else nextIndex = (currentIndex - 1 + items.length) % items.length;
    items[nextIndex]?.focus();
  }, []);

  const compareLabel = t(`compare.${compareMode === 'side-by-side' ? 'sideBySide' : compareMode}`);

  return (
    <>
      <div className="phone-editor-toolbar" data-testid="phone-editor-toolbar">
        <button
          className="phone-editor-toolbar-btn"
          onClick={onBack}
          aria-label={t('editor.backToLibrary')}
          title={t('editor.backToLibrary')}
        >
          <BackToolbarIcon />
        </button>
        <button
          className="phone-editor-toolbar-btn"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label={t('editor.undoTitle')}
          title={t('editor.undoTitle')}
        >
          <UndoToolbarIcon />
        </button>
        <button
          className="phone-editor-tools-btn"
          data-testid="phone-editor-tools-trigger"
          onClick={(event) => onOpenTools(event.currentTarget)}
          disabled={!toolsAvailable}
          aria-haspopup="dialog"
          aria-label={t('editor.phoneTools.open')}
        >
          <SlidersToolbarIcon />
          <span>{t('editor.phoneTools.open')}</span>
        </button>
        <span className="phone-editor-toolbar-spacer" />
        {saving && (
          <span className="phone-editor-saving" role="status" aria-live="polite" aria-label={t('editor.savingShort')}>
            <span aria-hidden="true" />
          </span>
        )}
        <button
          ref={overflowTriggerRef}
          className={`phone-editor-toolbar-btn ${overflowOpen ? 'active' : ''}`}
          onClick={() => setOverflowOpen((open) => !open)}
          aria-label={t('editor.phoneMenu.more')}
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          aria-controls="phone-editor-overflow-menu"
        >
          <MoreToolbarIcon />
        </button>
      </div>

      {overflowOpen && (
        <div className="phone-editor-overflow-layer">
          <button
            className="phone-editor-overflow-backdrop"
            onClick={() => closeOverflow()}
            aria-label={t('common.close')}
            tabIndex={-1}
          />
          <div
            ref={overflowMenuRef}
            id="phone-editor-overflow-menu"
            className="phone-editor-overflow-menu"
            role="menu"
            aria-label={t('editor.phoneMenu.title')}
            onKeyDown={handleOverflowKeyDown}
          >
            <button role="menuitem" onClick={() => runAndClose(onRedo)} disabled={!canRedo}>
              <RedoToolbarIcon />
              <span>{t('editor.phoneMenu.redo')}</span>
            </button>
            <button
              role="menuitem"
              className={compareMode !== 'off' ? 'active' : ''}
              onClick={() => runAndClose(cycleCompareMode)}
            >
              <CompareToolbarIcon />
              <span>{t('editor.phoneMenu.compare')}</span>
              <small>{compareLabel}</small>
            </button>
            <div className="phone-editor-overflow-separator" role="separator" />
            <button role="menuitem" onClick={() => runAndClose(() => { onZoomChange(1); onPanReset(); })}>
              <FitToolbarIcon />
              <span>{t('editor.phoneMenu.fit')}</span>
              <small>{Math.round(fitScale * 100)}%</small>
            </button>
            <button role="menuitem" onClick={() => runAndClose(() => onZoomChange(Math.max(1, zoom - 0.5)))} disabled={zoom <= 1}>
              <ZoomOutToolbarIcon />
              <span>{t('editor.phoneMenu.zoomOut')}</span>
              <small>{Math.round(fitScale * zoom * 100)}%</small>
            </button>
            <button role="menuitem" onClick={() => runAndClose(() => onZoomChange(Math.min(8, zoom + 0.5)))} disabled={zoom >= 8}>
              <ZoomInToolbarIcon />
              <span>{t('editor.phoneMenu.zoomIn')}</span>
            </button>
            {onRenderModeChange && (
              <button
                role="menuitem"
                onClick={() => runAndClose(() => onRenderModeChange(renderMode === 'classic' ? 'graph' : 'classic'))}
              >
                <ViewModeToolbarIcon />
                <span>{renderMode === 'classic' ? t('editor.phoneMenu.graphView') : t('editor.phoneMenu.classicView')}</span>
              </button>
            )}
            {onExport && (
              <>
                <div className="phone-editor-overflow-separator" role="separator" />
                <button role="menuitem" onClick={() => runAndClose(onExport)}>
                  <ExportToolbarIcon />
                  <span>{t('editor.phoneMenu.export')}</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function BackToolbarIcon() {
  return <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 4l-7 7 7 7" /></svg>;
}

function UndoToolbarIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M5 7h8a4 4 0 010 8H9" /><path d="M8 4L5 7l3 3" /></svg>;
}

function RedoToolbarIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M15 7H7a4 4 0 000 8h4" /><path d="M12 4l3 3-3 3" /></svg>;
}

function SlidersToolbarIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" /><circle cx="7" cy="5" r="2" fill="var(--bg-secondary)" /><circle cx="13" cy="10" r="2" fill="var(--bg-secondary)" /><circle cx="8" cy="15" r="2" fill="var(--bg-secondary)" /></svg>;
}

function MoreToolbarIcon() {
  return <svg width="22" height="22" viewBox="0 0 22 22" fill="currentColor" aria-hidden="true"><circle cx="5" cy="11" r="1.6" /><circle cx="11" cy="11" r="1.6" /><circle cx="17" cy="11" r="1.6" /></svg>;
}

function CompareToolbarIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2.5" y="2.5" width="15" height="15" rx="3" /><path d="M10 3v14" /></svg>;
}

function FitToolbarIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4" /><rect x="6" y="6" width="8" height="8" rx="1.5" /></svg>;
}

function ZoomOutToolbarIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M13 13l4 4M6 9h6" /></svg>;
}

function ZoomInToolbarIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M13 13l4 4M6 9h6M9 6v6" /></svg>;
}

function ViewModeToolbarIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2.5" /><path d="M7 3v14M10 7h5M10 10h5M10 13h3" /></svg>;
}

function ExportToolbarIcon() {
  return <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M10 2v10M6 6l4-4 4 4" /><path d="M3 11v5a2 2 0 002 2h10a2 2 0 002-2v-5" /></svg>;
}

function SwitchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M1 4h8M7 2l2 2-2 2M11 8H3M5 6L3 8l2 2" />
    </svg>
  );
}
