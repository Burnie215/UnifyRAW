/* eslint-disable react-refresh/only-export-components -- The inspector predicate and component form one registry boundary. */
/**
 * Pretty per-kind inspectors for adjustment nodes — replaces the generic
 * JSON-schema form for the kinds the user actually edits. Layout mirrors
 * the classic editor's right-rail panels (CompactSlider, ToneCurve,
 * ColorGradingPanel) so the Graph-mode feels like the same app.
 *
 * For kinds without a tailored inspector (sources, decoders, encoders,
 * compositors, masks, taps, generators, transform-detail) NodeInspectorPanel
 * keeps falling back to the generic schema form.
 */
import { useTranslation } from 'react-i18next';
import { CompactSlider as Slider } from '../ui/CompactSlider';
import { toParam, toUi } from './inspectorScale';
import { ColorGradingPanel } from './ColorGradingPanel';
import { useEditor } from '../contexts/EditorContext';
import { useSettings } from '../contexts/SettingsContext';
import { ToneCurve } from './ToneCurve';
import {
  KIND_TONE, KIND_WHITE_BALANCE, KIND_HSL, KIND_HSL_DETAIL,
  KIND_BW, KIND_CLARITY, KIND_TEXTURE, KIND_SHARPEN, KIND_DENOISE,
  KIND_EFFECTS, KIND_COLOR_GRADING, KIND_TONE_CURVE, KIND_TRANSFORM,
  KIND_WHITE_BALANCE_RAW,
} from '../engine/graph';
import type { RenderNode } from '../engine/graph';
import type { ColorGrading } from '../types';

/** Kinds we render a tailored inspector for. */
const HANDLED_KINDS = new Set<string>([
  KIND_TONE, KIND_WHITE_BALANCE, KIND_HSL, KIND_HSL_DETAIL,
  KIND_BW, KIND_CLARITY, KIND_TEXTURE, KIND_SHARPEN, KIND_DENOISE,
  KIND_EFFECTS, KIND_COLOR_GRADING, KIND_TONE_CURVE, KIND_TRANSFORM,
  KIND_WHITE_BALANCE_RAW,
]);

export function hasTailoredInspector(kind: string): boolean {
  return HANDLED_KINDS.has(kind);
}

export interface AdjustmentInspectorProps {
  node: RenderNode;
  onParamsChange: (params: unknown) => void;
}

/** Dispatch by node kind. Caller has already verified hasTailoredInspector. */
export function NodeAdjustmentInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  switch (node.kind) {
    case KIND_TONE:            return <ToneInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_WHITE_BALANCE:   return <WhiteBalanceInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_HSL:             return <HslInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_HSL_DETAIL:      return <HslDetailInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_BW:              return <BwInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_CLARITY:         return <ClarityInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_TEXTURE:         return <TextureInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_SHARPEN:         return <SharpenInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_DENOISE:         return <DenoiseInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_EFFECTS:         return <EffectsInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_COLOR_GRADING:   return <ColorGradingInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_TONE_CURVE:      return <ToneCurveInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_TRANSFORM:       return <TransformInspector node={node} onParamsChange={onParamsChange} />;
    case KIND_WHITE_BALANCE_RAW: return <WhiteBalanceRawInspector node={node} onParamsChange={onParamsChange} />;
    default: return null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function patch<P extends object>(params: P, key: keyof P, value: P[keyof P]): P {
  return { ...params, [key]: value };
}

// ─── Tone ─────────────────────────────────────────────────────────

interface ToneP { exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number }

function ToneInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as ToneP;
  const set = <K extends keyof ToneP>(k: K, v: number) => onParamsChange(patch(p, k, toParam(v) as ToneP[K]));
  return (
    <>
      <Slider label={t('panels.raw.exposure')} value={toUi(p.exposure)} min={-100} max={100} onChange={(v) => set('exposure', v)}
        trackGradient="linear-gradient(to right, #1a1a1a, #f0f0f0)" />
      <Slider label={t('panels.raw.contrast')} value={toUi(p.contrast)} min={-100} max={100} onChange={(v) => set('contrast', v)}
        trackGradient="linear-gradient(to right, #666, #1a1a1a 45%, #f0f0f0 55%, #666)" />
      <Slider label={t('panels.raw.highlights')} value={toUi(p.highlights)} min={-100} max={100} onChange={(v) => set('highlights', v)}
        trackGradient="linear-gradient(to right, #555, #f0f0f0)" />
      <Slider label={t('panels.raw.shadows')} value={toUi(p.shadows)} min={-100} max={100} onChange={(v) => set('shadows', v)}
        trackGradient="linear-gradient(to right, #1a1a1a, #888)" />
      <Slider label={t('panels.raw.whites')} value={toUi(p.whites)} min={-100} max={100} onChange={(v) => set('whites', v)}
        trackGradient="linear-gradient(to right, #aaa, #ffffff)" />
      <Slider label={t('panels.raw.blacks')} value={toUi(p.blacks)} min={-100} max={100} onChange={(v) => set('blacks', v)}
        trackGradient="linear-gradient(to right, #000000, #555)" />
    </>
  );
}

