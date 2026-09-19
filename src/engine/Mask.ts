export type MaskType = 'brush' | 'linear-gradient' | 'radial-gradient' | 'luminance-range' | 'color-range' | 'ai-segment';

export interface BrushStroke {
  points: { x: number; y: number }[];
  radius: number;
  feather: number;
  flow: number;
  erase: boolean;
}

export interface MaskDefinition {
  id: string;
  name: string;
  type: MaskType;
  visible: boolean;

  // Brush
  strokes?: BrushStroke[];

  // Linear gradient: two points define start (100%) and end (0%)
  gradientStart?: { x: number; y: number };
  gradientEnd?: { x: number; y: number };

  // Radial gradient
  center?: { x: number; y: number };
  radiusX?: number;
  radiusY?: number;
  rotation?: number;
  feather?: number;
  invert?: boolean;

  // Range mask
  rangeMin?: number;
  rangeMax?: number;
  rangeFeather?: number;
  rangeColor?: { r: number; g: number; b: number };

  // AI segment: pixel-level alpha map from AI segmentation
  alphaMap?: Uint8Array;
  alphaMapWidth?: number;
  alphaMapHeight?: number;

  // Range restriction (refines any mask type)
  rangeRestriction?: {
    type: 'luminance' | 'color';
    min: number;
    max: number;
    feather: number;
    color?: { r: number; g: number; b: number };
  };
}

/**
 * One retouch disc: the area at `target` is filled from `source`.
 *
 * Everything is a FRACTION of the image - `x`/`y` of width and height,
 * `radius` of the width - so the same spot lands in the same place on the
 * editor canvas, on a 300px thumbnail and in a full-resolution export. The
 * radius used to be preview pixels (RetouchTool.tsx), which meant nothing
 * anywhere but on the canvas it was clicked on.
 *
 * `mode` says which of the two the disc is: `clone` copies the source
 * straight, `heal` keeps the target's luminance and takes only the source's
 * colour and texture.
 */
export interface SpotRemoval {
  id: string;
  mode: 'heal' | 'clone';
  target: { x: number; y: number; radius: number };
  source: { x: number; y: number };
  /** 0..1 of the radius: how much of the disc is falloff. */
  feather: number;
  opacity: number;
}

/**
 * Render a mask to an alpha canvas.
 * Returns a canvas where white = full effect, black = no effect.
 */
export function renderMaskToCanvas(
  mask: MaskDefinition,
  width: number,
  height: number,
  sourceImageData?: ImageData,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;

  // Start with black (no effect)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  switch (mask.type) {
    case 'brush':
      renderBrushMask(ctx, mask, width, height);
      break;
    case 'linear-gradient':
      renderLinearGradientMask(ctx, mask, width, height);
      break;
    case 'radial-gradient':
      renderRadialGradientMask(ctx, mask, width, height);
      break;
    case 'luminance-range':
      if (sourceImageData) renderLuminanceRangeMask(ctx, mask, width, height, sourceImageData);
      break;
    case 'color-range':
      if (sourceImageData) renderColorRangeMask(ctx, mask, width, height, sourceImageData);
      break;
    case 'ai-segment':
      renderAISegmentMask(ctx, mask, width, height);
      break;
  }

  // Apply range restriction if set
  if (mask.rangeRestriction && sourceImageData) {
    const restriction = mask.rangeRestriction;
    const maskCtx = canvas.getContext('2d')!;
    const maskData = maskCtx.getImageData(0, 0, width, height);
    const md = maskData.data;
    const sd = sourceImageData.data;

    for (let i = 0; i < sd.length; i += 4) {
      let inRange = 0;

      if (restriction.type === 'luminance') {
        const lum = 0.299 * sd[i] + 0.587 * sd[i + 1] + 0.114 * sd[i + 2];
        if (lum >= restriction.min && lum <= restriction.max) {
          inRange = 255;
        } else if (lum < restriction.min && lum >= restriction.min - restriction.feather) {
          inRange = ((lum - (restriction.min - restriction.feather)) / restriction.feather) * 255;
        } else if (lum > restriction.max && lum <= restriction.max + restriction.feather) {
          inRange = ((restriction.max + restriction.feather - lum) / restriction.feather) * 255;
        }
      } else if (restriction.type === 'color' && restriction.color) {
        const dr = sd[i] - restriction.color.r;
        const dg = sd[i + 1] - restriction.color.g;
        const db = sd[i + 2] - restriction.color.b;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist <= restriction.max) {
          inRange = 255;
        } else if (dist <= restriction.max + restriction.feather) {
          inRange = ((restriction.max + restriction.feather - dist) / restriction.feather) * 255;
        }
      }

      // Multiply existing mask with range
      md[i] = Math.round(md[i] * inRange / 255);
      md[i + 1] = md[i];
      md[i + 2] = md[i];
    }

    maskCtx.putImageData(maskData, 0, 0);
  }

  return canvas;
}

