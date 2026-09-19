import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../storage/repos';
import type { GridFlow, GridMode, GroupMode } from '../types';
import type { ThumbnailMode } from '../hooks/useThumbnail';
import { useAdaptiveLayout } from '../contexts/AdaptiveLayoutContext';
import { TilesView } from './photoGrid/TilesView';
import { ListView } from './photoGrid/ListView';
import { GalleryView } from './photoGrid/GalleryView';
import { TimelineView } from './photoGrid/TimelineView';
import { LoadMoreTrigger } from './photoGrid/shared';
import { effectiveGroupMode } from './photoGrid/groupOptions';
import { calculatePinchTileSize, calculateWheelTileSize } from './photoGrid/pinchTileSize';
import { calculatePhoneTileSize } from './photoGrid/gridSizing';
import './PhotoGrid.css';

const PHONE_TILES_HORIZONTAL_INSET = 32;
const PHONE_TIMELINE_HORIZONTAL_INSET = 70;

interface PhotoGridProps {
  photos: PhotoView[];
  selectedIds: Set<number>;
  multiSelect: boolean;
  getDisplayUrl?: (photo: PhotoView) => Promise<string | null>;
  gridMode: GridMode;
  groupMode: GroupMode;
  tileSize: number;
  gridFlow: GridFlow;
  onTileSizeChange?: (size: number) => void;
  onSelect: (photo: PhotoView, multi: boolean, shift?: boolean) => void;
  onOpen: (photo: PhotoView) => void;
  onContextMenu?: (photo: PhotoView, e: React.MouseEvent) => void;
  canLoadMore?: boolean;
  onLoadMore?: () => void;
  scanning?: boolean;
  /** Thumbnail display mode: 'auto' shows edit if available, 'source' always shows original */
  thumbnailMode?: ThumbnailMode;
}

interface PointerPosition {
  x: number;
  y: number;
}

interface PinchState {
  pointerIds: [number, number];
  startDistance: number;
  startSize: number;
  lastSize: number;
}

