import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../storage/repos';
import type { ExifData } from '../hooks/useExif';
import type { EditorTool } from '../ui/ToolStrip';
import type { EditorPanelContentProps } from '../ui/useEditorPanelContent';
import { useEditorPanelContent } from '../ui/useEditorPanelContent';
import { PanelSystem } from '../ui/PanelSystem';
import { usePanelLayoutContext } from '../contexts/PanelLayoutContext';
import { PANEL_MAP } from '../ui/panelRegistry';
import { Filmstrip } from '../ui/Filmstrip';
import { useBrand } from '../brand';
import { useAdjustments } from '../contexts/AdjustmentsContext';
import { modifiedAdjustmentPanelIds, resetAdjustmentPanel } from '../ui/adjustmentPanelReset';

interface EditorPanelWrapperProps {
  panelContentProps: EditorPanelContentProps;
  toolbar: React.ReactNode;
  statusBar: React.ReactNode;
  activeTool: EditorTool;
  photo: PhotoView;
  exif?: ExifData | null;
  onBack: () => void;
  filmstripPhotos?: PhotoView[];
  onSelectPhoto?: (photo: PhotoView) => void;
  children: React.ReactNode;
  /** Suppress the right-side panel zone — used by graph-mode. */
  hideRightZone?: boolean;
}

/**
 * Renders inside AdjustmentsProvider + EditorProvider so that
 * useEditorPanelContent (and its sub-hooks) can access contexts.
 */
export function EditorPanelWrapper({
  panelContentProps, toolbar, statusBar, activeTool,
  photo, onBack, filmstripPhotos, onSelectPhoto, children, hideRightZone,
}: EditorPanelWrapperProps) {
  const { t } = useTranslation();
  const brand = useBrand();
  const [wordmarkFailed, setWordmarkFailed] = useState(false);
  useEffect(() => { setWordmarkFailed(false); }, [brand.wordmarkPath]);
  // Not its own instance: this wrapper remounts with every photo, and a second
  // owner would write the shared layout key from its mount snapshot.
  const panelLayout = usePanelLayoutContext();
  const panelContent = useEditorPanelContent(panelContentProps);
  const { adjustments, onChange } = useAdjustments();
  const modifiedPanelIds = useMemo(
    () => modifiedAdjustmentPanelIds(adjustments),
    [adjustments],
  );
  const handleResetPanel = useCallback((panelId: string) => {
    const reset = resetAdjustmentPanel(adjustments, panelId);
    if (reset !== adjustments) onChange(reset);
  }, [adjustments, onChange]);

  const filmstripContent = filmstripPhotos && filmstripPhotos.length > 0 && onSelectPhoto ? (
    <Filmstrip
      photos={filmstripPhotos}
      activePhotoId={photo.id ?? null}
      onSelect={onSelectPhoto}
      onOpen={onSelectPhoto}
      height={panelLayout.layout.bottomHeight}
      onHeightChange={(h) => panelLayout.resizeZone('bottom', h)}
    />
  ) : null;

  return (
    <PanelSystem
      layout={panelLayout.layout}
      panels={PANEL_MAP}
      panelContent={panelContent}
      onTogglePanel={panelLayout.togglePanel}
      onTogglePin={panelLayout.togglePin}
      onFloatPanel={panelLayout.floatPanel}
      onDockPanel={panelLayout.dockPanel}
      onUpdateFloatingPos={panelLayout.updateFloatingPos}
      onResizeZone={panelLayout.resizeZone}
      onDropPanel={panelLayout.dropPanel}
      modifiedPanelIds={modifiedPanelIds}
      onResetPanel={handleResetPanel}
      activeTool={activeTool}
      leftHeader={
        <div className="editor-left-header">
          <div className="editor-left-logo">
            {brand.wordmarkPath && !wordmarkFailed ? (
              <img
                src={brand.wordmarkPath}
                alt={brand.name}
                className="editor-left-wordmark"
                onError={() => setWordmarkFailed(true)}
              />
            ) : (
              brand.name
            )}
          </div>
          <button className="editor-left-nav active">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="5" /><path d="M8 3v10M3 8h10" /></svg>
            {t('editor.develop')}
          </button>
          <button className="editor-left-nav" onClick={onBack}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1" /><rect x="9" y="1" width="6" height="6" rx="1" /><rect x="1" y="9" width="6" height="6" rx="1" /><rect x="9" y="9" width="6" height="6" rx="1" /></svg>
            {t('editor.library')}
          </button>
        </div>
      }
      toolbar={toolbar}
      statusBar={statusBar}
      bottomContent={filmstripContent}
      hideRight={hideRightZone}
    >
      {children}
    </PanelSystem>
  );
}
