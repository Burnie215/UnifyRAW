import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExportOptions } from '../engine/Exporter';
import type { OutputColorSpaceId } from '../engine/outputColorSpaces';
import { defaultExportColorSpace, exportableColorSpaces } from '../engine/outputColorSpaces';
import {
  estimateExportBytes,
  formatEstimatedBytes,
  planExportChoices,
  type ExportPixelSize,
  type SourceFormat,
} from '../export/exportChoices';
import type { PushBlockedReason } from '../export/pushToSource';
import './ExportDialog.css';

export type ExportDestination = 'download' | 'source';

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  onExport: (options: ExportOptions & { exportXmp?: boolean; destination: ExportDestination }) => void;
  /** For batch export: number of selected photos */
  selectedCount?: number;
  /** Is export in progress? */
  exporting?: boolean;
  progress?: { done: number; total: number };
  /** If true, allow „push back to source" as a destination. */
  canPushToSource?: boolean;
  /**
   * Why there is no source destination. Only a selection spanning several
   * sources gets a sentence: a source that cannot write back is the normal
   * case and would put a hint under nearly every export.
   */
  pushBlockedReason?: PushBlockedReason;
  /** Label of the source we'd push to (e.g. „Immich"). */
  sourceLabel?: string;
  /** Which target is preselected each time the dialog opens. */
  defaultDestination?: ExportDestination;
  /** Explicit source capability. Safe-defaults to false until source
   * detection can prove that real 16-bit pixels are available. */
  canExport16Bit?: boolean;
  /**
   * What the write-back target accepts (`SourceExportCapabilities`). Only read
   * for destination „source", where it outranks every other rule.
   */
  allowedSourceFormats?: readonly SourceFormat[];
  /** Pixel sizes of the originals an export would render, for the estimate. */
  targetSizes?: readonly ExportPixelSize[];
}

