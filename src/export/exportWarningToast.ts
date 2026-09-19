import type { ExportWarning } from '../engine/Exporter';

type Translate = (key: string) => string;

export interface ExportWarningToastSpec {
  title: string;
  message: string;
  kind: 'warning';
  dedupeKey: string;
}

/** Map a recoverable encoder degradation to the warning shown by the app. */
export function exportWarningToast(warning: ExportWarning, t: Translate): ExportWarningToastSpec {
  switch (warning.code) {
    case 'deflate-unavailable':
      return {
        title: t('dialogs.export.deflateFallbackTitle'),
        message: t('dialogs.export.deflateFallback'),
        kind: 'warning',
        dedupeKey: 'tiff-deflate-unavailable',
      };
    case 'source-16bit-unavailable':
      return {
        title: t('dialogs.export.depthFallbackTitle'),
        message: t('dialogs.export.depthFallback'),
        kind: 'warning',
        dedupeKey: 'export-source-16bit-unavailable',
      };
  }
}