function renderBrushMask(ctx: OffscreenCanvasRenderingContext2D, mask: MaskDefinition, w: number, h: number) {
  if (!mask.strokes) return;

  for (const stroke of mask.strokes) {
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
    ctx.globalAlpha = stroke.flow;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stroke.radius * 2;

    // Feathered brush via shadow
    if (stroke.feather > 0) {
      ctx.shadowBlur = stroke.feather * stroke.radius;
      ctx.shadowColor = 'white';
      ctx.strokeStyle = 'transparent';
    } else {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = 'white';
    }

    if (stroke.points.length === 1) {
      // Single dot
      ctx.beginPath();
      ctx.arc(stroke.points[0].x * w, stroke.points[0].y * h, stroke.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'white';
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x * w, stroke.points[0].y * h);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x * w, stroke.points[i].y * h);
      }
      ctx.stroke();
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}

function renderLinearGradientMask(ctx: OffscreenCanvasRenderingContext2D, mask: MaskDefinition, w: number, h: number) {
  if (!mask.gradientStart || !mask.gradientEnd) return;

  const x1 = mask.gradientStart.x * w;
  const y1 = mask.gradientStart.y * h;
  const x2 = mask.gradientEnd.x * w;
  const y2 = mask.gradientEnd.y * h;

  const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
  gradient.addColorStop(0, 'white');
  gradient.addColorStop(1, 'black');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

function renderRadialGradientMask(ctx: OffscreenCanvasRenderingContext2D, mask: MaskDefinition, w: number, h: number) {
  if (!mask.center) return;

  const cx = mask.center.x * w;
  const cy = mask.center.y * h;
  const rx = (mask.radiusX ?? 0.3) * w;
  const ry = (mask.radiusY ?? 0.3) * h;
  const feather = mask.feather ?? 0.5;

  ctx.save();
  ctx.translate(cx, cy);
  if (mask.rotation) ctx.rotate(mask.rotation * Math.PI / 180);
  ctx.scale(1, ry / rx);

  const gradient = ctx.createRadialGradient(0, 0, rx * (1 - feather), 0, 0, rx);

  if (mask.invert) {
    gradient.addColorStop(0, 'black');
    gradient.addColorStop(1, 'white');
  } else {
    gradient.addColorStop(0, 'white');
    gradient.addColorStop(1, 'black');
  }

  ctx.fillStyle = gradient;
  ctx.fillRect(-w, -h, w * 2, h * 2);
  ctx.restore();
}

function renderLuminanceRangeMask(
  ctx: OffscreenCanvasRenderingContext2D, mask: MaskDefinition,
  w: number, h: number, sourceData: ImageData,
) {
  const min = mask.rangeMin ?? 0;
  const max = mask.rangeMax ?? 255;
  const feather = mask.rangeFeather ?? 10;

  const output = ctx.createImageData(w, h);
  const src = sourceData.data;
  const dst = output.data;

  for (let i = 0; i < src.length; i += 4) {
    const lum = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
    let alpha = 0;

    if (lum >= min && lum <= max) {
      alpha = 255;
    } else if (lum < min && lum >= min - feather) {
      alpha = ((lum - (min - feather)) / feather) * 255;
    } else if (lum > max && lum <= max + feather) {
      alpha = ((max + feather - lum) / feather) * 255;
    }

    dst[i] = dst[i + 1] = dst[i + 2] = Math.round(alpha);
    dst[i + 3] = 255;
  }

  ctx.putImageData(output, 0, 0);
}

function renderAISegmentMask(
  ctx: OffscreenCanvasRenderingContext2D, mask: MaskDefinition,
  w: number, h: number,
) {
  if (!mask.alphaMap || !mask.alphaMapWidth || !mask.alphaMapHeight) return;

  const output = ctx.createImageData(w, h);
  const dst = output.data;
  const srcW = mask.alphaMapWidth;
  const srcH = mask.alphaMapHeight;

  // Bilinear scale alphaMap to target dimensions
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x / w) * srcW;
      const sy = (y / h) * srcH;
      const sx0 = Math.min(Math.floor(sx), srcW - 1);
      const sy0 = Math.min(Math.floor(sy), srcH - 1);
      const sx1 = Math.min(sx0 + 1, srcW - 1);
      const sy1 = Math.min(sy0 + 1, srcH - 1);
      const fx = sx - sx0;
      const fy = sy - sy0;

      const v00 = mask.alphaMap[sy0 * srcW + sx0];
      const v10 = mask.alphaMap[sy0 * srcW + sx1];
      const v01 = mask.alphaMap[sy1 * srcW + sx0];
      const v11 = mask.alphaMap[sy1 * srcW + sx1];

      const val = Math.round(
        v00 * (1 - fx) * (1 - fy) +
        v10 * fx * (1 - fy) +
        v01 * (1 - fx) * fy +
        v11 * fx * fy,
      );

      const i = (y * w + x) * 4;
      dst[i] = dst[i + 1] = dst[i + 2] = val;
      dst[i + 3] = 255;
    }
  }

  ctx.putImageData(output, 0, 0);
}

