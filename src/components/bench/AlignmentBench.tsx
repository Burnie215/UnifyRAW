import { useCallback, useMemo, useRef, useState } from 'react';
import type { PhotoView } from '../../storage/repos';
import type { Adjustments } from '../../types';
import { AdjustmentsProvider } from '../../contexts/AdjustmentsContext';
import { EditorProvider, type EditorContextValue } from '../../contexts/EditorContext';
import { BenchPanels } from './BenchPanels';
import { ModularPanel } from '../../ui/ModularPanel';
import { BenchTile } from './BenchTile';
import { useBenchSources, BENCH_TILE_EDGE, type BenchSource } from './useBenchSources';
import type { LensCoefficients } from '../../engine/lensProfile';
import { useBenchRender } from './useBenchRender';
import { useBenchLoupe, LOUPE_PHOTO_ID, type LoupeRequest } from './useBenchLoupe';
import './AlignmentBench.css';

/** RAW alone, the camera's rendering alone, or the two next to each other. */
export type BenchCompareMode = 'raw' | 'partner' | 'both';

export interface AlignmentBenchProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** The photos shown side by side. One for a lens profile, up to nine otherwise. */
  photos: PhotoView[];
  /**
   * The camera's own JPEG or HEIC for each photo, by index, where one exists.
   *
   * They are the reference a RAW profile is tuned towards, so they render
   * untouched by the sliders - moving them along would be adjusting the ruler
   * together with what it measures.
   */
  partners?: (PhotoView | null)[];
  /**
   * False when the sliders ARE the camera profile. The tiles then render
   * without the stored one, or every value would show twice.
   */
  applyStoredBase?: boolean;
  /** Shown above the grid; says what the result will cover. */
  scopeLabel?: string;
  /**
   * Extra panels this bench shows above the adjustment stack, by id.
   *
   * The lens bench needs eight coefficients that are not adjustments and have
   * no business in `Adjustments`; it owns their state and hands the rendered
   * panel in rather than the bench growing a second notion of what it edits.
   */
  extraPanels?: { id: string; title: string; content: React.ReactNode }[];
  /** Draw a reference grid over every tile - distortion is invisible without one. */
  gridOverlay?: boolean;
  /** Applied to every tile's render, overriding whatever the catalog holds. */
  lensProfileOverride?: LensCoefficients | null;
  panelIds: string[];
  initiallyOpen: string[];
  /** The values the sliders show. Owned by the caller: it also owns the
   *  reset, the profile picker and which of camera or lens is being worked
   *  on, and three of those cannot sensibly live on different sides. */
  adjustments: Adjustments;
  onAdjustmentsChange: (next: Adjustments) => void;
  /**
   * What this bench can produce from the current selection.
   *
   * More than one because a selection shot on one body with one lens can
   * yield a camera profile and a lens profile at once, and which of the two
   * is available depends on the selection rather than on the bench.
   */
  saveActions: BenchSaveAction[];
  /** Free-text name field. Off for profiles, which are named after the thing. */
  namePlaceholder?: string;
  /** Shown instead of the save row when nothing can be produced. */
  blockedHint?: string | null;
  /** Rendered as a modal overlay, or inline inside whatever contains it. */
  variant?: 'modal' | 'inline';
  /** Shown in place of the grid when the selection is empty. */
  emptyHint?: string;
  /**
   * Controls the caller puts in the toolbar, after the comparison modes.
   *
   * Which of camera or lens is being worked on, which profile that produces
   * and how to reset it are all questions about the caller's data, not about
   * the bench - so the bench lends the row and stays out of the answer.
   */
  toolbarExtra?: React.ReactNode;
  /** Photos that break the agreement, and what they break. */
  oddPhotos?: ReadonlyMap<number, 'camera' | 'lens' | 'both'>;
  /** Drop one from the selection the bench works on. */
  onExcludePhoto?: (photoId: number) => void;
  /** Vouch for one despite its EXIF. */
  onAcceptPhoto?: (photoId: number) => void;
  /** An aside about the selection, shown above the grid. */
  skippedNote?: string;
}

