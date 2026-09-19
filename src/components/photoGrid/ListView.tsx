import { useState, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../../storage/repos';
import type { GroupMode } from '../../types';
import { useThumbnail } from '../../hooks/useThumbnail';
import { useStacks } from '../../contexts/StackContext';
import {
  groupByFolder, useIsVisible, Stars, FlagIcon, RejectIcon, Checkbox, formatDate, formatSize,
} from './shared';

interface ListViewProps {
  photos: PhotoView[];
  selectedIds: Set<number>;
  multiSelect: boolean;
  groupMode: GroupMode;
  onSelect: (p: PhotoView, m: boolean, s?: boolean) => void;
  onOpen: (p: PhotoView) => void;
  onContextMenu?: (p: PhotoView, e: React.MouseEvent) => void;
  loadMoreEl?: React.ReactNode;
}

export function ListView({ photos, selectedIds, multiSelect, groupMode, onSelect, onOpen, onContextMenu, loadMoreEl }: ListViewProps) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupMode === 'folder' ? groupByFolder(photos) : null, [photos, groupMode]);

  const header = (
    <div className="list-header">
      <span className="list-col-thumb" />
      <span className="list-col-name">{t('grid.columns.name')}</span>
      <span className="list-col-rating">{t('grid.columns.rating')}</span>
      <span className="list-col-flag">{t('grid.columns.flag')}</span>
      <span className="list-col-path">{t('grid.columns.path')}</span>
      <span className="list-col-date">{t('grid.columns.date')}</span>
      <span className="list-col-size">{t('grid.columns.size')}</span>
      <span className="list-col-type">{t('grid.columns.type')}</span>
    </div>
  );

  if (groups) {
    return (
      <div className="photo-grid list-view">
        {header}
        {groups.map((g) => (
          <ListFolderSection key={g.folder} folder={g.folder} count={g.photos.length}>
            {g.photos.map((photo) => (
              <ListRow key={photo.id} photo={photo} selected={selectedIds.has(photo.id!)} multiSelect={multiSelect} onSelect={onSelect} onOpen={onOpen} onContextMenu={onContextMenu} />
            ))}
          </ListFolderSection>
        ))}
        {loadMoreEl}
      </div>
    );
  }

  return (
    <div className="photo-grid list-view">
      {header}
      {photos.map((photo) => (
        <ListRow key={photo.id} photo={photo} selected={selectedIds.has(photo.id!)} multiSelect={multiSelect} onSelect={onSelect} onOpen={onOpen} onContextMenu={onContextMenu} />
      ))}
      {loadMoreEl}
    </div>
  );
}

function ListFolderSection({ folder, count, children }: { folder: string; count: number; children: React.ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const displayName = folder === '/' ? t('grid.rootFolder') : folder;

  return (
    <>
      <button className="list-folder-row" onClick={() => setOpen(!open)}>
        <svg className={`folder-chevron ${open ? 'open' : ''}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M3 2l4 3-4 3" />
        </svg>
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M1 3.5V11a1 1 0 001 1h10a1 1 0 001-1V5a1 1 0 00-1-1H7L5.5 2.5H2A1 1 0 001 3.5z" />
        </svg>
        <span>{displayName}</span>
        <span className="folder-count">{count}</span>
      </button>
      {open && children}
    </>
  );
}

function ListRow({ photo, selected, multiSelect, onSelect, onOpen, onContextMenu }: {
  photo: PhotoView; selected: boolean; multiSelect: boolean;
  onSelect: (p: PhotoView, m: boolean, s?: boolean) => void; onOpen: (p: PhotoView) => void;
  onContextMenu?: (p: PhotoView, e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const elRef = useRef<HTMLDivElement>(null);
  const isVisible = useIsVisible(elRef);
  const stacks = useStacks();
  const stack = stacks.index.get(photo.id);
  const stackOpen = !!stack && stacks.expanded.has(stack.id);
  const { url: thumbnailUrl } = useThumbnail(isVisible ? photo : { ...photo, id: undefined } as unknown as PhotoView);
  const path = photo.sourcePhotoId.split('/').slice(0, -1).join('/') || '/';
  const labelColor = photo.colorLabel ? `var(--label-${photo.colorLabel})` : undefined;
  return (
    <div
      ref={elRef}
      className={`list-row ${selected ? 'selected' : ''}`}
      style={labelColor ? { borderLeftColor: labelColor } : undefined}
      onClick={(e) => onSelect(photo, multiSelect || e.metaKey || e.ctrlKey, e.shiftKey)}
      onDoubleClick={() => onOpen(photo)}
      onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); onContextMenu(photo, e); } }}
    >
      {multiSelect && <Checkbox checked={selected} />}
      <span className="list-col-thumb">
        {thumbnailUrl ? <img src={thumbnailUrl} alt="" /> : <div className="list-thumb-loading" />}
      </span>
      <span className="list-col-name" title={photo.name}>
        {photo.name}
        {stack && (
          <button
            type="button"
            className={`list-stack-badge ${stackOpen ? 'open' : ''}`}
            title={stackOpen
              ? t('grid.stackCollapse', { count: stack.members.length })
              : t('grid.stackExpand', { count: stack.members.length })}
            aria-pressed={stackOpen}
            onClick={(e) => { e.stopPropagation(); stacks.toggle(stack.id); }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {stack.members.length}
          </button>
        )}
      </span>
      <span className="list-col-rating">{(photo.rating ?? 0) > 0 && <Stars rating={photo.rating!} />}</span>
      <span className="list-col-flag">
        {photo.flag === 'pick' && <FlagIcon />}
        {photo.flag === 'reject' && <RejectIcon />}
      </span>
      <span className="list-col-path" title={path}>{path}</span>
      <span className="list-col-date">{formatDate(photo.dateModified)}</span>
      <span className="list-col-size">{formatSize(photo.sizeBytes)}</span>
      <span className="list-col-type">{photo.mimeType?.split('/')[1]?.toUpperCase() ?? ''}</span>
    </div>
  );
}