// ─── White Balance (SDR) ──────────────────────────────────────────

interface WbP { temperature: number; tint: number }

function WhiteBalanceInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as WbP;
  const set = <K extends keyof WbP>(k: K, v: number) => onParamsChange(patch(p, k, toParam(v) as WbP[K]));
  return (
    <>
      <Slider label={t('panels.raw.temperature')} value={toUi(p.temperature)} min={-100} max={100} onChange={(v) => set('temperature', v)}
        trackGradient="linear-gradient(to right, #4a90d9, #e8a838)" />
      <Slider label={t('panels.raw.tint')} value={toUi(p.tint)} min={-100} max={100} onChange={(v) => set('tint', v)}
        trackGradient="linear-gradient(to right, #5cb85c, #d95ca0)" />
    </>
  );
}

// ─── HSL (vibrance/saturation only) ───────────────────────────────

interface HslP { vibrance: number; saturation: number }

function HslInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as HslP;
  const set = <K extends keyof HslP>(k: K, v: number) => onParamsChange(patch(p, k, toParam(v) as HslP[K]));
  return (
    <>
      <Slider label={t('panels.raw.vibrance')} value={toUi(p.vibrance)} min={-100} max={100} onChange={(v) => set('vibrance', v)}
        trackGradient="linear-gradient(to right, #666, #e67e22)" />
      <Slider label={t('panels.raw.saturation')} value={toUi(p.saturation)} min={-100} max={100} onChange={(v) => set('saturation', v)}
        trackGradient="linear-gradient(to right, #777, #e74c3c, #e67e22, #f1c40f, #2ecc71, #3498db, #9b59b6)" />
    </>
  );
}

// ─── HSL Detail (8 channels × 3 sliders) ──────────────────────────

interface HslChannelP { hue: number; saturation: number; luminance: number }
interface HslDetailP { channels: Record<string, HslChannelP> }

const HSL_CHANNEL_DEFS: { key: string; labelKey: string; color: string }[] = [
  { key: 'red',     labelKey: 'uiShell.colorPanels.red',     color: '#e74c3c' },
  { key: 'orange',  labelKey: 'uiShell.colorPanels.orange',  color: '#e67e22' },
  { key: 'yellow',  labelKey: 'uiShell.colorPanels.yellow',  color: '#f1c40f' },
  { key: 'green',   labelKey: 'uiShell.colorPanels.green',   color: '#2ecc71' },
  { key: 'aqua',    labelKey: 'uiShell.colorPanels.aqua',    color: '#1abc9c' },
  { key: 'blue',    labelKey: 'uiShell.colorPanels.blue',    color: '#3498db' },
  { key: 'purple',  labelKey: 'uiShell.colorPanels.purple',  color: '#9b59b6' },
  { key: 'magenta', labelKey: 'uiShell.colorPanels.magenta', color: '#e91e63' },
];

function HslDetailInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as HslDetailP;
  const setChannel = (key: string, next: HslChannelP) => {
    onParamsChange({ ...p, channels: { ...p.channels, [key]: next } });
  };
  return (
    <>
      {HSL_CHANNEL_DEFS.map(({ key, labelKey, color }) => {
        const c = p.channels[key] ?? { hue: 0, saturation: 0, luminance: 0 };
        return (
          <div key={key} style={{ marginBottom: 8 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 11, fontWeight: 600, color: 'var(--text-secondary, #ccc)',
              padding: '4px 0',
            }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: color, display: 'inline-block' }} />
              {t(labelKey)}
            </div>
            <Slider label={t('panels.color.hue')} value={c.hue} min={-100} max={100}
              onChange={(v) => setChannel(key, { ...c, hue: v })}
              trackGradient={`linear-gradient(to right, ${color}, #888, ${color})`} />
            <Slider label={t('panels.raw.saturation')} value={c.saturation} min={-100} max={100}
              onChange={(v) => setChannel(key, { ...c, saturation: v })}
              trackGradient={`linear-gradient(to right, #666, ${color})`} />
            <Slider label={t('panels.tone.luminance')} value={c.luminance} min={-100} max={100}
              onChange={(v) => setChannel(key, { ...c, luminance: v })}
              trackGradient={`linear-gradient(to right, #000, ${color}, #fff)`} />
          </div>
        );
      })}
    </>
  );
}

// ─── BW Mix ───────────────────────────────────────────────────────

interface BwMixP { red: number; orange: number; yellow: number; green: number; aqua: number; blue: number; purple: number; magenta: number }
interface BwP { enabled: boolean; mix: BwMixP }

function BwInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as BwP;
  const setMix = (k: keyof BwMixP, v: number) => onParamsChange({ ...p, mix: { ...p.mix, [k]: v } });
  return (
    <>
      <div style={{ padding: '4px 0 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-secondary, #ccc)' }}>{t('graphEditor.inspector.labels.bwActive')}</span>
        <input type="checkbox" checked={!!p.enabled} onChange={(ev) => onParamsChange({ ...p, enabled: ev.target.checked })} />
      </div>
      {HSL_CHANNEL_DEFS.map(({ key, labelKey, color }) => (
        <Slider key={key} label={t(labelKey)} value={p.mix?.[key as keyof BwMixP] ?? 0}
          min={-100} max={100} onChange={(v) => setMix(key as keyof BwMixP, v)}
          trackGradient={`linear-gradient(to right, #111, ${color}, #fff)`} />
      ))}
    </>
  );
}

// ─── Clarity (clarity + dehaze) ───────────────────────────────────

interface ClarityP { clarity: number; dehaze: number }

function ClarityInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as ClarityP;
  const set = <K extends keyof ClarityP>(k: K, v: number) => onParamsChange(patch(p, k, toParam(v) as ClarityP[K]));
  return (
    <>
      <Slider label={t('panels.raw.clarity')} value={toUi(p.clarity)} min={-100} max={100} onChange={(v) => set('clarity', v)}
        trackGradient="linear-gradient(to right, #555, #ccc)" />
      <Slider label={t('panels.raw.dehaze')} value={toUi(p.dehaze)} min={-100} max={100} onChange={(v) => set('dehaze', v)}
        trackGradient="linear-gradient(to right, rgba(180,200,220,0.4), rgba(80,130,180,0.6))" />
    </>
  );
}

// ─── Texture (single slider) ──────────────────────────────────────

interface TextureP { amount: number }

function TextureInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as TextureP;
  return (
    <Slider label={t('panels.raw.texture')} value={toUi(p.amount)} min={-100} max={100}
      onChange={(v) => onParamsChange({ ...p, amount: toParam(v) })}
      trackGradient="linear-gradient(to right, #444, #999)" />
  );
}

// ─── Sharpen (single slider) ──────────────────────────────────────

interface SharpenP { sharpness: number }

function SharpenInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as SharpenP;
  return (
    <Slider label={t('uiShell.toolPanels.sharpness')} value={p.sharpness * 100} min={0} max={150} step={1}
      onChange={(v) => onParamsChange({ ...p, sharpness: v / 100 })} />
  );
}

// ─── Denoise (luma / chroma / detail) ─────────────────────────────

interface DenoiseP { luma: number; chroma: number; detail: number }

function DenoiseInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as DenoiseP;
  const set = <K extends keyof DenoiseP>(k: K, v: DenoiseP[K]) => onParamsChange(patch(p, k, v));
  return (
    <>
      <Slider label={t('panels.histogram.luma')} value={p.luma * 100} min={0} max={100}
        onChange={(v) => set('luma', v / 100)} />
      <Slider label={t('graphEditor.inspector.labels.chroma')} value={p.chroma * 100} min={0} max={100}
        onChange={(v) => set('chroma', v / 100)} />
      <Slider label={t('graphEditor.inspector.labels.detail')} value={p.detail * 100} min={0} max={100}
        onChange={(v) => set('detail', v / 100)} />
    </>
  );
}

// ─── Effects (vignette / grain) ───────────────────────────────────

interface EffectsP {
  vignette: number; vignetteFeather: number;
  grain: number; grainSize: number;
  noiseReduction: number;
}

function EffectsInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as EffectsP;
  const set = <K extends keyof EffectsP>(k: K, v: EffectsP[K]) => onParamsChange(patch(p, k, v));
  return (
    <>
      <div style={sectionLabelStyle}>{t('uiShell.toolPanels.vignette')}</div>
      <Slider label={t('graphEditor.inspector.labels.amount')} value={p.vignette * 100} min={-100} max={100}
        onChange={(v) => set('vignette', v / 100)} />
      <Slider label={t('panels.masks.softness')} value={p.vignetteFeather * 100} min={0} max={100}
        onChange={(v) => set('vignetteFeather', v / 100)} />
      <div style={sectionLabelStyle}>{t('uiShell.toolPanels.grain')}</div>
      <Slider label={t('graphEditor.inspector.labels.amount')} value={p.grain * 100} min={0} max={100}
        onChange={(v) => set('grain', v / 100)} />
      <Slider label={t('uiShell.toolPanels.grainSize')} value={p.grainSize} min={1} max={100} step={1}
        onChange={(v) => set('grainSize', v)} />
      <Slider label={t('uiShell.toolPanels.noiseReduction')} value={p.noiseReduction * 100} min={0} max={100}
        onChange={(v) => set('noiseReduction', v / 100)} />
    </>
  );
}

// ─── Color Grading (reuse existing panel) ─────────────────────────

function ColorGradingInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const p = node.params as ColorGrading;
  const toEditorZone = (zone: ColorGrading['shadows']) => ({
    ...zone,
    satAdj: toUi(zone.satAdj),
    lumAdj: toUi(zone.lumAdj),
  });
  const grading: ColorGrading = {
    ...p,
    shadows: toEditorZone(p.shadows),
    midtones: toEditorZone(p.midtones),
    highlights: toEditorZone(p.highlights),
  };
  const handleChange = (next: ColorGrading) => {
    const toGraphZone = (zone: ColorGrading['shadows']) => ({
      ...zone,
      satAdj: toParam(zone.satAdj),
      lumAdj: toParam(zone.lumAdj),
    });
    onParamsChange({
      ...next,
      shadows: toGraphZone(next.shadows),
      midtones: toGraphZone(next.midtones),
      highlights: toGraphZone(next.highlights),
    });
  };
  return <ColorGradingPanel grading={grading} onChange={handleChange} />;
}

// ─── Tone Curve (reuse existing ToneCurve) ────────────────────────

interface ToneCurveP {
  rgb: { x: number; y: number }[];
  luma: { x: number; y: number }[];
  red: { x: number; y: number }[];
  green: { x: number; y: number }[];
  blue: { x: number; y: number }[];
}

function ToneCurveInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  // ToneCurve sub-component expects a single ToneCurveAdjustment object. The
  // graph-node params have the same shape, just wrapped at the channels level.
  const p = node.params as ToneCurveP;
  const editor = useEditor();
  const { histogramStyle } = useSettings();
  return (
    <ToneCurve
      curve={p as never}
      onChange={(c) => onParamsChange(c)}
      imageUrl={editor.displayUrl ?? undefined}
      renderedCanvas={editor.preCurveCanvas ?? editor.glCanvasEl ?? null}
      renderGeneration={editor.preCurveCanvas ? editor.preCurveGen : editor.renderGen}
      histogramStyle={histogramStyle}
    />
  );
}

// ─── Transform ────────────────────────────────────────────────────

interface TransformP {
  rotation: number; flipH: boolean; flipV: boolean;
  perspectiveH: number; perspectiveV: number; distortion: number;
}

function TransformInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as TransformP;
  const set = <K extends keyof TransformP>(k: K, v: TransformP[K]) => onParamsChange(patch(p, k, v));
  const rotationDeg = (p.rotation * 180 / Math.PI);
  return (
    <>
      <Slider label={`${t('uiShell.toolPanels.rotation')} °`} value={rotationDeg} min={-180} max={180} step={1}
        onChange={(v) => set('rotation', v * Math.PI / 180)} />
      <div style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
        <label style={flipLabelStyle}>
          <input type="checkbox" checked={!!p.flipH} onChange={(ev) => set('flipH', ev.target.checked)} />
          {t('graphEditor.inspector.labels.flipH')}
        </label>
        <label style={flipLabelStyle}>
          <input type="checkbox" checked={!!p.flipV} onChange={(ev) => set('flipV', ev.target.checked)} />
          {t('graphEditor.inspector.labels.flipV')}
        </label>
      </div>
      <Slider label={t('uiShell.toolPanels.perspectiveH')} value={p.perspectiveH * 100} min={-100} max={100}
        onChange={(v) => set('perspectiveH', v / 100)} />
      <Slider label={t('uiShell.toolPanels.perspectiveV')} value={p.perspectiveV * 100} min={-100} max={100}
        onChange={(v) => set('perspectiveV', v / 100)} />
      <Slider label={t('uiShell.toolPanels.distortion')} value={p.distortion * 100} min={-100} max={100}
        onChange={(v) => set('distortion', v / 100)} />
    </>
  );
}

// ─── WhiteBalanceRaw (3 multipliers) ──────────────────────────────

interface WbRawP { wb: [number, number, number] }

function WhiteBalanceRawInspector({ node, onParamsChange }: AdjustmentInspectorProps) {
  const { t } = useTranslation();
  const p = node.params as WbRawP;
  const setMul = (idx: 0 | 1 | 2, v: number) => {
    const wb: [number, number, number] = [...p.wb] as [number, number, number];
    wb[idx] = v;
    onParamsChange({ wb });
  };
  return (
    <>
      <div style={{ ...sectionLabelStyle, marginBottom: 4 }}>{t('graphEditor.inspector.labels.rawWbMultipliers')}</div>
      <Slider label="R" value={p.wb[0]} min={0.1} max={4} step={0.01}
        onChange={(v) => setMul(0, v)} trackGradient="linear-gradient(to right, #111, #e74c3c)" />
      <Slider label="G" value={p.wb[1]} min={0.1} max={4} step={0.01}
        onChange={(v) => setMul(1, v)} trackGradient="linear-gradient(to right, #111, #2ecc71)" />
      <Slider label="B" value={p.wb[2]} min={0.1} max={4} step={0.01}
        onChange={(v) => setMul(2, v)} trackGradient="linear-gradient(to right, #111, #3498db)" />
    </>
  );
}

// ─── Shared styles ────────────────────────────────────────────────

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
  color: 'var(--text-tertiary, #888)', padding: '8px 0 2px',
};

const flipLabelStyle: React.CSSProperties = {
  display: 'inline-flex', gap: 4, alignItems: 'center',
  fontSize: 11, color: 'var(--text-secondary, #ccc)', cursor: 'pointer',
};