function renderColorRangeMask(
  ctx: OffscreenCanvasRenderingContext2D, mask: MaskDefinition,
  w: number, h: number, sourceData: ImageData,
) {
  if (!mask.rangeColor) return;

  const tr = mask.rangeColor.r;
  const tg = mask.rangeColor.g;
  const tb = mask.rangeColor.b;
  const tolerance = mask.rangeMax ?? 30;
  const feather = mask.rangeFeather ?? 10;

  const output = ctx.createImageData(w, h);
  const src = sourceData.data;
  const dst = output.data;

  for (let i = 0; i < src.length; i += 4) {
    const dr = src[i] - tr;
    const dg = src[i + 1] - tg;
    const db = src[i + 2] - tb;
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    let alpha = 0;
    if (dist <= tolerance) {
      alpha = 255;
    } else if (dist <= tolerance + feather) {
      alpha = ((tolerance + feather - dist) / feather) * 255;
    }

    dst[i] = dst[i + 1] = dst[i + 2] = Math.round(alpha);
    dst[i + 3] = 255;
  }

  ctx.putImageData(output, 0, 0);
}

/**
 * Create a new empty mask.
 * For ai-segment masks, pass alphaMap/width/height via the optional data param.
 */
export function createMask(
  type: MaskType,
  name?: string,
  aiData?: { alphaMap: Uint8Array; width: number; height: number },
): MaskDefinition {
  const id = crypto.randomUUID();
  const base: MaskDefinition = {
    id,
    name: name ?? `Maske ${id.slice(0, 4)}`,
    type,
    visible: true,
  };

  switch (type) {
    case 'brush':
      base.strokes = [];
      break;
    case 'linear-gradient':
      base.gradientStart = { x: 0.5, y: 0 };
      base.gradientEnd = { x: 0.5, y: 1 };
      break;
    case 'radial-gradient':
      base.center = { x: 0.5, y: 0.5 };
      base.radiusX = 0.3;
      base.radiusY = 0.3;
      base.feather = 0.5;
      base.invert = false;
      break;
    case 'luminance-range':
      base.rangeMin = 0;
      base.rangeMax = 128;
      base.rangeFeather = 15;
      break;
    case 'color-range':
      base.rangeColor = { r: 128, g: 128, b: 128 };
      base.rangeMax = 30;
      base.rangeFeather = 15;
      break;
    case 'ai-segment':
      base.alphaMap = aiData?.alphaMap ?? new Uint8Array(0);
      base.alphaMapWidth = aiData?.width ?? 0;
      base.alphaMapHeight = aiData?.height ?? 0;
      break;
  }

  return base;
}
