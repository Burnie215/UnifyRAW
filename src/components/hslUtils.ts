import type { HSLChannel } from '../types';
import { skinTonePickFor } from '../engine/skinTone';

/* ═══════════════════════════════════════════════════════════════════
   Color Conversion
   ═════════════════════════════��════════════════════════��════════════ */

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sN = s / 100, lN = l / 100;
  const C = (1 - Math.abs(2 * lN - 1)) * sN;
  const X = C * (1 - Math.abs((h / 60) % 2 - 1));
  const m = lN - C / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60)       { r = C; g = X; }
  else if (h < 120) { r = X; g = C; }
  else if (h < 180) { g = C; b = X; }
  else if (h < 240) { g = X; b = C; }
  else if (h < 300) { r = X; b = C; }
  else              { r = C; b = X; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/* ═══════════════════════════════════════════════════════════════════
   Display damping
   ═══════════════════════════════════════════════════════════════════ */

/**
 * The wheels paint hues at reduced chroma so a fully saturated red reads as
 * rgb(200,20,20) rather than rgb(255,0,0). Purely cosmetic: hue and radius
 * still map to the real values, and the pipeline never sees these numbers.
 */
const DISPLAY_SAT_SCALE = 0.82;
const DISPLAY_L_DROP = 7;

/** Damped (saturation, lightness) pair for on-screen hue rendering. */
export function toDisplaySL(s: number, l: number): [number, number] {
  const chroma = s / 100;
  // Tent falloff keeps white and black endpoints intact, dims only mid tones.
  const drop = DISPLAY_L_DROP * chroma * (l <= 50 ? l / 50 : (100 - l) / 50);
  return [s * DISPLAY_SAT_SCALE, l - drop];
}

/** CSS hsl() string with display damping applied. */
export function displayHsl(h: number, s = 100, l = 50): string {
  const [ds, dl] = toDisplaySL(s, l);
  return `hsl(${h}, ${ds}%, ${dl}%)`;
}

export function glslSmoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/* ══════════════════════════════��════════════════════════════════════
   Constants
   ══��═══════════════════��════════════════════════════════════���═══════ */

export const SIZE = 260;
export const RING_W = 6;
export const OUTER_R = SIZE / 2 - 2;
export const INNER_R = OUTER_R - RING_W;
export const PICK_R = INNER_R - 2;

export const toRad = (deg: number) => (deg - 90) * Math.PI / 180;

/* ════════��═══════════════════════���══════════════════════════════════
   Sector Data
   ══���══════════════════════════════════════════════════════��═════════ */

export interface Sector {
  id: string;
  hueCenter: number;
  hueHalfWidth: number;
  satMin: number;
  satMax: number;
  feather: number;
  pickRelHue: number;
  pickRelSat: number;
  selLightness: number;
  dH: number;
  dS: number;
  dL: number;
  enabled: boolean;
}

export function makeSector(hue: number, hw = 18, pickSat = 50): Sector {
  const satMin = Math.max(0, pickSat - 20);
  const satMax = Math.min(100, pickSat + 20);
  return {
    id: crypto.randomUUID(),
    hueCenter: hue, hueHalfWidth: hw,
    satMin, satMax, feather: 12,
    pickRelHue: 0.5,
    pickRelSat: (pickSat - satMin) / (satMax - satMin),
    selLightness: 0,
    dH: 0, dS: 0, dL: 0, enabled: true,
  };
}

export function getPickAbs(s: Sector) {
  return skinTonePickFor(s);
}

export const BASIC: { key: HSLChannel; color: string; hue: number; hw: number }[] = [
  { key: 'red',     color: '#e74c3c', hue: 0,   hw: 20 },
  { key: 'orange',  color: '#e67e22', hue: 33,  hw: 13 },
  { key: 'yellow',  color: '#f1c40f', hue: 60,  hw: 13 },
  { key: 'green',   color: '#2ecc71', hue: 120, hw: 25 },
  { key: 'aqua',    color: '#1abc9c', hue: 180, hw: 18 },
  { key: 'blue',    color: '#3498db', hue: 220, hw: 18 },
  { key: 'purple',  color: '#9b59b6', hue: 275, hw: 18 },
  { key: 'magenta', color: '#e91e90', hue: 330, hw: 13 },
];

/* ══════════════════════════════���════════════════════════════════════
   Interaction Helpers
   ═════════════��═════════════════════════════════��═══════════════════ */

export type DragMode = 'schenkelL' | 'schenkelR' | 'mitte' | 'sideOuter' | 'sideInner' | 'pickPoint';

export function getHueSat(e: { clientX: number; clientY: number }, el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const cx = SIZE / 2, cy = SIZE / 2;
  const px = ((e.clientX - rect.left) / rect.width) * SIZE - cx;
  const py = ((e.clientY - rect.top) / rect.height) * SIZE - cy;
  return {
    hue: ((Math.atan2(py, px) * 180 / Math.PI) + 90 + 360) % 360,
    sat: Math.min(100, (Math.hypot(px, py) / PICK_R) * 100),
    screenX: ((e.clientX - rect.left) / rect.width) * SIZE,
    screenY: ((e.clientY - rect.top) / rect.height) * SIZE,
  };
}

export function hueDiff(a: number, b: number) {
  let d = a - b;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/* ═══════════════════════════════════════════════════════════════════
   Canvas Drawing
   ═��═════════════════════════════════════════════════════════════════ */

export function buildColorImageData(sector: Sector): ImageData {
  const cx = SIZE / 2, cy = SIZE / 2;
  const hueFeather = sector.feather * 1.5;
  const satFeather = sector.feather * 1.5;

  const imgData = new ImageData(SIZE, SIZE);
  const d = imgData.data;

  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const dx = px - cx, dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > INNER_R || dist < 1) continue;

      const pixelHue = ((Math.atan2(dy, dx) * 180 / Math.PI) + 90 + 360) % 360;
      const pixelSat = (dist / PICK_R) * 100;

      let hueDist = Math.abs(pixelHue - sector.hueCenter);
      if (hueDist > 180) hueDist = 360 - hueDist;
      const hueMargin = Math.max(0, hueDist - sector.hueHalfWidth);
      const hueFade = glslSmoothstep(0, hueFeather, hueMargin);

      let satMargin = 0;
      if (pixelSat < sector.satMin) satMargin = sector.satMin - pixelSat;
      else if (pixelSat > sector.satMax) satMargin = pixelSat - sector.satMax;
      const satFade = glslSmoothstep(0, satFeather, satMargin);

      const totalFade = 1 - (1 - hueFade) * (1 - satFade);
      const alpha = (1 - totalFade) * 0.75;
      if (alpha < 0.005) continue;

      const L = 100 - pixelSat * 0.5;
      const [R, G, B] = hslToRgb(pixelHue, ...toDisplaySL(pixelSat, L));
      const idx = (py * SIZE + px) * 4;
      d[idx] = R; d[idx + 1] = G; d[idx + 2] = B; d[idx + 3] = Math.round(alpha * 255);
    }
  }
  return imgData;
}