function pointerDistance(first: PointerPosition, second: PointerPosition): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function PhotoGrid({
  photos, selectedIds, multiSelect, getDisplayUrl, gridMode, groupMode, tileSize, gridFlow, onSelect, onOpen,
  onTileSizeChange, onContextMenu, canLoadMore, onLoadMore, scanning, thumbnailMode,
}: PhotoGridProps) {
  const { t } = useTranslation();
  const adaptiveLayout = useAdaptiveLayout();
  const pointersRef = useRef(new Map<number, PointerPosition>());
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);
  const pinchRef = useRef<PinchState | null>(null);
  const tileSizeRef = useRef(tileSize);
  const onTileSizeChangeRef = useRef(onTileSizeChange);
  const pendingSizeRef = useRef<number | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const suppressClickUntilRef = useRef(0);
  const pinchEnabled = adaptiveLayout.screen === 'phone'
    && adaptiveLayout.primaryInput === 'touch'
    && (gridMode === 'tiles' || gridMode === 'timeline')
    && !!onTileSizeChange;
  const renderedTileSize = adaptiveLayout.screen === 'phone'
    && (gridMode === 'tiles' || gridMode === 'timeline')
    ? calculatePhoneTileSize(
        tileSize,
        adaptiveLayout.width,
        gridMode === 'timeline' ? PHONE_TIMELINE_HORIZONTAL_INSET : PHONE_TILES_HORIZONTAL_INSET,
      )
    : tileSize;

  useEffect(() => {
    tileSizeRef.current = tileSize;
  }, [tileSize]);

  useEffect(() => {
    onTileSizeChangeRef.current = onTileSizeChange;
  }, [onTileSizeChange]);

  const emitPendingSize = useCallback(() => {
    animationFrameRef.current = null;
    const nextSize = pendingSizeRef.current;
    pendingSizeRef.current = null;
    if (nextSize !== null) onTileSizeChangeRef.current?.(nextSize);
  }, []);

  const scheduleTileSize = useCallback((nextSize: number) => {
    pendingSizeRef.current = nextSize;
    if (animationFrameRef.current === null) {
      animationFrameRef.current = requestAnimationFrame(emitPendingSize);
    }
  }, [emitPendingSize]);

  const finishPinch = useCallback((surface: HTMLDivElement) => {
    const pinch = pinchRef.current;
    pinchRef.current = null;
    if (!pinch) return;

    suppressClickUntilRef.current = performance.now() + 250;
    for (const pointerId of pinch.pointerIds) {
      try {
        if (surface.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
      } catch {
        // A pointer may already have been cancelled by the browser.
      }
    }
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pinchEnabled || event.pointerType !== 'touch') return;
    if (pinchRef.current || pointersRef.current.size >= 2) return;

    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size !== 2) return;

    const pointerIds = Array.from(pointersRef.current.keys()) as [number, number];
    const first = pointersRef.current.get(pointerIds[0]);
    const second = pointersRef.current.get(pointerIds[1]);
    if (!first || !second) return;

    const startDistance = pointerDistance(first, second);
    if (startDistance < 16) return;

    pinchRef.current = {
      pointerIds,
      startDistance,
      startSize: tileSizeRef.current,
      lastSize: tileSizeRef.current,
    };
    suppressClickUntilRef.current = performance.now() + 250;
    for (const pointerId of pointerIds) {
      try { event.currentTarget.setPointerCapture(pointerId); } catch { /* Pointer already ended. */ }
    }
    event.preventDefault();
  }, [pinchEnabled]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pinchEnabled || event.pointerType !== 'touch' || !pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const pinch = pinchRef.current;
    if (!pinch || !pinch.pointerIds.includes(event.pointerId)) return;
    const first = pointersRef.current.get(pinch.pointerIds[0]);
    const second = pointersRef.current.get(pinch.pointerIds[1]);
    if (!first || !second) return;

    event.preventDefault();
    const nextSize = calculatePinchTileSize(
      pinch.startSize,
      pinch.startDistance,
      pointerDistance(first, second),
    );
    if (nextSize === pinch.lastSize) return;
    pinch.lastSize = nextSize;
    scheduleTileSize(nextSize);
  }, [pinchEnabled, scheduleTileSize]);

  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const wasPinching = pinchRef.current?.pointerIds.includes(event.pointerId) ?? false;
    pointersRef.current.delete(event.pointerId);
    if (wasPinching) finishPinch(event.currentTarget);
  }, [finishPinch]);

  const handleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (performance.now() >= suppressClickUntilRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    if (pinchEnabled) return;
    pointersRef.current.clear();
    pinchRef.current = null;
  }, [pinchEnabled]);

  // Trackpad pinch arrives as ctrl+wheel and would otherwise zoom the whole
  // page. Registered natively because React's onWheel is passive, so it cannot
  // call preventDefault.
  useEffect(() => {
    if (!surfaceEl || !onTileSizeChange) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      scheduleTileSize(calculateWheelTileSize(tileSizeRef.current, event.deltaY));
    };
    surfaceEl.addEventListener('wheel', onWheel, { passive: false });
    return () => surfaceEl.removeEventListener('wheel', onWheel);
  }, [surfaceEl, onTileSizeChange, scheduleTileSize]);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
  }, []);

  if (photos.length === 0) {
    return (
      <div className="grid-empty">
        <div className="empty-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="6" y="10" width="36" height="28" rx="3" />
            <circle cx="18" cy="22" r="4" />
            <path d="M6 34l10-8 6 5 8-10 12 13" />
          </svg>
        </div>
        <p>{t('grid.noPhotos')}</p>
        <p className="empty-hint">{t('grid.noPhotosHint')}</p>
      </div>
    );
  }

  const loadMoreEl = (canLoadMore || scanning) ? (
    <LoadMoreTrigger canLoadMore={!!canLoadMore} scanning={!!scanning} onLoadMore={onLoadMore} count={photos.length} />
  ) : null;

  // Each view gets the grouping it honours, never one it would silently drop.
  const viewGroupMode = effectiveGroupMode(gridMode, groupMode);

  if (gridMode === 'gallery') {
    return (
      <div className="photo-grid-pinch-surface" ref={setSurfaceEl}>
        <GalleryView photos={photos} selectedIds={selectedIds} tileSize={tileSize} onSelect={onSelect} onOpen={onOpen} onContextMenu={onContextMenu} getDisplayUrl={getDisplayUrl} loadMoreEl={loadMoreEl} />
      </div>
    );
  }
  if (gridMode === 'list') {
    return <ListView photos={photos} selectedIds={selectedIds} multiSelect={multiSelect} groupMode={viewGroupMode} onSelect={onSelect} onOpen={onOpen} onContextMenu={onContextMenu} loadMoreEl={loadMoreEl} />;
  }
  if (gridMode === 'timeline') {
    return (
      <div
        className={`photo-grid-pinch-surface${pinchEnabled ? ' is-pinch-enabled' : ''}`}
        ref={setSurfaceEl}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
        onClickCapture={handleClickCapture}
      >
        <TimelineView photos={photos} selectedIds={selectedIds} multiSelect={multiSelect} tileSize={renderedTileSize} gridFlow={gridFlow} onSelect={onSelect} onOpen={onOpen} onContextMenu={onContextMenu} loadMoreEl={loadMoreEl} thumbnailMode={thumbnailMode} />
      </div>
    );
  }
  return (
    <div
      className={`photo-grid-pinch-surface${pinchEnabled ? ' is-pinch-enabled' : ''}`}
      ref={setSurfaceEl}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onLostPointerCapture={handlePointerEnd}
      onClickCapture={handleClickCapture}
    >
      <TilesView photos={photos} selectedIds={selectedIds} multiSelect={multiSelect} groupMode={viewGroupMode} tileSize={renderedTileSize} gridFlow={gridFlow} onSelect={onSelect} onOpen={onOpen} onContextMenu={onContextMenu} loadMoreEl={loadMoreEl} thumbnailMode={thumbnailMode} />
    </div>
  );
}
