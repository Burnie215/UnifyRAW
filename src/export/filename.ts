/**
 * Filename builder for write-back exports.
 *
 * Scheme: `<stem>_edit_<hash8>.<ext>` (see plans/EXPORT_WRITEBACK_PLAN.md).
 * Same edit stack → same filename → source dedups and skips re-upload.
 */

const EXT_BY_FORMAT: Record<ExportFormat, string> = {
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  webp: 'webp',
  tiff: 'tif',
  tif: 'tif',
  dng: 'dng',
};

export type ExportFormat = 'jpeg' | 'jpg' | 'png' | 'webp' | 'tiff' | 'tif' | 'dng';

export function splitStem(filename: string): { stem: string; ext: string } {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return { stem: filename, ext: '' };
  return { stem: filename.slice(0, dot), ext: filename.slice(dot + 1) };
}

export function buildExportFilename(originalName: string, format: ExportFormat, hash8: string): string {
  const { stem } = splitStem(originalName);
  const ext = EXT_BY_FORMAT[format];
  return `${stem}_edit_${hash8}.${ext}`;
}