export function drawWheel(
  ctx: CanvasRenderingContext2D,
  sectors: Sector[],
  selectedIdx: number,
  cachedImageData: ImageData | null,
) {
  const cx = SIZE / 2, cy = SIZE / 2;
  ctx.clearRect(0, 0, SIZE, SIZE);

  // Rainbow ring
  for (let a = 0; a < 360; a++) {
    const r1 = toRad(a), r2 = toRad(a + 1);
    ctx.beginPath();
    ctx.arc(cx, cy, OUTER_R, r1, r2 + 0.02);
    ctx.arc(cx, cy, INNER_R, r2 + 0.02, r1, true);
    ctx.closePath();
    ctx.fillStyle = displayHsl(a);
    ctx.fill();
  }

  // Inner surface: a soft white-to-black falloff from the centre outwards, so
  // the disc reads as a lit surface rather than a flat black hole. Kept as one
  // monotonic ramp — mixing a white and a black stop banded at the crossover.
  ctx.beginPath();
  ctx.arc(cx, cy, INNER_R - 0.5, 0, Math.PI * 2);
  const surface = ctx.createRadialGradient(cx, cy, 0, cx, cy, INNER_R);
  surface.addColorStop(0, '#2e2e2e');
  surface.addColorStop(0.6, '#1c1c1c');
  surface.addColorStop(1, '#0e0e0e');
  ctx.fillStyle = surface;
  ctx.fill();

  // Color fill for selected sector
  if (cachedImageData && selectedIdx >= 0 && selectedIdx < sectors.length) {
    const offscreen = new OffscreenCanvas(SIZE, SIZE);
    offscreen.getContext('2d')!.putImageData(cachedImageData, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, INNER_R - 0.5, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
  }

  // Wireframe + handles
  const sectorPath = (hueC: number, hueHW: number, sMin: number, sMax: number) => {
    const rO = (sMax / 100) * PICK_R;
    const rI = (sMin / 100) * PICK_R;
    const aL = toRad(hueC - hueHW);
    const aR = toRad(hueC + hueHW);
    ctx.beginPath();
    if (rI > 1) {
      ctx.moveTo(cx + Math.cos(aL) * rI, cy + Math.sin(aL) * rI);
      ctx.lineTo(cx + Math.cos(aL) * rO, cy + Math.sin(aL) * rO);
      ctx.arc(cx, cy, rO, aL, aR);
      ctx.lineTo(cx + Math.cos(aR) * rI, cy + Math.sin(aR) * rI);
      ctx.arc(cx, cy, rI, aR, aL, true);
    } else {
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(aL) * rO, cy + Math.sin(aL) * rO);
      ctx.arc(cx, cy, rO, aL, aR);
    }
    ctx.closePath();
  };

  for (let i = 0; i < sectors.length; i++) {
    const s = sectors[i];
    const sel = i === selectedIdx;

    if (!sel) {
      sectorPath(s.hueCenter, s.hueHalfWidth, s.satMin, s.satMax);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 0.4;
      ctx.stroke();
    } else {
      const lw = 1.4;
      const hueL = (s.hueCenter - s.hueHalfWidth + 360) % 360;
      const hueR = (s.hueCenter + s.hueHalfWidth) % 360;
      const rI = (s.satMin / 100) * PICK_R;
      const rO = (s.satMax / 100) * PICK_R;
      const aLL = toRad(hueL);
      const aRR = toRad(hueR);

      const radialGrad = (hue: number, angle: number) => {
        const x0 = cx + Math.cos(angle) * rI, y0 = cy + Math.sin(angle) * rI;
        const x1 = cx + Math.cos(angle) * rO, y1 = cy + Math.sin(angle) * rO;
        const grad = ctx.createLinearGradient(x0, y0, x1, y1);
        const [r2, g2, b2] = hslToRgb(hue, ...toDisplaySL(100, 65));
        grad.addColorStop(0, 'rgba(255,255,255,0.9)');
        grad.addColorStop(1, `rgb(${r2},${g2},${b2})`);
        return grad;
      };

      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(aLL) * rI, cy + Math.sin(aLL) * rI);
      ctx.lineTo(cx + Math.cos(aLL) * rO, cy + Math.sin(aLL) * rO);
      ctx.strokeStyle = radialGrad(hueL, aLL); ctx.lineWidth = lw; ctx.stroke();

      const [oR, oG, oB] = hslToRgb(s.hueCenter, ...toDisplaySL(100, 65));
      ctx.beginPath(); ctx.arc(cx, cy, rO, aLL, aRR);
      ctx.strokeStyle = `rgb(${oR},${oG},${oB})`; ctx.lineWidth = lw; ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(aRR) * rO, cy + Math.sin(aRR) * rO);
      ctx.lineTo(cx + Math.cos(aRR) * rI, cy + Math.sin(aRR) * rI);
      ctx.strokeStyle = radialGrad(hueR, aRR); ctx.lineWidth = lw; ctx.stroke();

      ctx.beginPath(); ctx.arc(cx, cy, rI, aRR, aLL, true);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = lw; ctx.stroke();
    }

    if (sel) {
      const hueL = (s.hueCenter - s.hueHalfWidth + 360) % 360;
      const hueM = s.hueCenter;
      const hueR2 = (s.hueCenter + s.hueHalfWidth) % 360;
      const aL = toRad(hueL), aMid = toRad(hueM), aR = toRad(hueR2);
      for (const [angle, r, hue] of [[aL, 3, hueL], [aMid, 4, hueM], [aR, 3, hueR2]] as [number, number, number][]) {
        const mx = cx + Math.cos(angle) * (OUTER_R + 1);
        const my = cy + Math.sin(angle) * (OUTER_R + 1);
        ctx.beginPath(); ctx.arc(mx, my, r, 0, Math.PI * 2);
        ctx.fillStyle = displayHsl(hue, 100, 60); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 0.8; ctx.stroke();
      }

      const pick = getPickAbs(s);
      const pRad = toRad(pick.hue);
      const pR = (pick.sat / 100) * PICK_R;
      const [pr, pg, pb] = hslToRgb(pick.hue, ...toDisplaySL(Math.max(pick.sat, 50), 60));
      ctx.beginPath();
      ctx.arc(cx + Math.cos(pRad) * pR, cy + Math.sin(pRad) * pR, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${pr},${pg},${pb})`; ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    }
  }

  ctx.beginPath(); ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fill();
}
