/**
 * Match a canvas bitmap to the pixel density it is actually displayed at.
 *
 * A canvas draws into a fixed bitmap that the browser then scales into its CSS
 * box. On a 2x display — or whenever CSS stretches the element, as with
 * `width: 100%` — that scaling softens every edge. Sizing the bitmap to the
 * real box times the device ratio removes both, while the returned context
 * still takes coordinates in the logical space the drawing code was written
 * against, so callers need no changes beyond using this to get their context.
 */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  logicalWidth: number,
  logicalHeight: number,
): CanvasRenderingContext2D {
  // Past 3x there is nothing left to see, and the bitmap costs 9x the memory.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round((rect.width || logicalWidth) * dpr));
  const height = Math.max(1, Math.round((rect.height || logicalHeight) * dpr));

  // Assigning either dimension clears the bitmap, so only touch on a change.
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(width / logicalWidth, 0, 0, height / logicalHeight, 0, 0);
  return ctx;
}
