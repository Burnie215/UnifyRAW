import { useState, useRef, useCallback, useEffect } from 'react';
import type { PhotoView } from '../../storage/repos';
import { useThumbnail } from '../../hooks/useThumbnail';
import { gridBufferRows } from '../../config/gridConfig';
import { computeVisibleRange, scrollOffsetToReveal, type VisibleRange } from './virtualRange';

/** Matches the `gap` of .gallery-strip in PhotoGrid.css. */
const STRIP_GAP = 4;
/** The strip's own padding, which the thumbnails have to fit inside. */
const STRIP_PADDING = 16;

/** Where the track begins inside the strip's scrollable content (its padding). */
function containerOffsetOf(strip: HTMLElement, track: HTMLElement): number {
  return track.getBoundingClientRect().left - strip.getBoundingClientRect().left + strip.scrollLeft;
}

interface GalleryViewProps {
  photos: PhotoView[];
  selectedIds: Set<number>;
  tileSize: number;
  onSelect: (p: PhotoView, m: boolean, s?: boolean) => void;
  onOpen: (p: PhotoView) => void;
  onContextMenu?: (p: PhotoView, e: React.MouseEvent) => void;
  getDisplayUrl?: (photo: PhotoView) => Promise<string | null>;
  loadMoreEl?: React.ReactNode;
}

export function GalleryView({ photos, selectedIds, tileSize, onSelect, onOpen, onContextMenu, getDisplayUrl, loadMoreEl }: GalleryViewProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [stripHeight, setStripHeight] = useState(Math.max(80, Math.round(tileSize * 0.5)));
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const activePhoto = photos[activeIndex] ?? photos[0];
  const { url: activeThumb } = useThumbnail(activePhoto);

  // Load full-resolution image for gallery main view
  const [fullImageUrl, setFullImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!activePhoto || !getDisplayUrl) { setFullImageUrl(null); return; }
    let cancelled = false;
    let url: string | null = null;
    getDisplayUrl(activePhoto).then((u) => {
      if (!cancelled && u) { url = u; setFullImageUrl(u); }
    });
    return () => { cancelled = true; if (url?.startsWith('blob:')) URL.revokeObjectURL(url); };
  }, [activePhoto, getDisplayUrl]);
  const mainSrc = fullImageUrl ?? activeThumb;

  const handleDividerDown = useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleDividerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setStripHeight(Math.max(60, Math.min(400, rect.bottom - e.clientY)));
  }, []);

  const handleDividerUp = useCallback(() => { dragging.current = false; }, []);

  const handleKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' && activeIndex > 0) {
      setActiveIndex(activeIndex - 1); onSelect(photos[activeIndex - 1], false);
    } else if (e.key === 'ArrowRight' && activeIndex < photos.length - 1) {
      setActiveIndex(activeIndex + 1); onSelect(photos[activeIndex + 1], false);
    } else if (e.key === 'Enter') {
      onOpen(activePhoto);
    }
  }, [activeIndex, photos, activePhoto, onSelect, onOpen]);

  return (
    <div className="photo-grid gallery-view" ref={containerRef} tabIndex={0} onKeyDown={handleKey}>
      <div className="gallery-main">
        {mainSrc ? (
          <img
            src={mainSrc}
            alt={activePhoto.name}
            className="gallery-main-img"
            onDoubleClick={() => onOpen(activePhoto)}
            onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); onContextMenu(activePhoto, e); } }}
          />
        ) : (
          <div className="grid-item-loading" style={{ width: 200, height: 200, borderRadius: 8 }} />
        )}
        <div className="gallery-main-name">{activePhoto.name}</div>
      </div>
      <div className="gallery-divider" onPointerDown={handleDividerDown} onPointerMove={handleDividerMove} onPointerUp={handleDividerUp} />
      <GalleryStrip photos={photos} selectedIds={selectedIds} activeIndex={activeIndex} height={stripHeight}
        onActivate={(photo, i) => { setActiveIndex(i); onSelect(photo, false); }}
        onOpen={onOpen} onContextMenu={onContextMenu} loadMoreEl={loadMoreEl} />
    </div>
  );
}

