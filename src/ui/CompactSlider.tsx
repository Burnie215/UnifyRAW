import { useState } from 'react';
import './CompactSlider.css';

interface CompactSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  onChange: (value: number) => void;
  /** Optional gradient for the track background (e.g. "linear-gradient(to right, blue, orange)") */
  trackGradient?: string;
  /** Inert and dimmed - used while the value cannot be written anywhere yet. */
  disabled?: boolean;
}

export function CompactSlider({ label, value, min, max, step = 1, defaultValue = 0, onChange, trackGradient, disabled = false }: CompactSliderProps) {
  const [editing, setEditing] = useState(false);

  // How many decimals the step can actually reach. A slider stepping by 0.005
  // that prints one decimal shows the same number for three different
  // positions, which is how a scale stops being readable (F018).
  const decimals = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));

  // Calculate fill percentage for colored track
  const range = max - min;
  const zeroPos = Math.max(0, Math.min(100, ((0 - min) / range) * 100));
  const valPos = ((value - min) / range) * 100;
  const fillLeft = Math.min(zeroPos, valPos);
  const fillWidth = Math.abs(valPos - zeroPos);

  return (
    <div className={`cs ${disabled ? 'disabled' : ''}`}>
      <span className="cs-label">{label}</span>
      <div className="cs-track-wrap" style={trackGradient ? { background: trackGradient } : undefined}>
        {!trackGradient && <div className="cs-fill" style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }} />}
        <input
          type="range"
          className="cs-range"
          min={min} max={max} step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          onDoubleClick={() => onChange(defaultValue)}
        />
      </div>
      {editing && !disabled ? (
        <input
          className="cs-input"
          type="number"
          defaultValue={value}
          step={step}
          onBlur={(e) => { onChange(Number(e.target.value)); setEditing(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false); }}
          autoFocus
        />
      ) : (
        <span className="cs-value" onClick={() => { if (!disabled) setEditing(true); }}>
          {value > 0 && min < 0 ? '+' : ''}{decimals > 0 ? value.toFixed(decimals) : value}
        </span>
      )}
    </div>
  );
}