export interface BenchSaveAction {
  id: string;
  label: string;
  /** Null while this action is not available for the current selection. */
  onSave: ((adjustments: Adjustments, name: string) => void) | null;
  /** Why it is unavailable, shown next to the disabled button. */
  unavailableReason?: string;
}


/**
 * Several photos side by side, one set of sliders moving all of them.
 *
 * Three places use this: the RAW base-development profile, the preset editor
 * and the lens profile. They differ in exactly three things - which photos,
 * which panels, and where the result is saved - so all three are this one
 * component with different arguments.
 */
export function AlignmentBench(props: AlignmentBenchProps) {
  if (!props.open) return null;
  return <BenchBody {...props} />;
}

function BenchBody({
  onClose, title, photos, partners, applyStoredBase = true, scopeLabel,
  extraPanels, gridOverlay, lensProfileOverride,
  panelIds, initiallyOpen, adjustments, onAdjustmentsChange,
  saveActions, namePlaceholder, blockedHint, toolbarExtra,
  variant = 'modal', emptyHint, skippedNote,
  oddPhotos, onExcludePhoto, onAcceptPhoto,
}: AlignmentBenchProps) {
  const [name, setName] = useState('');
  const [focusedId, setFocusedId] = useState<number | null>(photos[0]?.id ?? null);
  const [loupeRequest, setLoupeRequest] = useState<LoupeRequest | null>(null);
  const [passMs, setPassMs] = useState<number | null>(null);
  const [renderGen, setRenderGen] = useState(0);
  const [mode, setMode] = useState<BenchCompareMode>('raw');
  // Open by default: on this bench the loupe is the answer to a question the
  // 500px tiles cannot answer, so hiding it would hide the reason it exists.
  const [loupeCollapsed, setLoupeCollapsed] = useState(false);

  const partnerList = useMemo(
    () => (partners ?? []).filter((p): p is PhotoView => !!p),
    [partners],
  );
  const hasPartners = partnerList.length > 0;

  // What the grid shows. In 'both' the two lists are interleaved so a RAW and
  // its camera rendering land next to each other; the grid pairs them visually.
  const shownPhotos = useMemo(() => {
    if (!hasPartners || mode === 'raw') return photos;
    if (mode === 'partner') return partnerList;
    const out: PhotoView[] = [];
    photos.forEach((photo, i) => {
      out.push(photo);
      const partner = partners?.[i];
      if (partner) out.push(partner);
    });
    return out;
  }, [photos, partners, partnerList, hasPartners, mode]);

  const referenceIds = useMemo(
    () => new Set(partnerList.map((p) => p.id)),
    [partnerList],
  );
  const sourceOptions = useMemo(
    () => ({ applyStoredBase, referenceIds }),
    [applyStoredBase, referenceIds],
  );

  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const registerCanvas = useCallback((photoId: number, el: HTMLCanvasElement | null) => {
    if (el) canvases.current.set(photoId, el);
    else canvases.current.delete(photoId);
  }, []);
  const getCanvas = useCallback((photoId: number) => canvases.current.get(photoId) ?? null, []);

  const tileSources = useBenchSources(shownPhotos, sourceOptions);
  const loupe = useBenchLoupe(loupeRequest);

  const allSources = useMemo(
    () => (loupe ? [...tileSources, loupe] : tileSources),
    [tileSources, loupe],
  );

  // In pair mode each cell holds a RAW and its camera rendering. Grouping
  // happens here rather than in CSS: a plain grid would only line the two up
  // by accident, and the moment one photo has no partner the columns shift and
  // every later pair is a comparison between two unrelated pictures.
  const paired = mode === 'both' && hasPartners;
  const tileGroups = useMemo(() => {
    if (!paired) return tileSources.map((s) => [s]);
    const referenceOf = new Map<number, number>();
    photos.forEach((photo, i) => {
      const partner = partners?.[i];
      if (partner) referenceOf.set(partner.id, photo.id);
    });
    const groups: BenchSource[][] = [];
    const byLead = new Map<number, BenchSource[]>();
    for (const source of tileSources) {
      const lead = referenceOf.get(source.photoId);
      if (lead === undefined) {
        const group = [source];
        byLead.set(source.photoId, group);
        groups.push(group);
      } else {
        byLead.get(lead)?.push(source);
      }
    }
    return groups;
  }, [paired, tileSources, photos, partners]);

  const handlePass = useCallback((ms: number) => {
    setPassMs(ms);
    setRenderGen((n) => n + 1);
  }, []);

  useBenchRender(allSources, adjustments, getCanvas, handlePass, lensProfileOverride);

  const focusedCanvas = focusedId !== null ? (canvases.current.get(focusedId) ?? null) : null;

  // The panels want an editor around them. The bench is not one, so it hands
  // over the little they actually read: the focused tile as the surface the
  // histograms in the curve and levels panels measure, and a generation
  // counter so they re-measure after every pass.
  const editorValue = useMemo<EditorContextValue>(() => ({
    zoom: 1, panX: 0, panY: 0,
    setZoom: () => {}, setPanX: () => {}, setPanY: () => {},
    fitScale: 1,
    containerDims: { w: BENCH_TILE_EDGE, h: BENCH_TILE_EDGE },
    nativeImgDims: { w: BENCH_TILE_EDGE, h: BENCH_TILE_EDGE },
    imgDims: { w: BENCH_TILE_EDGE, h: BENCH_TILE_EDGE },
    displayImgW: BENCH_TILE_EDGE, displayImgH: BENCH_TILE_EDGE,
    renderGen,
    glCanvasEl: focusedCanvas,
    preCurveCanvas: null,
    preCurveGen: 0,
    displayUrl: null,
    isRaw: false,
    matchReference: null,
    rawPixels: null,
    // The bench binds its own sources; the panels read no base from here.
    rawBaseAdjustments: null,
    rawLensProfile: null,
    activeTool: 'edit',
    onToolChange: () => {},
    handleOneToOne: () => {},
    onPanChange: () => {},
  }), [renderGen, focusedCanvas]);

  const readyCount = tileSources.filter((s) => s.status === 'ready').length;
  const loading = tileSources.some((s) => s.status === 'pending' || s.status === 'loading');

  const body = (
      <div
        className={`bench-dialog ${variant}`}
        onClick={(e) => e.stopPropagation()}
        data-testid="alignment-bench"
      >
        <div className="bench-header">
          <h2>{title}</h2>
          <div className="bench-header-status">
            {loading
              ? `lädt ${readyCount} von ${tileSources.length}`
              : `${readyCount} Bilder`}
            {passMs !== null && !loading && ` · ${Math.round(passMs)} ms/Durchlauf`}
          </div>
          <div style={{ flex: 1 }} />
          {blockedHint
            ? <span className="bench-blocked">{blockedHint}</span>
            : (
              <>
                {namePlaceholder && (
                  <input
                    className="bench-name-input"
                    type="text"
                    placeholder={namePlaceholder}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                )}
                {saveActions.map((action) => (
                  <button
                    key={action.id}
                    className="bench-save-btn"
                    data-testid={`bench-save-${action.id}`}
                    title={action.unavailableReason}
                    disabled={!action.onSave || (!!namePlaceholder && !name.trim())}
                    onClick={() => {
                      action.onSave?.(adjustments, name.trim() || (scopeLabel ?? 'Profil'));
                      // A profile bench stays open: the two save actions are
                      // separate answers about the same selection, and closing
                      // after the first would hide the second.
                      if (variant === 'modal' && saveActions.length === 1) onClose();
                    }}
                  >{action.label}</button>
                ))}
              </>
            )}
          {variant === 'modal' && (
            <button className="bench-close" onClick={onClose} aria-label="Schliessen">×</button>
          )}
        </div>

        <div className="bench-body">
          <div className={`bench-grid-wrap ${paired ? 'scrollable' : ''}`}>
            <div className="bench-toolbar">
              {hasPartners && (
                <div className="bench-modes">
                  {([
                    ['raw', 'RAW'],
                    ['partner', 'HEIC/JPG'],
                    ['both', 'nebeneinander'],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      className={`bench-mode-btn ${mode === value ? 'active' : ''}`}
                      data-testid={`bench-mode-${value}`}
                      onClick={() => setMode(value)}
                    >{label}</button>
                  ))}
                </div>
              )}
              {toolbarExtra}
            </div>
            {scopeLabel && <div className="bench-scope">Gilt für: <strong>{scopeLabel}</strong></div>}
            {skippedNote && <div className="bench-note">{skippedNote}</div>}
            {tileGroups.length === 0 && emptyHint && (
              <div className="bench-nothing">{emptyHint}</div>
            )}
            <div className={`bench-grid ${paired ? 'paired' : ''} ${tileGroups.length === 1 ? 'single' : ''}`}>
              {tileGroups.map((group) => (
                <div className={paired ? 'bench-pair' : 'bench-single'} key={group[0].photoId}>
                  {group.map((s) => (
                    <BenchTile
                      key={s.photoId}
                      source={s}
                      focused={s.photoId === focusedId}
                      onFocus={() => setFocusedId(s.photoId)}
                      onPick={(x, y) => {
                        const photo = shownPhotos.find((p) => p.id === s.photoId);
                        if (photo) setLoupeRequest({ photo, x, y });
                      }}
                      gridOverlay={gridOverlay}
                      odd={oddPhotos?.get(s.photoId)}
                      onExclude={onExcludePhoto ? () => onExcludePhoto(s.photoId) : undefined}
                      onAccept={onAcceptPhoto ? () => onAcceptPhoto(s.photoId) : undefined}
                      registerCanvas={registerCanvas}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="bench-side">
            <ModularPanel
              definition={{
                id: 'benchloupe', title: 'uiShell.panelRegistry.loupe', icon: null,
                defaultZone: 'right', defaultOpen: true, context: 'editor',
              }}
              collapsed={loupeCollapsed}
              onToggle={() => setLoupeCollapsed((v) => !v)}
            >
              <div className="bench-loupe">
                <div className="bench-loupe-head">
                  <span>1:1 aus dem Original</span>
                  {loupe && (
                    <button className="bench-loupe-clear" onClick={() => setLoupeRequest(null)}>
                      zurücksetzen
                    </button>
                  )}
                </div>
                <div className="bench-loupe-frame">
                  <canvas
                    ref={(el) => registerCanvas(LOUPE_PHOTO_ID, el)}
                    className="bench-loupe-canvas"
                  />
                  {(!loupe || loupe.status !== 'ready') && (
                    <div className="bench-tile-state">
                      {!loupe ? 'In eine Kachel klicken' : loupe.status === 'error' ? (loupe.error ?? 'Fehler') : 'lädt …'}
                    </div>
                  )}
                </div>
                <div className="bench-loupe-hint">
                  Schärfe und Entrauschung sind bei {BENCH_TILE_EDGE} px nicht beurteilbar — dafür ist die Lupe da.
                </div>
              </div>
            </ModularPanel>

            <AdjustmentsProvider adjustments={adjustments} onChange={onAdjustmentsChange}>
              <EditorProvider value={editorValue}>
                <BenchPanels
                  panelIds={panelIds}
                  initiallyOpen={initiallyOpen}
                  extraPanels={extraPanels}
                />
              </EditorProvider>
            </AdjustmentsProvider>
          </div>
        </div>
      </div>
  );

  if (variant === 'inline') return body;
  return <div className="bench-overlay" onClick={onClose}>{body}</div>;
}
