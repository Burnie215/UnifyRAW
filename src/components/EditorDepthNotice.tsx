import { useTranslation } from 'react-i18next';
import type { DepthFallback } from '../engine/raw/RawDecoderStrategy';
import './EditorDepthNotice.css';

/**
 * Per-photo notice that the image on screen carries less depth than its source.
 *
 * Dismissing is per photo and lives in the editor's state on purpose: the
 * condition is real, so re-opening the same photo says so again. A "don't show
 * again" setting would be wrong for an error state.
 */
export function EditorDepthNotice({ fallback, onDismiss }: {
  fallback: DepthFallback;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  // Three different facts to a photographer, so three sentences - the literal
  // keys also keep the locale gate able to see them.
  const text = fallback === 'raw-embedded-jpeg'
    ? t('editor.depthNotice.rawEmbedded')
    : fallback === 'raw-8bit'
      ? t('editor.depthNotice.raw8')
      : t('editor.depthNotice.heif8');

  return (
    <div className="editor-depth-notice" role="status">
      <div className="editor-depth-notice-body">
        <div className="editor-depth-notice-title">{t('editor.depthNotice.title')}</div>
        <div className="editor-depth-notice-text">{text}</div>
      </div>
      <button className="editor-depth-notice-dismiss" onClick={onDismiss}>
        {t('editor.depthNotice.dismiss')}
      </button>
    </div>
  );
}
