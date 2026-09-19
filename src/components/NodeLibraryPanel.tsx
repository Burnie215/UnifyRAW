/**
 * Left-rail panel listing every registered NodeKind, grouped by category.
 * Drag an item onto the canvas to insert a node at the drop location.
 * GraphEditor's onCanvasDrop consumes the `application/x-graph-node`
 * payload (a serialised `RenderNode` with default params).
 *
 * Visual style mirrors the classic editor's tool-strip — icon + short
 * label per row, sections collapsible, search at the top. Adjustments
 * are open by default; the lower-level pipeline categories collapse so
 * the user can find the slider-style nodes without scrolling past them.
 */
import React, { useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getMainThreadNodeRegistry, nodeKindLabel } from '../engine/graph';
import { STORAGE_KEYS } from '../platform/storageKeys';
import { defaultParamsForSchema } from '../hooks/useGraphEditor';
import type { NodeKindSpec } from '../engine/graph';

// Adjustments first; lower-level pipeline blocks below. Every entry has a
// label under graphEditor.library.categories. Which kinds appear at all is
// `userPlaceable`, not this list: sources, the encoder and the internal tap
// carry no flag and therefore have no section left to fill.
const CATEGORY_ORDER: string[] = [
  'adjustment', 'mask', 'compositor', 'generator', 'convert', 'source', 'decoder', 'encoder', 'tap',
];

// Sections open by default. Adjustments stay open; pipeline-plumbing is
// collapsed to keep the slider-style nodes visible without scrolling.
const DEFAULT_OPEN: Record<string, boolean> = {
  adjustment: true, mask: true, compositor: false, generator: false,
  convert: false, source: false, decoder: false, encoder: false, tap: false,
};