export function ExportDialog({
  open, onClose, onExport, selectedCount, exporting, progress,
  canPushToSource, pushBlockedReason, sourceLabel, canExport16Bit = false,
  defaultDestination = 'download',
  allowedSourceFormats, targetSizes,
}: ExportDialogProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportOptions['format']>('jpeg');
  const [quality, setQuality] = useState(92);
  const [maxWidth, setMaxWidth] = useState('');
  const [maxHeight, setMaxHeight] = useState('');
  const [watermark, setWatermark] = useState('');
  const [bitDepth, setBitDepth] = useState<8 | 16>(8);
  const [tiffCompression, setTiffCompression] = useState<'deflate' | 'none'>('deflate');
  const [includeRetouch, setIncludeRetouch] = useState(true);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [fileNameTemplate, setFileNameTemplate] = useState('{name}_edited');
  const [exportXmp, setExportXmp] = useState(false);
  // Only spaces with an ICC profile on file: the graph renders IN the chosen
  // space, and a file that cannot say which space it is in is read as sRGB.
  const [colorSpace, setColorSpace] = useState<OutputColorSpaceId>(defaultExportColorSpace);
  const [destination, setDestination] = useState<ExportDestination>(defaultDestination);

  // Every opening starts at the target the caller asked for - the unexported-
  // edit modal opens this dialog on the source, the toolbar on the download.
  // Inside one opening the user's choice stands.
  useEffect(() => {
    if (!open) return;
    // The whole destination row is hidden without a writable source, so a
    // preselected „source" there would be a target nobody can see or undo.
    setDestination(defaultDestination === 'source' && !canPushToSource ? 'download' : defaultDestination);
  }, [open, defaultDestination, canPushToSource]);

  if (!open) return null;

  // Every "what may be offered" question is answered in one place, off the
  // render path: which formats, which depths, and why a depth is locked. The
  // buttons below only draw the answer - a control that disagrees with the
  // export it triggers is the bug this shape rules out.
  const plan = planExportChoices({
    destination,
    format,
    bitDepth,
    sourceCanExport16Bit: canExport16Bit,
    allowedSourceFormats,
  });
  const lock16 = plan.depths.find((choice) => choice.depth === 16)?.reason;

  const maxWidthNumber = maxWidth ? Number(maxWidth) : undefined;
  const maxHeightNumber = maxHeight ? Number(maxHeight) : undefined;
  const estimatedBytes = estimateExportBytes({
    targets: targetSizes ?? [],
    format: plan.format,
    bitDepth: plan.bitDepth,
    tiffCompression,
    quality,
    maxWidth: maxWidthNumber,
    maxHeight: maxHeightNumber,
  });

  const handleExport = () => {
    onExport({
      format: plan.format,
      quality,
      maxWidth: maxWidthNumber,
      maxHeight: maxHeightNumber,
      watermark: plan.bitDepth === 16 ? undefined : (watermark || undefined),
      bitDepth: plan.bitDepth,
      tiffCompression: plan.showCompression ? tiffCompression : undefined,
      includeRetouch: plan.bitDepth === 16 ? false : includeRetouch,
      includeMetadata,
      fileNameTemplate,
      colorSpace,
      exportXmp,
      destination,
    });
  };

  const count = selectedCount ?? 1;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{count > 1 ? t('dialogs.export.titleCount', { count }) : t('common.export')}</h3>
          <button className="dialog-close" onClick={onClose}>&times;</button>
        </div>

        <div className="dialog-body">
          {/* Destination */}
          {canPushToSource && (
            <div className="export-row">
              <label>{t('dialogs.export.destination')}</label>
              <div className="export-format-btns">
                <button className={`export-fmt-btn ${destination === 'download' ? 'active' : ''}`}
                  onClick={() => setDestination('download')}>
                  {t('dialogs.export.destDownload')}
                </button>
                <button className={`export-fmt-btn ${destination === 'source' ? 'active' : ''}`}
                  onClick={() => setDestination('source')}>
                  {sourceLabel ?? t('dialogs.export.destSource')}
                </button>
              </div>
            </div>
          )}
          {!canPushToSource && pushBlockedReason === 'mixed-sources' && (
            <div className="export-row">
              <label>{t('dialogs.export.destination')}</label>
              <span className="export-hint">{t('dialogs.export.destMixedSources')}</span>
            </div>
          )}

          {/* Bit depth. Always both buttons: a locked 16 that stays on screen
              with its reason is findable, a hidden one is not. */}
          <div className="export-row export-row-wrap">
            <label>{t('dialogs.export.bitDepth')}</label>
            <div className="export-format-btns">
              {plan.depths.map((choice) => (
                <button key={choice.depth}
                  className={`export-fmt-btn ${plan.bitDepth === choice.depth ? 'active' : ''}`}
                  disabled={!choice.enabled}
                  onClick={() => setBitDepth(choice.depth)}>
                  {t('dialogs.export.bits', { count: choice.depth })}
                </button>
              ))}
            </div>
            {lock16 && (
              <span className="export-lock-reason">{t(`dialogs.export.depthLocked.${lock16}`)}</span>
            )}
          </div>

          {/* Format */}
          <div className="export-row">
            <label>{t('dialogs.export.format')}</label>
            <div className="export-format-btns">
              {plan.formats.map((f) => (
                <button key={f} className={`export-fmt-btn ${plan.format === f ? 'active' : ''}`}
                  onClick={() => setFormat(f)}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {plan.showCompression && (
            <div className="export-row">
              <label>{t('dialogs.export.compression')}</label>
              <div className="export-format-btns">
                {(['deflate', 'none'] as const).map((compression) => (
                  <button
                    key={compression}
                    className={`export-fmt-btn ${tiffCompression === compression ? 'active' : ''}`}
                    onClick={() => setTiffCompression(compression)}
                  >
                    {t(`dialogs.export.compression${compression === 'deflate' ? 'Deflate' : 'None'}`)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Estimated size for the current combination, before anything renders. */}
          <div className="export-row">
            <label>{t('dialogs.export.estimatedSize')}</label>
            <span className="export-value">
              {estimatedBytes === null
                ? t('dialogs.export.estimatedSizeUnknown')
                : t('dialogs.export.estimatedSizeValue', { size: formatEstimatedBytes(estimatedBytes) })}
            </span>
          </div>

          {/* Quality */}
          {plan.showQuality && (
            <div className="export-row">
              <label>{t('dialogs.export.quality')}</label>
              <input type="range" min={10} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
              <span className="export-value">{quality}%</span>
            </div>
          )}

          {/* Max dimensions */}
          <div className="export-row export-row-wrap">
            <label>{t('dialogs.export.maxSize')}</label>
            <div className="export-dims">
              <input type="number" placeholder={t('dialogs.export.width')} value={maxWidth} onChange={(e) => setMaxWidth(e.target.value)} />
              <span>×</span>
              <input type="number" placeholder={t('dialogs.export.height')} value={maxHeight} onChange={(e) => setMaxHeight(e.target.value)} />
              <span>px</span>
            </div>
            {plan.bitDepth === 16 && (
              <span className="export-size-hint">{t('dialogs.export.sizeHint16')}</span>
            )}
          </div>

          {/* Filename */}
          <div className="export-row">
            <label>{t('dialogs.export.filename')}</label>
            <input type="text" value={fileNameTemplate} onChange={(e) => setFileNameTemplate(e.target.value)} placeholder="{name}_edited" />
            <span className="export-hint">{t('dialogs.export.filenameHint')}</span>
          </div>

          {/* Watermark */}
          <div className="export-row">
            <label>{t('dialogs.export.watermark')}</label>
            <input type="text"
              placeholder={plan.bitDepth === 16
                ? t('dialogs.export.unavailable16')
                : t('dialogs.export.watermarkPlaceholder')}
              value={watermark} onChange={(e) => setWatermark(e.target.value)}
              disabled={plan.bitDepth === 16} />
          </div>

          <div className="export-row">
            <label>{t('dialogs.export.spotRemoval')}</label>
            <label className="export-checkbox">
              <input type="checkbox" checked={plan.bitDepth === 16 ? false : includeRetouch}
                onChange={(e) => setIncludeRetouch(e.target.checked)} disabled={plan.bitDepth === 16} />
              <span>{plan.bitDepth === 16
                ? t('dialogs.export.unavailable16')
                : t('dialogs.export.includeSpotRemoval')}</span>
            </label>
          </div>

          {/* Color Space */}
          <div className="export-row">
            <label>{t('dialogs.export.colorSpace')}</label>
            <select value={colorSpace} onChange={(e) => setColorSpace(e.target.value as OutputColorSpaceId)}>
              {exportableColorSpaces().map((cs) => (
                <option key={cs.id} value={cs.id}>{cs.displayName}</option>
              ))}
            </select>
          </div>

          {/* Metadata */}
          <div className="export-row">
            <label>{t('dialogs.export.metadata')}</label>
            <label className="export-checkbox">
              <input type="checkbox" checked={includeMetadata} onChange={(e) => setIncludeMetadata(e.target.checked)} />
              <span>{t('dialogs.export.keepExif')}</span>
            </label>
          </div>

          {/* XMP */}
          <div className="export-row">
            <label>{t('dialogs.export.xmpSidecar')}</label>
            <label className="export-checkbox">
              <input type="checkbox" checked={exportXmp} onChange={(e) => setExportXmp(e.target.checked)} />
              <span>{t('dialogs.export.saveXmp')}</span>
            </label>
          </div>

          {/* Progress */}
          {exporting && progress && (
            <div className="export-progress">
              <div className="export-progress-bar" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
              <span>{progress.done} / {progress.total}</span>
            </div>
          )}

          <button className="dialog-submit" onClick={handleExport} disabled={exporting}>
            {exporting ? t('dialogs.export.exporting') : count > 1 ? t('dialogs.export.exportN', { count }) : t('dialogs.export.exportOne')}
          </button>
        </div>
      </div>
    </div>
  );
}
