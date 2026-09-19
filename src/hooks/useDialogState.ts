import { useState, useCallback } from 'react';
import type { PhotoView } from '../storage/repos';
import type { ExportDestination } from '../components/ExportDialog';

/** What the print dialog is asked to print. The photo, not a URL: the dialog
 *  renders each one through the engine, so it needs the photo to look up its
 *  document, its base development and its RAW pixels (F071). */
export interface PrintTarget {
  photo: PhotoView;
  name: string;
}

export type SettingsSection = 'sources';

export function useDialogState() {
  const [showAddSource, setShowAddSource] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exportDestination, setExportDestination] = useState<ExportDestination>('download');
  const [showUnexportedEdit, setShowUnexportedEdit] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  const [printTargets, setPrintTargets] = useState<PrintTarget[]>([]);
  const [showSlideshow, setShowSlideshow] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState({ done: 0, total: 0 });

  const openAddSource = useCallback(() => setShowAddSource(true), []);
  const closeAddSource = useCallback(() => setShowAddSource(false), []);
  /** `destination` preselects the dialog's target; the user may still change it. */
  const openExport = useCallback((destination: ExportDestination = 'download') => {
    setExportDestination(destination);
    setShowExport(true);
  }, []);
  const closeExport = useCallback(() => setShowExport(false), []);
  const openUnexportedEdit = useCallback(() => setShowUnexportedEdit(true), []);
  const closeUnexportedEdit = useCallback(() => setShowUnexportedEdit(false), []);
  const openPrint = useCallback((targets: PrintTarget[]) => {
    setPrintTargets(targets);
    setShowPrint(true);
  }, []);
  const closePrint = useCallback(() => { setShowPrint(false); setPrintTargets([]); }, []);
  const openSlideshow = useCallback(() => setShowSlideshow(true), []);
  const closeSlideshow = useCallback(() => setShowSlideshow(false), []);
  const openAbout = useCallback(() => setShowAbout(true), []);
  const closeAbout = useCallback(() => setShowAbout(false), []);
  const openSettings = useCallback((section?: SettingsSection) => {
    setSettingsSection(section ?? null);
    setShowSettings(true);
  }, []);
  const closeSettings = useCallback(() => {
    setShowSettings(false);
    setSettingsSection(null);
  }, []);

  return {
    showAddSource, openAddSource, closeAddSource,
    showExport, exportDestination, openExport, closeExport,
    showUnexportedEdit, openUnexportedEdit, closeUnexportedEdit,
    showPrint, printTargets, openPrint, closePrint,
    showSlideshow, openSlideshow, closeSlideshow,
    showAbout, openAbout, closeAbout,
    showSettings, settingsSection, openSettings, closeSettings,
    exporting, setExporting,
    exportProgress, setExportProgress,
  };
}
