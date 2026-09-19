import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../../storage/repos';
import type { GridFlow, GroupMode } from '../../types';
import type { ThumbnailMode } from '../../hooks/useThumbnail';
import { useThumbnail } from '../../hooks/useThumbnail';
import { perfLog } from '../../platform/perfLog';
import { gridBufferRows } from '../../config/gridConfig';
import { groupByFolder } from './shared';
import { computeVisibleRange } from './virtualRange';
import { TileItem } from './TileItem';
import { calculateGridColumnCount, fillTileSize, GRID_TILE_GAP } from './gridSizing';

interface TilesViewProps {
  photos: PhotoView[];
  selectedIds: Set<number>;
  multiSelect: boolean;
  groupMode: GroupMode;
  tileSize: number;
  gridFlow: GridFlow;
  onSelect: (p: PhotoView, m: boolean, s?: boolean) => void;
  onOpen: (p: PhotoView) => void;
  onContextMenu?: (p: PhotoView, e: React.MouseEvent) => void;
  loadMoreEl?: React.ReactNode;
  thumbnailMode?: ThumbnailMode;
}

export function TilesView({ photos, selectedIds, multiSelect, groupMode, tileSize, gridFlow, onSelect, onOpen, onContextMenu, loadMoreEl, thumbnailMode }: TilesViewProps) {
  const groups = useMemo(() => (groupMode !== 'none') ? groupByFolder(photos) : null, [photos, groupMode]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  const [expandedFolder, setExpandedFolder] = useState<string | null>(null);

  const toggleFolder = useCallback((folder: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder); else next.add(folder);
      return next;
    });
  }, []);

  // folder-grid or folder-stack: show folder tiles, click expands inline
  if (groups && (groupMode === 'folder-grid' || groupMode === 'folder-stack')) {
    return (
      <div className="photo-grid grouped-scroll">
        {expandedFolder ? (
          <>
            <button className="folder-back-btn" onClick={() => setExpandedFolder(null)}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 2L4 7l5 5" />
              </svg>
              {expandedFolder}
            </button>
            <TilesGrid
              photos={groups.find((g) => g.folder === expandedFolder)?.photos ?? []}
              selectedIds={selectedIds} multiSelect={multiSelect} tileSize={tileSize} gridFlow={gridFlow}
              onSelect={onSelect} onOpen={onOpen} onContextMenu={onContextMenu} thumbnailMode={thumbnailMode}
            />
          </>
        ) : (
          <div className="tiles-grid" style={{ gridTemplateColumns: `repeat(auto-fill, ${tileSize}px)` }}>
            {groups.map((g) => (
              <FolderTile
                key={g.folder}
                folder={g.folder}
                photos={g.photos}
                size={tileSize}
                style={groupMode === 'folder-stack' ? 'stack' : 'mosaic'}
                onClick={() => setExpandedFolder(g.folder)}
              />
            ))}
          </div>
        )}
        {loadMoreEl}
      </div>
    );
  }

  // folder collapsible sections
  if (groups && groupMode === 'folder') {
    return (
      <div className="photo-grid grouped-scroll">
        {groups.map((g) => (
          <FolderSection key={g.folder} folder={g.folder} count={g.photos.length} open={!openFolders.has(g.folder)} onToggle={() => toggleFolder(g.folder)}>
            <TilesGrid photos={g.photos} selectedIds={selectedIds} multiSelect={multiSelect} tileSize={tileSize} gridFlow={gridFlow} onSelect={onSelect} onOpen={onOpen} onContextMenu={onContextMenu} thumbnailMode={thumbnailMode} />
          </FolderSection>
        ))}
        {loadMoreEl}
      </div>
    );
  }

  return (
    <div className="photo-grid grouped-scroll">
      <TilesGrid photos={photos} selectedIds={selectedIds} multiSelect={multiSelect} tileSize={tileSize} gridFlow={gridFlow} onSelect={onSelect} onOpen={onOpen} onContextMenu={onContextMenu} thumbnailMode={thumbnailMode} />
      {loadMoreEl}
    </div>
  );
}

