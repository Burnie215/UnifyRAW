/** A crop in normalized coordinates of the rendered, pre-crop image. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_CROP_RECT: Readonly<CropRect> = Object.freeze({
  x: 0,
  y: 0,
  width: 1,
  height: 1,
});

const MIN_CROP_SIZE = 0.001;

/**
 * Keep persisted or graph-authored crop data finite and inside the image.
 * Legacy documents have no crop at all; that spelling means the full frame.
 */
export function normalizeCropRect(crop?: Partial<CropRect> | null): CropRect {
  const x = clamp(finite(crop?.x, 0), 0, 1 - MIN_CROP_SIZE);
  const y = clamp(finite(crop?.y, 0), 0, 1 - MIN_CROP_SIZE);
  const width = clamp(finite(crop?.width, 1), MIN_CROP_SIZE, 1 - x);
  const height = clamp(finite(crop?.height, 1), MIN_CROP_SIZE, 1 - y);
  return { x, y, width, height };
}

export function isFullCropRect(crop?: Partial<CropRect> | null): boolean {
  const normalized = normalizeCropRect(crop);
  return normalized.x === 0 && normalized.y === 0
    && normalized.width === 1 && normalized.height === 1;
}

/** Canonical persisted spelling: omit the identity crop. */
export function persistedCropRect(crop?: Partial<CropRect> | null): CropRect | undefined {
  const normalized = normalizeCropRect(crop);
  return isFullCropRect(normalized) ? undefined : normalized;
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
