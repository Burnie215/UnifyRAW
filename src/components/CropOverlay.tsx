import './CropOverlay.css';

export type CropOverlayType = 'none' | 'thirds' | 'phi' | 'spiral' | 'diagonal' | 'triangle';

interface CropOverlayProps {
  type: CropOverlayType;
  width: number;
  height: number;
  spiralRotation?: number; // 0-3, rotated by 90° each
}

export function CropOverlay({ type, width, height, spiralRotation = 0 }: CropOverlayProps) {
  if (type === 'none' || !width || !height) return null;

  return (
    <svg
      className="crop-overlay-svg"
      viewBox={`0 0 ${width} ${height}`}
      style={{ width, height }}
    >
      {type === 'thirds' && <Thirds w={width} h={height} />}
      {type === 'phi' && <Phi w={width} h={height} />}
      {type === 'diagonal' && <Diagonal w={width} h={height} />}
      {type === 'triangle' && <Triangle w={width} h={height} />}
      {type === 'spiral' && <Spiral w={width} h={height} rot={spiralRotation} />}
    </svg>
  );
}

function Thirds({ w, h }: { w: number; h: number }) {
  const x1 = w / 3, x2 = (2 * w) / 3;
  const y1 = h / 3, y2 = (2 * h) / 3;
  return (
    <g className="crop-lines">
      <line x1={x1} y1={0} x2={x1} y2={h} />
      <line x1={x2} y1={0} x2={x2} y2={h} />
      <line x1={0} y1={y1} x2={w} y2={y1} />
      <line x1={0} y1={y2} x2={w} y2={y2} />
    </g>
  );
}

function Phi({ w, h }: { w: number; h: number }) {
  const phi = 1 / 1.618;
  const x1 = w * phi, x2 = w * (1 - phi);
  const y1 = h * phi, y2 = h * (1 - phi);
  return (
    <g className="crop-lines">
      <line x1={x1} y1={0} x2={x1} y2={h} />
      <line x1={x2} y1={0} x2={x2} y2={h} />
      <line x1={0} y1={y1} x2={w} y2={y1} />
      <line x1={0} y1={y2} x2={w} y2={y2} />
    </g>
  );
}

function Diagonal({ w, h }: { w: number; h: number }) {
  return (
    <g className="crop-lines">
      <line x1={0} y1={0} x2={w} y2={h} />
      <line x1={w} y1={0} x2={0} y2={h} />
    </g>
  );
}

function Triangle({ w, h }: { w: number; h: number }) {
  return (
    <g className="crop-lines">
      <line x1={0} y1={h} x2={w} y2={0} />
      <line x1={0} y1={0} x2={w * 0.6} y2={h} />
      <line x1={w} y1={h} x2={w * 0.4} y2={0} />
    </g>
  );
}

function Spiral({ w, h, rot }: { w: number; h: number; rot: number }) {
  const phi = 1.618;
  // Build fibonacci spiral approximation
  const cx = w / phi;
  const cy = h / phi;

  // Simplified golden spiral as arcs
  const r1 = Math.min(w, h) / phi;
  const r2 = r1 / phi;
  const r3 = r2 / phi;
  const r4 = r3 / phi;

  const rotation = rot * 90;

  return (
    <g className="crop-lines" transform={`rotate(${rotation}, ${w / 2}, ${h / 2})`}>
      {/* Phi grid lines */}
      <line x1={cx} y1={0} x2={cx} y2={h} />
      <line x1={0} y1={cy} x2={w} y2={cy} />
      {/* Spiral arcs */}
      <path d={`M ${cx} ${cy} A ${r1} ${r1} 0 0 1 ${cx + r1 * 0.7} ${cy - r1 * 0.7}`} fill="none" />
      <path d={`M ${cx} ${cy} A ${r2} ${r2} 0 0 0 ${cx - r2 * 0.7} ${cy - r2 * 0.7}`} fill="none" />
      <path d={`M ${cx} ${cy} A ${r3} ${r3} 0 0 1 ${cx - r3 * 0.5} ${cy + r3 * 0.5}`} fill="none" />
      <path d={`M ${cx} ${cy} A ${r4} ${r4} 0 0 0 ${cx + r4 * 0.3} ${cy + r4 * 0.3}`} fill="none" />
    </g>
  );
}