/* ─── Folder Tile (mosaic / stack) ─── */
function FolderTile({ folder, photos, size, style, onClick }: {
  folder: string; photos: PhotoView[]; size: number; style: 'mosaic' | 'stack'; onClick: () => void;
}) {
  const { t } = useTranslation();
  const previews = photos.slice(0, 4);
  const displayName = folder === '/' ? t('grid.rootFolder') : folder.split('/').pop() ?? folder;

  return (
    <div className="folder-tile" style={{ width: size }} onClick={onClick}>
      <div className={`folder-tile-preview ${style}`} style={{ height: size - 28 }}>
        {style === 'mosaic' ? (
          <MosaicPreview photos={previews} />
        ) : (
          <StackPreview photos={previews} />
        )}
        <div className="folder-tile-frame" />
      </div>
      <div className="folder-tile-label">
        <span className="folder-tile-name" title={folder}>{displayName}</span>
        <span className="folder-tile-count">{photos.length}</span>
      </div>
    </div>
  );
}

function MosaicPreview({ photos }: { photos: PhotoView[] }) {
  return (
    <div className="mosaic-grid">
      {photos.map((p, i) => (
        <MosaicThumb key={p.id ?? i} photo={p} />
      ))}
    </div>
  );
}

function MosaicThumb({ photo }: { photo: PhotoView }) {
  const { url } = useThumbnail(photo);
  return url ? <img src={url} alt="" className="mosaic-img" /> : <div className="mosaic-placeholder" />;
}

function StackPreview({ photos }: { photos: PhotoView[] }) {
  const items = photos.slice(0, 4);
  return (
    <div className="stack-container">
      {items.map((p, i) => (
        <StackThumb key={p.id ?? i} photo={p} index={i} total={items.length} />
      ))}
    </div>
  );
}

function StackThumb({ photo, index, total }: { photo: PhotoView; index: number; total: number }) {
  const { url } = useThumbnail(photo);
  const offset = (total - 1 - index) * 6;
  const scale = 1 - (total - 1 - index) * 0.04;
  return (
    <div
      className="stack-card"
      style={{
        transform: `translateY(${-offset}px) scale(${scale})`,
        zIndex: index,
      }}
    >
      {url ? <img src={url} alt="" /> : <div className="mosaic-placeholder" />}
    </div>
  );
}

/* ─── Folder Section (collapsible, compact) ─── */
function FolderSection({ folder, count, open, onToggle, children }: {
  folder: string; count: number; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const displayName = folder === '/' ? t('grid.rootFolder') : folder;

  return (
    <div className="folder-section">
      <button className="folder-header" onClick={onToggle}>
        <svg
          className={`folder-chevron ${open ? 'open' : ''}`}
          width="10" height="10" viewBox="0 0 10 10"
          fill="none" stroke="currentColor" strokeWidth="1.5"
        >
          <path d="M3 2l4 3-4 3" />
        </svg>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ flexShrink: 0 }}>
          <path d="M1 3.5V11a1 1 0 001 1h10a1 1 0 001-1V5a1 1 0 00-1-1H7L5.5 2.5H2A1 1 0 001 3.5z" />
        </svg>
        <span className="folder-name">{displayName}</span>
        <span className="folder-count">{count}</span>
      </button>
      {open && <div className="folder-body">{children}</div>}
    </div>
  );
}

/**
 * The virtualised tile grid: it renders the rows around the viewport plus a
 * buffer and holds the rest of the scroll height open with padding. Exported
 * because the timeline needs the same grid per month group - a month with a
 * thousand photos is a thousand tiles otherwise.
 */
