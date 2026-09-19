import { CompactSlider as Slider } from '../../ui/CompactSlider';
import type { LensCoefficients } from '../../engine/lensProfile';

interface LensCoefficientsPanelProps {
  value: LensCoefficients;
  onChange: (next: LensCoefficients) => void;
  gridOverlay: boolean;
  onGridOverlayChange: (on: boolean) => void;
}

/**
 * The eight Brown-Conrady coefficients, as sliders.
 *
 * They are not adjustments and deliberately do not live in `Adjustments`: a
 * lens profile describes a piece of glass, so it is measured once and then
 * applies to every frame from that lens rather than being carried per photo.
 *
 * The sliders work in the units the shader uses, not in a prettified scale.
 * Distortion coefficients are small numbers around zero and a "0..100" facade
 * over them would only make a measured value impossible to write down or
 * compare against a published one.
 */
export function LensCoefficientsPanel({
  value, onChange, gridOverlay, onGridOverlayChange,
}: LensCoefficientsPanelProps) {
  const set = <K extends keyof LensCoefficients>(key: K, v: number) =>
    onChange({ ...value, [key]: v });

  return (
    <>
      <label className="lens-grid-toggle">
        <input
          type="checkbox"
          checked={gridOverlay}
          data-testid="lens-grid-toggle"
          onChange={(e) => onGridOverlayChange(e.target.checked)}
        />
        <span>Gitter einblenden</span>
      </label>
      <div className="lens-group-label">Entzerrung</div>
      <Slider label="k1" value={value.k1} min={-0.3} max={0.3} step={0.001} defaultValue={0}
        onChange={(v) => set('k1', v)} />
      <Slider label="k2" value={value.k2} min={-0.2} max={0.2} step={0.001} defaultValue={0}
        onChange={(v) => set('k2', v)} />
      <Slider label="k3" value={value.k3} min={-0.1} max={0.1} step={0.001} defaultValue={0}
        onChange={(v) => set('k3', v)} />
      <div className="lens-group-label">Vignettierung</div>
      <Slider label="v1" value={value.v1} min={-3} max={3} step={0.01} defaultValue={0}
        onChange={(v) => set('v1', v)} />
      <Slider label="v2" value={value.v2} min={-3} max={3} step={0.01} defaultValue={0}
        onChange={(v) => set('v2', v)} />
      <Slider label="v3" value={value.v3} min={-3} max={3} step={0.01} defaultValue={0}
        onChange={(v) => set('v3', v)} />
      <div className="lens-group-label">Chromatische Aberration</div>
      <Slider label="caR" value={value.caR} min={-0.003} max={0.003} step={0.00001} defaultValue={0}
        onChange={(v) => set('caR', v)} />
      <Slider label="caB" value={value.caB} min={-0.003} max={0.003} step={0.00001} defaultValue={0}
        onChange={(v) => set('caB', v)} />
    </>
  );
}