export function NodeLibraryPanel() {
  const { t } = useTranslation();
  const [filter, setFilter] = useState('');
  const registry = getMainThreadNodeRegistry();

  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.graphLibrarySections);
      if (raw) return { ...DEFAULT_OPEN, ...JSON.parse(raw) };
    } catch { /* ignore */ }
    return DEFAULT_OPEN;
  });
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEYS.graphLibrarySections, JSON.stringify(openSections)); }
    catch { /* quota */ }
  }, [openSections]);

  const grouped = useMemo(() => {
    // Only kinds that run from the surface. The old filter was
    // `category !== 'convert'`, which offered the encoder, the three source
    // kinds and the internal tap - none of which the user can feed - and hid
    // `outputColorSpace`, the one kind a delete makes unrecoverable (F019).
    const all = registry.list().filter((k) => k.userPlaceable === true);
    const lowerFilter = filter.toLowerCase().trim();
    const visible = lowerFilter
      ? all.filter((k) => k.kind.toLowerCase().includes(lowerFilter)
          || k.category.toLowerCase().includes(lowerFilter)
          || (CATEGORY_ORDER.includes(k.category)
            && t(`graphEditor.library.categories.${k.category}`).toLowerCase().includes(lowerFilter))
          || nodeKindLabel(k.kind).toLowerCase().includes(lowerFilter))
      : all;
    const map = new Map<string, NodeKindSpec[]>();
    for (const k of visible) {
      let bucket = map.get(k.category);
      if (!bucket) { bucket = []; map.set(k.category, bucket); }
      bucket.push(k);
    }
    for (const arr of map.values()) arr.sort((a, b) => nodeKindLabel(a.kind).localeCompare(nodeKindLabel(b.kind)));
    // Order categories deterministically.
    return CATEGORY_ORDER
      .map((cat) => [cat, map.get(cat)] as const)
      .filter(([, items]) => items && items.length > 0) as [string, NodeKindSpec[]][];
  }, [filter, registry, t]);

  // While searching, force every section open so the user sees matches.
  const isSearching = filter.trim().length > 0;

  return (
    <div
      className="node-library-panel"
      style={{
        width: 200, borderRight: '1px solid var(--border-subtle, #333)',
        background: 'var(--bg-panel, #1f1f1f)',
        display: 'flex', flexDirection: 'column', minHeight: 0, flexShrink: 0,
      }}
    >
      <div style={{
        padding: 8, borderBottom: '1px solid var(--border-subtle, #333)', flexShrink: 0,
      }}>
        <input
          type="text"
          placeholder={t('graphEditor.library.search')}
          value={filter}
          onChange={(ev) => setFilter(ev.target.value)}
          style={{
            width: '100%', padding: '4px 6px', fontSize: 11,
            background: 'var(--bg-input, #111)', border: '1px solid var(--border-subtle, #333)',
            color: 'var(--text-primary, #eee)', borderRadius: 3, boxSizing: 'border-box',
          }}
        />
      </div>
      <div style={{ padding: 2, flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {grouped.map(([category, kinds]) => {
          const open = isSearching || openSections[category] !== false;
          return (
            <div key={category} style={{ marginBottom: 2 }}>
              <button
                type="button"
                onClick={() => !isSearching && setOpenSections((s) => ({ ...s, [category]: !open }))}
                disabled={isSearching}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 4,
                  padding: '4px 6px', fontSize: 10, textTransform: 'uppercase',
                  color: 'var(--text-tertiary, #888)', letterSpacing: 0.5,
                  background: 'transparent', border: 'none', cursor: isSearching ? 'default' : 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ display: 'inline-block', width: 8, fontSize: 8, opacity: 0.7 }}>
                  {open ? '▼' : '▶'}
                </span>
                {t(`graphEditor.library.categories.${category}`)}
                <span style={{ marginLeft: 'auto', fontSize: 9, opacity: 0.5 }}>{kinds.length}</span>
              </button>
              {open && kinds.map((k) => <LibraryItem key={k.kind} kind={k} />)}
            </div>
          );
        })}
        {grouped.length === 0 && (
          <div style={{ padding: 12, fontSize: 11, color: 'var(--text-tertiary, #888)' }}>
            {t('graphEditor.library.noResults')}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A kind whose schema demands a non-empty array it has no default for needs
 * something the drop cannot supply — a `.cube` file, today. `defaultParamsForSchema`
 * hands out `[]`, so the node lands inert; saying so in the row beats letting
 * the user wonder why nothing happened (F074).
 */
function needsFile(kind: NodeKindSpec): boolean {
  const schema = kind.paramSchema as {
    type?: string;
    properties?: Record<string, { type?: string; minItems?: number; default?: unknown }>;
  };
  if (schema.type !== 'object' || !schema.properties) return false;
  return Object.values(schema.properties).some(
    (prop) => prop.type === 'array' && (prop.minItems ?? 0) > 0 && prop.default === undefined,
  );
}

function LibraryItem({ kind }: { kind: NodeKindSpec }) {
  const { t } = useTranslation();
  const onDragStart = (ev: React.DragEvent<HTMLDivElement>) => {
    const newNode = {
      id: `${kind.kind}:${Math.random().toString(36).slice(2, 10)}`,
      kind: kind.kind,
      params: defaultParamsForSchema(kind.paramSchema),
    };
    ev.dataTransfer.setData('application/x-graph-node', JSON.stringify(newNode));
    ev.dataTransfer.effectAllowed = 'copy';
  };
  return (
    <div
      draggable
      onDragStart={onDragStart}
      title={kind.kind}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '3px 6px 3px 18px', fontSize: 11,
        color: 'var(--text-secondary, #ccc)',
        cursor: 'grab', userSelect: 'none', borderRadius: 3,
      }}
      onMouseEnter={(ev) => { (ev.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.06)'; }}
      onMouseLeave={(ev) => { (ev.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
    >
      <KindIcon kind={kind.kind} category={kind.category} />
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {nodeKindLabel(kind.kind)}
        {needsFile(kind) && (
          <span style={{ color: 'var(--text-tertiary, #888)' }}> {t('graphEditor.library.needsFile')}</span>
        )}
      </span>
    </div>
  );
}

// ─── Icons ─────────────────────────────────────────────────────────
// Lightweight per-kind icon; falls back to a category glyph when the
// kind isn't explicitly mapped.

function KindIcon({ kind, category }: { kind: string; category: string }) {
  const icon = KIND_ICONS[kind] ?? CATEGORY_FALLBACK_ICONS[category] ?? DotIcon;
  return <span style={{
    width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    color: 'var(--text-tertiary, #999)', flex: '0 0 14px',
  }}>{icon()}</span>;
}


const SVG_W = { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 } as const;

const SlidersIcon = () => <svg {...SVG_W}><path d="M1 3h10M1 6h10M1 9h10" /><circle cx="3" cy="3" r="1.5" /><circle cx="8" cy="6" r="1.5" /><circle cx="5" cy="9" r="1.5" /></svg>;
const WbIcon = () => <svg {...SVG_W}><circle cx="6" cy="6" r="4" /><path d="M6 2v2M6 8v2M2 6h2M8 6h2" /></svg>;
const ClarityIcon = () => <svg {...SVG_W}><circle cx="6" cy="6" r="5" /><circle cx="6" cy="6" r="2" /></svg>;
const ColorIcon = () => <svg {...SVG_W}><circle cx="5" cy="5" r="3" /><circle cx="8" cy="5" r="3" /><circle cx="6.5" cy="8" r="3" /></svg>;
const CurveIcon = () => <svg {...SVG_W}><rect x="1" y="1" width="10" height="10" rx="1" /><path d="M2 10C4 8 8 4 10 2" /></svg>;
const LevelsIcon = () => <svg {...SVG_W}><path d="M1 11h10M1 1v10M2 9l1-1M9 9l-1-1M5.5 9v-2" /></svg>;
const BwIcon = () => <svg {...SVG_W}><circle cx="6" cy="6" r="5" /><path d="M6 1v10" /></svg>;
const DetailIcon = () => <svg {...SVG_W}><circle cx="5" cy="5" r="4" /><path d="M8 8l3 3" /></svg>;
const FxIcon = () => <svg {...SVG_W}><path d="M2 4c2-3 6-3 8 0M2 8c2 3 6 3 8 0" /></svg>;
const TransformIcon = () => <svg {...SVG_W}><rect x="2" y="2" width="8" height="8" rx="1" /><path d="M5 1l1 2 1-2M5 11l1-2 1 2M1 5l2 1-2 1M11 5l-2 1 2 1" /></svg>;
const MaskIcon = () => <svg {...SVG_W}><circle cx="6" cy="6" r="5" /><path d="M3 6c0-2 1.5-3 3-3" strokeDasharray="1.5 1.5" /></svg>;
const SourceIcon = () => <svg {...SVG_W}><rect x="1" y="3" width="10" height="6" rx="1" /><circle cx="3.5" cy="5.5" r="1" /><path d="M11 8L8 5l-2 2-2-1" /></svg>;
const DecoderIcon = () => <svg {...SVG_W}><rect x="1" y="3" width="10" height="6" rx="1" /><text x="6" y="7.5" textAnchor="middle" fontSize="3.6" fill="currentColor" stroke="none">RAW</text></svg>;
const EncoderIcon = () => <svg {...SVG_W}><path d="M6 1v7M3 4l3-3 3 3" /><path d="M1 9v1h10V9" /></svg>;
const CompositorIcon = () => <svg {...SVG_W}><rect x="1" y="2" width="7" height="7" rx="1" /><rect x="4" y="3" width="7" height="7" rx="1" /></svg>;
const GeneratorIcon = () => <svg {...SVG_W}><path d="M1 11L11 1M1 1l10 10" opacity="0.4" /><circle cx="6" cy="6" r="3" /></svg>;
const TapIcon = () => <svg {...SVG_W}><circle cx="6" cy="6" r="2" /><path d="M6 1v3M6 8v3M1 6h3M8 6h3" /></svg>;
const DotIcon = () => <svg {...SVG_W}><circle cx="6" cy="6" r="2" /></svg>;

const KIND_ICONS: Record<string, () => React.ReactElement> = {
  tone: SlidersIcon,
  whiteBalance: WbIcon,
  whiteBalanceRaw: WbIcon,
  hsl: ColorIcon,
  hslDetail: ColorIcon,
  customHSL: ColorIcon,
  clarity: ClarityIcon,
  texture: ClarityIcon,
  dehaze: ClarityIcon,
  toneCurve: CurveIcon,
  levels: LevelsIcon,
  bw: BwIcon,
  colorGrading: ColorIcon,
  colorMatrix: ColorIcon,
  outputColorSpace: ColorIcon,
  sharpen: DetailIcon,
  denoise: DetailIcon,
  effects: FxIcon,
  transform: TransformIcon,
};

const CATEGORY_FALLBACK_ICONS: Record<string, () => React.ReactElement> = {
  adjustment: SlidersIcon,
  source: SourceIcon,
  decoder: DecoderIcon,
  encoder: EncoderIcon,
  compositor: CompositorIcon,
  mask: MaskIcon,
  generator: GeneratorIcon,
  tap: TapIcon,
};