/**
 * The film strip, virtualised along its own axis.
 *
 * Same mechanic as the tile grid - visible range plus `gridBufferRows` of
 * buffer, a placeholder that holds the scroll length open, the rendered window
 * pushed out by `leftPad` - only that here a "row" is one column: the strip
 * scrolls sideways, so `perRow` is 1 and the row size is a thumbnail's width.
 */
function GalleryStrip({ photos, selectedIds, activeIndex, height, onActivate, onOpen, onContextMenu, loadMoreEl }: {
  photos: PhotoView[]; selectedIds: Set<number>; activeIndex: number; height: number;
  onActivate: (photo: PhotoView, index: number) => void;
  onOpen: (photo: PhotoView) => void;
  onContextMenu?: (photo: PhotoView, e: React.MouseEvent) => void;
  loadMoreEl?: React.ReactNode;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<VisibleRange>({ start: 0, end: 0 });

  const size = Math.max(1, height - STRIP_PADDING);
  const stride = size + STRIP_GAP;

  useEffect(() => {
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!strip || !track) return;

    const onScroll = () => {
      const containerOffset = containerOffsetOf(strip, track);
      const next = computeVisibleRange({
        scrollOffset: strip.scrollLeft,
        viewportSize: strip.clientWidth,
        containerOffset,
        rowSize: stride,
        perRow: 1,
        total: photos.length,
        bufferRows: gridBufferRows,
      });
      setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };

    onScroll();
    strip.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(strip);
    return () => { strip.removeEventListener('scroll', onScroll); ro.disconnect(); };
  }, [photos.length, stride]);

  // The arrow keys move the main image, and the strip used to stay where it
  // was: the active thumbnail could sit outside it with nothing to click. Since
  // the strip is virtualised it is then not even in the DOM, so the scroll has
  // to come from the geometry rather than from the element.
  useEffect(() => {
    const strip = stripRef.current;
    const track = trackRef.current;
    if (!strip || !track) return;
    const next = scrollOffsetToReveal({
      index: activeIndex,
      scrollOffset: strip.scrollLeft,
      viewportSize: strip.clientWidth,
      containerOffset: containerOffsetOf(strip, track),
      rowSize: stride,
      itemSize: size,
      perRow: 1,
      total: photos.length,
    });
    if (next !== null) strip.scrollLeft = next;
  }, [activeIndex, stride, size, photos.length]);

  const totalWidth = Math.max(0, photos.length * stride - STRIP_GAP);

  return (
    <div className="gallery-strip" ref={stripRef} style={{ height }}>
      <div className="gallery-strip-track" ref={trackRef} style={{ width: totalWidth }}>
        <div className="gallery-strip-window" style={{ left: range.start * stride }}>
          {photos.slice(range.start, range.end).map((photo, i) => {
            const index = range.start + i;
            return (
              <GalleryStripItem key={photo.id} photo={photo} active={index === activeIndex}
                selected={selectedIds.has(photo.id!)} size={size}
                onClick={() => onActivate(photo, index)}
                onDoubleClick={() => onOpen(photo)}
                onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(photo, e); } : undefined}
              />
            );
          })}
        </div>
      </div>
      {loadMoreEl}
    </div>
  );
}

function GalleryStripItem({ photo, active, selected, size, onClick, onDoubleClick, onContextMenu }: {
  photo: PhotoView; active: boolean; selected: boolean;
  size: number; onClick: () => void; onDoubleClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { url: thumbnailUrl } = useThumbnail(photo);
  return (
    <div className={`gallery-strip-item ${active ? 'active' : ''} ${selected ? 'selected' : ''}`}
      style={{ width: size, height: size }} onClick={onClick} onDoubleClick={onDoubleClick} onContextMenu={onContextMenu}>
      {thumbnailUrl ? <img src={thumbnailUrl} alt={photo.name} /> : <div className="grid-item-loading" />}
    </div>
  );
}
