import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PhotoView } from '../../storage/repos';
import type { GridFlow } from '../../types';
import type { ThumbnailMode } from '../../hooks/useThumbnail';
import { TilesGrid } from './TilesView';

const MONTH_KEYS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'] as const;

interface TimelineViewProps {
  photos: PhotoView[];
  selectedIds: Set<number>;
  multiSelect: boolean;
  tileSize: number;
  gridFlow: GridFlow;
  onSelect: (p: PhotoView, m: boolean, s?: boolean) => void;
  onOpen: (p: PhotoView) => void;
  onContextMenu?: (p: PhotoView, e: React.MouseEvent) => void;
  loadMoreEl?: React.ReactNode;
  thumbnailMode?: ThumbnailMode;
}

export function TimelineView({ photos, selectedIds, multiSelect, tileSize, gridFlow, onSelect, onOpen, onContextMenu, loadMoreEl, thumbnailMode }: TimelineViewProps) {
  const { t } = useTranslation();

  // Which months are folded away. Collapsed rather than open, so a month that
  // arrives with the next page is shown, not hidden. Same shape as the folder
  // sections in the tiles view, and like those it lives with the view: leaving
  // the timeline and coming back starts with everything open.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const groups = useMemo(() => {
    const byMonth = new Map<string, { key: string; label: string; year: number; month: number; photos: PhotoView[] }>();

    for (const p of photos) {
      const date = p.dateTaken ? new Date(p.dateTaken) : null;
      const year = date?.getFullYear() ?? 0;
      const month = date?.getMonth() ?? 0;
      const key = date ? `${year}-${String(month).padStart(2, '0')}` : 'unknown';
      const label = date ? `${t(`grid.months.${MONTH_KEYS[month]}`)} ${year}` : t('grid.unknownDate');

      if (!byMonth.has(key)) {
        byMonth.set(key, { key, label, year, month, photos: [] });
      }
      byMonth.get(key)!.photos.push(p);
    }

    return Array.from(byMonth.values()).sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    });
  }, [photos, t]);

  return (
    <div className="photo-grid timeline-view">
      {groups.map((group) => {
        const open = !collapsed.has(group.key);
        return (
          <div key={group.key} className="timeline-month">
            <button
              type="button"
              className="timeline-month-header"
              onClick={() => toggle(group.key)}
              aria-expanded={open}
              title={open ? t('grid.timelineCollapse', { month: group.label }) : t('grid.timelineExpand', { month: group.label })}
            >
              <span className="timeline-dot" />
              <svg
                className={`timeline-chevron ${open ? 'open' : ''}`}
                width="10" height="10" viewBox="0 0 10 10"
                fill="none" stroke="currentColor" strokeWidth="1.5"
              >
                <path d="M3 2l4 3-4 3" />
              </svg>
              <span className="timeline-month-label">{group.label}</span>
              <span className="timeline-month-count">{group.photos.length}</span>
            </button>
            {open && (
              // The same tile size and the same flow the tiles view runs on -
              // the timeline used to hard-wire "left" and ignored the setting.
              <TilesGrid photos={group.photos} selectedIds={selectedIds} multiSelect={multiSelect}
                tileSize={tileSize} gridFlow={gridFlow} onSelect={onSelect} onOpen={onOpen}
                onContextMenu={onContextMenu} thumbnailMode={thumbnailMode} />
            )}
          </div>
        );
      })}
      {loadMoreEl}
    </div>
  );
}
