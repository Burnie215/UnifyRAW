import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../../storage/repos';
import { useThumbnail, type ThumbnailMode } from '../../hooks/useThumbnail';
import { RawDecoder } from '../../engine/RawDecoder';
import { prefetchManager, getSmartPreviewSize, isLocalRawSourceType, hoverPrefetchAllowed } from '../../engine/raw';
import { sourceManager } from '../../sources';
import { Stars, FlagIcon, RejectIcon, Checkbox } from './shared';
import { BlurHashPlaceholder } from './BlurHashPlaceholder';
import { makeRawCacheKey } from '../../engine/raw/cacheKey';
import { useRawPairIndex } from '../../contexts/RawPairContext';
import { extensionOf } from '../../data/rawPairing';
import { useAdaptiveLayout } from '../../contexts/AdaptiveLayoutContext';
import { useStacks } from '../../contexts/StackContext';

export function TileItem({ photo, selected, multiSelect, tileSize, onSelect, onOpen, onContextMenu, thumbnailMode }: {
  photo: PhotoView; selected: boolean; multiSelect: boolean; tileSize: number;
  onSelect: (p: PhotoView, m: boolean, s?: boolean) => void; onOpen: (p: PhotoView) => void;
  onContextMenu?: (p: PhotoView, e: React.MouseEvent) => void;
  thumbnailMode?: ThumbnailMode;
}) {
  const { t } = useTranslation();
  const { hoverAvailable } = useAdaptiveLayout();
  // While this photo leads a folded stack, its tile stands for every member.
  const stacks = useStacks();
  const stack = stacks.index.get(photo.id);
  const stackOpen = !!stack && stacks.expanded.has(stack.id);
  // No useIsVisible — the virtual grid (TilesGrid) already limits rendering
  // to visible + 3-row buffer. Every rendered tile loads its thumbnail.
  // On unmount (scrolled out of range), URL is revoked in useThumbnail cleanup.
  const { url: thumbnailUrl, hasEdit } = useThumbnail(photo, thumbnailMode);
  // While RAW+JPEG grouping is on, this tile stands for two files. The badge
  // names the hidden one so the pair is visible before opening it.
  const pair = useRawPairIndex().get(photo.id);
  const hiddenPartner = pair && (pair.display.id === photo.id ? pair.raw : pair.display);
  const labelColor = photo.colorLabel ? `var(--label-${photo.colorLabel})` : undefined;

  // Smart-preview cache state for RAW — drives the tile border badge.
  // - "cached": OPFS already has a Smart Preview ready (next open is fast)
  // - "prefetching": hover dwell triggered backend decode, write in progress
  // HEIF isn't cached in OPFS yet (HeifDecoder re-decodes every time), so
  // we can't surface a "cached" badge for it — only RAW for now.
  const sourceType = sourceManager.get(photo.sourceId)?.type;
  const isCacheable = useMemo(
    () => RawDecoder.isRawFile(photo.name) && !isLocalRawSourceType(sourceType),
    [photo.name, sourceType],
  );
  const cacheKey = useMemo(
    () => isCacheable ? makeRawCacheKey(photo) : null,
    [isCacheable, photo],
  );
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!cacheKey) return;
    return prefetchManager.subscribe(() => forceUpdate((n) => n + 1));
  }, [cacheKey]);
  const isCached = cacheKey ? prefetchManager.isCompleted(cacheKey) : false;
  const isPrefetching = cacheKey ? prefetchManager.hasInFlight(cacheKey) : false;

  // Hover-driven Smart Preview pre-fetch (RAW files only). 300ms dwell so we
  // don't fire on quick scroll-through. mouseLeave cancels the pending
  // request; the prefetch itself dedupes via prefetchManager.
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverReadControllerRef = useRef<AbortController | null>(null);
  const cancelPrefetchRef = useRef<(() => void) | null>(null);
  const onMouseEnter = useCallback(() => {
    if (!RawDecoder.isRawFile(photo.name)) return;
    // One gate, asked before the timer even starts: the download this dwell
    // leads to is only worth making when a server turns it into a preview.
    if (!hoverPrefetchAllowed(sourceType, hoverAvailable)) return;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(async () => {
      const controller = new AbortController();
      hoverReadControllerRef.current?.abort();
      hoverReadControllerRef.current = controller;
      const source = sourceManager.get(photo.sourceId);
      if (!source) return;
      const file = await source.getFile({
        sourcePhotoId: photo.sourcePhotoId,
        sourceId: photo.sourceId,
        name: photo.name,
      }, controller.signal).catch(() => null);
      if (hoverReadControllerRef.current === controller) {
        hoverReadControllerRef.current = null;
      }
      if (!file || controller.signal.aborted) return;
      cancelPrefetchRef.current = prefetchManager.schedule(file, makeRawCacheKey(photo), getSmartPreviewSize(), source.type);
    }, 300);
  }, [photo, sourceType, hoverAvailable]);

  const onMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    // We intentionally do NOT cancel an in-flight prefetch here — the user
    // hovered long enough to start it; finishing the cache write is cheap
    // and benefits them on a later visit. We only cancel the pending dwell.
  }, []);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverReadControllerRef.current?.abort();
    cancelPrefetchRef.current?.();
  }, []);

  return (
    <div
      className={`grid-item tile ${selected ? 'selected' : ''} ${stack && !stackOpen ? 'stacked' : ''} ${isCached ? 'cached-preview' : ''} ${isPrefetching ? 'prefetching' : ''}`}
      style={{ width: tileSize, height: tileSize, borderBottomColor: labelColor }}
      onClick={(e) => onSelect(photo, multiSelect || e.metaKey || e.ctrlKey, e.shiftKey)}
      onDoubleClick={() => onOpen(photo)}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); onContextMenu(photo, e); } }}
    >
      {multiSelect && <Checkbox checked={selected} />}
      {photo.flag && (
        <div className={`tile-flag ${photo.flag}`}>
          {photo.flag === 'pick' ? <FlagIcon /> : <RejectIcon />}
        </div>
      )}
      {stack && (
        <button
          type="button"
          className={`tile-stack-badge ${stackOpen ? 'open' : ''}`}
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
      {hiddenPartner && (
        <div className="tile-pair-badge" title={t('grid.rawPairTooltip', { name: hiddenPartner.name })}>
          {extensionOf(hiddenPartner.name).toUpperCase()}
        </div>
      )}
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt={photo.name} loading="lazy" />
      ) : photo.blurHash ? (
        <BlurHashPlaceholder hash={photo.blurHash} />
      ) : (
        <div className="grid-item-loading" />
      )}
      {hasEdit && <div className="tile-edit-badge" title={t('grid.editedBadge')} />}
      <div className="grid-item-footer">
        <div className="grid-item-name">{photo.name}</div>
        <Stars rating={photo.rating ?? 0} />
      </div>
    </div>
  );
}