export function TilesGrid({ photos, selectedIds, multiSelect, tileSize, gridFlow, onSelect, onOpen, onContextMenu, thumbnailMode }: {
  photos: PhotoView[]; selectedIds: Set<number>; multiSelect: boolean;
  tileSize: number; gridFlow: GridFlow;
  onSelect: (p: PhotoView, m: boolean, s?: boolean) => void; onOpen: (p: PhotoView) => void;
  onContextMenu?: (p: PhotoView, e: React.MouseEvent) => void;
  thumbnailMode?: ThumbnailMode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Initial estimate: ~5 viewport rows + buffer, recalculated on first scroll/resize
  const [visibleRange, setVisibleRange] = useState(() => {
    const estimatedRows = Math.ceil(window.innerHeight / (tileSize + 4)) + gridBufferRows * 2;
    return { start: 0, end: Math.min(photos.length, estimatedRows * 4) };
  });

  // Calculate how many columns fit — recompute on container resize, not just tileSize change
  const [cols, setCols] = useState(4);
  const [containerWidth, setContainerWidth] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      setContainerWidth((prev) => (prev === width ? prev : width));
      const measured = calculateGridColumnCount(width, tileSize);
      setCols((prev) => {
        if (prev === measured) return prev;
        if (perfLog.enabled) console.log(`[Virtual] cols measured: ${measured} (container width: ${width}px, tileSize: ${tileSize}px)`);
        return measured;
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tileSize]);

  // In "fill" the same column count is stretched across the full width, so the
  // size steps from one column count to the next instead of leaving a gap.
  const renderedTileSize = gridFlow === 'fill'
    ? fillTileSize(containerWidth, cols, tileSize)
    : tileSize;

  // Track scroll position → compute visible range
  useEffect(() => {
    const container = containerRef.current;
    if (!container) { if (perfLog.enabled) console.log('[Virtual] no containerRef'); return; }
    const scrollParent = container.closest('.photo-grid');
    if (!scrollParent) { if (perfLog.enabled) console.log('[Virtual] no .photo-grid scroll parent found'); return; }
    if (perfLog.enabled) console.log(`[Virtual] scroll parent found: ${scrollParent.className}, scrollHeight=${scrollParent.scrollHeight}, clientHeight=${scrollParent.clientHeight}`);

    const gap = GRID_TILE_GAP;
    const rowHeight = renderedTileSize + gap;
    const buffer = gridBufferRows;

    const onScroll = () => {
      const scrollTop = scrollParent.scrollTop;
      const viewportHeight = scrollParent.clientHeight;
      // Where this grid begins inside the scroll parent. Folder grouping puts
      // several grids into one parent, so without this a grid further down
      // reads a scroll position that belongs to the grids above it. Measured
      // per event rather than cached: collapsing a folder moves everything
      // below it.
      const containerOffset = container.getBoundingClientRect().top
        - scrollParent.getBoundingClientRect().top + scrollParent.scrollTop;
      const { start, end } = computeVisibleRange({
        scrollOffset: scrollTop,
        viewportSize: viewportHeight,
        containerOffset,
        rowSize: rowHeight,
        perRow: cols,
        total: photos.length,
        bufferRows: buffer,
      });
      setVisibleRange((prev) => {
        if (prev.start === start && prev.end === end) return prev;
        if (perfLog.enabled) console.log(`[Virtual] range: ${start}-${end} (${end - start} tiles) | scroll=${Math.round(scrollTop)} offset=${Math.round(containerOffset)} viewport=${Math.round(viewportHeight)} | cols=${cols} totalPhotos=${photos.length}`);
        return { start, end };
      });
    };

    onScroll();
    scrollParent.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(scrollParent);
    return () => { scrollParent.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [photos.length, renderedTileSize, cols]);

  const totalRows = Math.ceil(photos.length / cols);
  const rowHeight = renderedTileSize + GRID_TILE_GAP;
  const totalHeight = totalRows * rowHeight;
  const topPad = Math.floor(visibleRange.start / cols) * rowHeight;

  return (
    <div ref={containerRef} className="tiles-grid-virtual" style={{ height: totalHeight, position: 'relative' }}>
      <div style={{
        position: 'absolute', top: topPad, left: 0, right: 0,
        display: 'grid',
        gridTemplateColumns: gridFlow === 'fill'
          ? `repeat(${cols}, ${renderedTileSize}px)`
          : `repeat(auto-fill, ${renderedTileSize}px)`,
        justifyContent: gridFlow === 'center' ? 'center' : 'start',
        gap: GRID_TILE_GAP,
      }}>
        {photos.slice(visibleRange.start, visibleRange.end).map((photo) => (
          <TileItem key={photo.id} photo={photo} selected={selectedIds.has(photo.id!)} multiSelect={multiSelect} tileSize={renderedTileSize} onSelect={onSelect} onOpen={onOpen} onContextMenu={onContextMenu} thumbnailMode={thumbnailMode} />
        ))}
      </div>
    </div>
  );
}
