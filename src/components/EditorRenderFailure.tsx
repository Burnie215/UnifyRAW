import { useTranslation } from 'react-i18next';

export function EditorRenderFailure({
  imageUrl,
  imageName,
  width,
  height,
  onImageLoad,
  onRetry,
}: {
  imageUrl: string;
  imageName: string;
  width?: number;
  height?: number;
  onImageLoad: (image: HTMLImageElement) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return <>
    <img
      src={imageUrl}
      alt={imageName}
      draggable={false}
      onDragStart={(event) => event.preventDefault()}
      className="editor-image editor-render-fallback"
      style={{ width, height }}
      onLoad={(event) => onImageLoad(event.currentTarget)}
    />
    <div className="editor-render-failure" role="alert">
      <span>{t('editor.renderFailed')}</span>
      <button type="button" onClick={onRetry}>{t('editor.retryRender')}</button>
    </div>
  </>;
}
