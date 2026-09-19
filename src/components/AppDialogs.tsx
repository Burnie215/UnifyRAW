import { AddSourceDialog } from './AddSourceDialog';
import { ExportDialog, type ExportDestination } from './ExportDialog';
import { UnexportedEditModal } from './UnexportedEditModal';
import { PrintDialog } from './PrintDialog';
import { Slideshow } from './Slideshow';
import { AboutDialog } from './AboutDialog';
import { SettingsDialog, type SidecarSourceInfo } from './SettingsDialog';
import type { PhotoView, SourceRow } from '../storage/repos';
import type { GridFlow, HistogramStyle } from '../types';
import type { ExportOptions, RenderedFrame } from '../engine/Exporter';
import type { ExportPixelSize, SourceFormat } from '../export/exportChoices';
import type { ImportPreset } from '../hooks/useImportPreset';
import type { useDialogState } from '../hooks/useDialogState';
import type { UiPreferences } from '../hooks/useUiPreferences';
import type { CreatePhotoLibraryRequest } from '@photolib/shared';
import type { SourceTransportMode } from '../platform/sourceTransport';
import type { PushBlockedReason } from '../export/pushToSource';

interface AppDialogsProps {
  dialogs: ReturnType<typeof useDialogState>;
  // RAW development
  rawDevSelected: import('../storage/repos').PhotoView[];
  rawDevProfiles: import('../storage/repos').DevelopProfileRow[];
  rawDevLensProfiles: import('../storage/repos').LensProfileRow[];
  onDeleteRawDevProfile: (id: number) => void;
  onDeleteLensProfile: (id: number) => void;
  /** The bench, rendered inline in the settings pane. */
  rawDevBench: React.ReactNode;
  // AddSource
  onAddLocal: () => void | Promise<void>;
  onAddImmich: (serverUrl: string, apiKey: string, label: string, albumIds?: string[], transport?: SourceTransportMode) => Promise<boolean>;
  onAddImmichV3: (serverUrl: string, apiKey: string, label: string, albumIds?: string[], transport?: SourceTransportMode) => Promise<boolean>;
  onAddServerPath: (serverUrl: string, rootPath: string, label: string) => Promise<boolean>;
  onAddWebDAV: (url: string, username: string, password: string, label: string, transport?: SourceTransportMode, selectedPaths?: string[]) => Promise<boolean>;
  onAddS3: (endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string, region: string, prefix: string, label: string) => Promise<boolean>;
  onAddDropbox: (accessToken: string, rootPath: string, label: string) => Promise<boolean>;
  onAddGoogleDrive: (accessToken: string, folderId: string, label: string) => Promise<boolean>;
  onAddGeneric: (type: string, config: Record<string, string>, label: string) => Promise<boolean>;
  onAddPhotoLibLibrary: (
    request: CreatePhotoLibraryRequest,
    files: File[],
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  // Export
  onExport: (options: ExportOptions & { exportXmp?: boolean; destination?: ExportDestination }) => Promise<void>;
  exportSelectedCount: number;
  /** True only when every selected original carries more than 8 bits. */
  canExport16Bit: boolean;
  canPushToSource: boolean;
  /** Why the source destination is missing, when it is. */
  pushBlockedReason?: PushBlockedReason;
  sourceLabel?: string;
  // Unexported edit, asked when the editor is left
  onLeaveWithoutExport: () => void;
  onExportBeforeLeaving: () => void;
  onCancelLeave: () => void;
  onSuppressExportReminder: (suppressed: boolean) => void;
  /** What the write-back target accepts; undefined when nothing can be pushed. */
  allowedSourceFormats?: readonly SourceFormat[];
  /** Pixel sizes of the originals an export would render, for the estimate. */
  exportTargetSizes?: readonly ExportPixelSize[];
  // Print
  /** Renders one photo through the engine - the same stage the export uses. */
  onRenderPrintTarget: (photo: PhotoView, maxLongEdge: number | null) => Promise<RenderedFrame>;
  // Slideshow
  slideshowPhotos: PhotoView[];
  slideshowStartIndex: number;
  getDisplayUrl: (photo: PhotoView) => Promise<string | null>;
  // Settings
  sources: SourceRow[];
  onRemoveSource: (id: string) => void;
  onRescanSource: (id: string) => void;
  onOpenAddSourceFromSettings: () => void;
  scanning: boolean;
  photoCountBySource: Record<string, number>;
  getAutoRefresh: (id: string) => boolean;
  onAutoRefreshChange: (id: string, enabled: boolean) => void;
  autoPushMetadata: boolean;
  onAutoPushMetadataChange: (enabled: boolean) => void;
  gridFlow: GridFlow;
  onGridFlowChange: (flow: GridFlow) => void;
  histogramStyle: HistogramStyle;
  onHistogramStyleChange: (s: HistogramStyle) => void;
  importPreset: ImportPreset;
  onImportPresetChange: (u: Partial<ImportPreset>) => void;
  onImportPresetReset: () => void;
  presetNames: string[];
  sidecarSources?: SidecarSourceInfo[];
  sidecarBusy?: boolean;
  onRegenerateSidecarThumbs?: (sourceId?: string) => Promise<void>;
  onDeleteSidecarThumbs?: (sourceId?: string) => Promise<void>;
  hasNativeFSSidecar: boolean;
  selfHosted: boolean;
  uiPrefs: UiPreferences;
  onUiPrefsChange: (patch: Partial<UiPreferences>) => void;
  onUiPrefsReset: () => void;
}

export function AppDialogs(p: AppDialogsProps) {
  const { dialogs } = p;
  return (
    <>
      <AddSourceDialog
        open={dialogs.showAddSource}
        onClose={() => dialogs.closeAddSource()}
        onAddLocal={p.onAddLocal}
        onAddImmich={p.onAddImmich}
        onAddImmichV3={p.onAddImmichV3}
        onAddServerPath={p.onAddServerPath}
        onAddWebDAV={p.onAddWebDAV}
        onAddS3={p.onAddS3}
        onAddDropbox={p.onAddDropbox}
        onAddGoogleDrive={p.onAddGoogleDrive}
        onAddGeneric={p.onAddGeneric}
        onAddPhotoLibLibrary={p.onAddPhotoLibLibrary}
      />

      <ExportDialog
        open={dialogs.showExport}
        onClose={() => dialogs.closeExport()}
        onExport={p.onExport}
        selectedCount={p.exportSelectedCount}
        canExport16Bit={p.canExport16Bit}
        exporting={dialogs.exporting}
        progress={dialogs.exportProgress}
        canPushToSource={p.canPushToSource}
        pushBlockedReason={p.pushBlockedReason}
        sourceLabel={p.sourceLabel}
        defaultDestination={dialogs.exportDestination}
        allowedSourceFormats={p.allowedSourceFormats}
        targetSizes={p.exportTargetSizes}
      />

      {dialogs.showUnexportedEdit && (
        <UnexportedEditModal
          sourceLabel={p.sourceLabel}
          onLeave={p.onLeaveWithoutExport}
          onExport={p.onExportBeforeLeaving}
          onCancel={p.onCancelLeave}
          onSuppress={p.onSuppressExportReminder}
        />
      )}

      <PrintDialog
        open={dialogs.showPrint}
        onClose={dialogs.closePrint}
        targets={dialogs.printTargets}
        renderTarget={p.onRenderPrintTarget}
      />

      {dialogs.showSlideshow && p.slideshowPhotos.length > 0 && (
        <Slideshow
          photos={p.slideshowPhotos}
          startIndex={p.slideshowStartIndex}
          onClose={() => dialogs.closeSlideshow()}
          getDisplayUrl={p.getDisplayUrl}
        />
      )}

      <AboutDialog open={dialogs.showAbout} onClose={() => dialogs.closeAbout()} />

      <SettingsDialog
        open={dialogs.showSettings}
        focusSources={dialogs.settingsSection === 'sources'}
        onClose={() => dialogs.closeSettings()}
        sources={p.sources}
        onRemoveSource={p.onRemoveSource}
        onRescanSource={p.onRescanSource}
        onAddSource={p.onOpenAddSourceFromSettings}
        scanning={p.scanning}
        photoCountBySource={p.photoCountBySource}
        getAutoRefresh={p.getAutoRefresh}
        onAutoRefreshChange={p.onAutoRefreshChange}
        autoPushMetadata={p.autoPushMetadata}
        onAutoPushMetadataChange={p.onAutoPushMetadataChange}
        gridFlow={p.gridFlow}
        onGridFlowChange={p.onGridFlowChange}
        histogramStyle={p.histogramStyle}
        onHistogramStyleChange={p.onHistogramStyleChange}
        importPreset={p.importPreset}
        onImportPresetChange={p.onImportPresetChange}
        onImportPresetReset={p.onImportPresetReset}
        presetNames={p.presetNames}
        sidecarSources={p.sidecarSources}
        sidecarBusy={p.sidecarBusy}
        onRegenerateSidecarThumbs={p.onRegenerateSidecarThumbs}
        onDeleteSidecarThumbs={p.onDeleteSidecarThumbs}
        hasNativeFSSidecar={p.hasNativeFSSidecar}
        rawDevSelected={p.rawDevSelected}
        rawDevProfiles={p.rawDevProfiles}
        rawDevLensProfiles={p.rawDevLensProfiles}
        onDeleteRawDevProfile={p.onDeleteRawDevProfile}
        onDeleteLensProfile={p.onDeleteLensProfile}
        rawDevBench={p.rawDevBench}
        selfHosted={p.selfHosted}
        uiPrefs={p.uiPrefs}
        onUiPrefsChange={p.onUiPrefsChange}
        onUiPrefsReset={p.onUiPrefsReset}
      />
    </>
  );
}
