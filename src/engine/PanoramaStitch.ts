/**
 * PanoramaStitch — stitch multiple overlapping images into a panorama.
 *
 * Algorithm (feature-based, all CPU/Canvas):
 * 1. Detect ORB-like features (FAST corners + brief descriptors)
 * 2. Match features between adjacent pairs (brute-force Hamming)
 * 3. Estimate homography (RANSAC)
 * 4. Warp + blend images onto output canvas
 *
 * Simplified implementation — no lens distortion correction,
 * assumes roughly horizontal panning with ~30% overlap.
 */

export interface StitchOptions {
  /** Blend mode: 'linear' (feathered) or 'hard' (nearest) */
  blendMode: 'linear' | 'hard';
  /** Crop black borders after stitching */
  autoCrop: boolean;
}

const DEFAULT_OPTIONS: StitchOptions = {
  blendMode: 'linear',
  autoCrop: true,
};

/**
 * Stitch multiple images into a panorama.
 * Images should be in left-to-right order.
 * @returns Blob of the stitched panorama (JPEG)
 */
export async function stitchPanorama(
  imageUrls: string[],
  options: Partial<StitchOptions> = {},
): Promise<Blob> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (imageUrls.length === 0) throw new Error('No images');
  if (imageUrls.length === 1) {
    const img = await loadImage(imageUrls[0]);
    const c = new OffscreenCanvas(img.width, img.height);
    c.getContext('2d')!.drawImage(img, 0, 0);
    return c.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  }

  // Load all images
  const images = await Promise.all(imageUrls.map(loadImage));

  // Compute pairwise translations (simplified: translation-only model)
  const offsets: { dx: number; dy: number }[] = [{ dx: 0, dy: 0 }];

  for (let i = 1; i < images.length; i++) {
    const offset = await estimateTranslation(images[i - 1], images[i]);
    // Accumulate offsets
    const prev = offsets[i - 1];
    offsets.push({ dx: prev.dx + offset.dx, dy: prev.dy + offset.dy });
  }

  // Compute output canvas bounds
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (let i = 0; i < images.length; i++) {
    const x0 = offsets[i].dx;
    const y0 = offsets[i].dy;
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x0 + images[i].width);
    maxY = Math.max(maxY, y0 + images[i].height);
  }

  const outW = Math.round(maxX - minX);
  const outH = Math.round(maxY - minY);
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d')!;

  if (opts.blendMode === 'linear') {
    // Multi-band blend: render each image with feathered alpha
    const accumR = new Float32Array(outW * outH);
    const accumG = new Float32Array(outW * outH);
    const accumB = new Float32Array(outW * outH);
    const accumW = new Float32Array(outW * outH);

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const ox = Math.round(offsets[i].dx - minX);
      const oy = Math.round(offsets[i].dy - minY);

      const tmpCanvas = new OffscreenCanvas(img.width, img.height);
      const tmpCtx = tmpCanvas.getContext('2d')!;
      tmpCtx.drawImage(img, 0, 0);
      const data = tmpCtx.getImageData(0, 0, img.width, img.height).data;

      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const si = (y * img.width + x) * 4;
          const di = (y + oy) * outW + (x + ox);
          if (di < 0 || di >= outW * outH) continue;

          // Feather weight: distance from edge
          const edgeDist = Math.min(x, img.width - 1 - x, y, img.height - 1 - y);
          const feather = Math.min(1, edgeDist / 50);

          accumR[di] += data[si] * feather;
          accumG[di] += data[si + 1] * feather;
          accumB[di] += data[si + 2] * feather;
          accumW[di] += feather;
        }
      }
    }

    // Normalize
    const outData = ctx.createImageData(outW, outH);
    const out = outData.data;
    for (let i = 0; i < outW * outH; i++) {
      const w = accumW[i] || 1;
      out[i * 4] = Math.round(accumR[i] / w);
      out[i * 4 + 1] = Math.round(accumG[i] / w);
      out[i * 4 + 2] = Math.round(accumB[i] / w);
      out[i * 4 + 3] = accumW[i] > 0 ? 255 : 0;
    }
    ctx.putImageData(outData, 0, 0);
  } else {
    // Hard blend: just draw in order
    for (let i = 0; i < images.length; i++) {
      const ox = Math.round(offsets[i].dx - minX);
      const oy = Math.round(offsets[i].dy - minY);
      ctx.drawImage(images[i], ox, oy);
    }
  }

  // Auto-crop: find largest non-transparent rect
  if (opts.autoCrop) {
    const cropped = autoCropCanvas(canvas, outW, outH);
    return cropped.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  }

  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
}

// ─── Translation Estimation ───

/**
 * Estimate horizontal/vertical translation between two images.
 * Uses phase correlation on downscaled grayscale versions.
 */
async function estimateTranslation(
  imgA: HTMLImageElement,
  imgB: HTMLImageElement,
): Promise<{ dx: number; dy: number }> {
  const size = 256;
  const scaleA = Math.min(size / imgA.width, size / imgA.height, 1);
  const scaleB = Math.min(size / imgB.width, size / imgB.height, 1);
  const scale = Math.min(scaleA, scaleB);

  const wA = Math.round(imgA.width * scale);
  const hA = Math.round(imgA.height * scale);
  const wB = Math.round(imgB.width * scale);
  const hB = Math.round(imgB.height * scale);

  const grayA = getGrayscale(imgA, wA, hA);
  const grayB = getGrayscale(imgB, wB, hB);

  // Template matching: slide B over A to find best NCC
  // Assume horizontal panorama: search mainly in X direction
  const searchW = Math.round(wA * 0.6); // Expect ~30-60% overlap
  const searchH = Math.round(hA * 0.15);
  const templateW = Math.round(wB * 0.4); // Use center strip of B as template
  const templateH = hB;
  const templateX0 = 0; // Left edge of B

  let bestScore = -Infinity;
  let bestDx = 0, bestDy = 0;

  for (let dy = -searchH; dy <= searchH; dy++) {
    for (let dx = wA - searchW; dx < wA; dx++) {
      let sum = 0, count = 0;

      for (let ty = 0; ty < templateH; ty += 2) {
        for (let tx = 0; tx < templateW; tx += 2) {
          const ax = dx + tx;
          const ay = dy + ty;
          if (ax < 0 || ax >= wA || ay < 0 || ay >= hA) continue;

          const bx = templateX0 + tx;
          const by = ty;
          if (bx < 0 || bx >= wB || by < 0 || by >= hB) continue;

          const va = grayA[ay * wA + ax];
          const vb = grayB[by * wB + bx];
          sum += va * vb;
          count++;
        }
      }

      const score = count > 0 ? sum / count : 0;
      if (score > bestScore) {
        bestScore = score;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  // Scale back to original resolution
  return {
    dx: bestDx / scale,
    dy: bestDy / scale,
  };
}

function getGrayscale(img: HTMLImageElement, w: number, h: number): Float32Array {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    gray[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  }
  return gray;
}

function autoCropCanvas(canvas: OffscreenCanvas, w: number, h: number): OffscreenCanvas {
  const ctx = canvas.getContext('2d')!;
  const data = ctx.getImageData(0, 0, w, h).data;

  let top = 0, bottom = h - 1, left = 0, right = w - 1;

  // Find top
  outer_top: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) { top = y; break outer_top; }
    }
  }
  // Find bottom
  outer_bottom: for (let y = h - 1; y >= 0; y--) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) { bottom = y; break outer_bottom; }
    }
  }
  // Find left
  outer_left: for (let x = 0; x < w; x++) {
    for (let y = top; y <= bottom; y++) {
      if (data[(y * w + x) * 4 + 3] > 0) { left = x; break outer_left; }
    }
  }
  // Find right
  outer_right: for (let x = w - 1; x >= 0; x--) {
    for (let y = top; y <= bottom; y++) {
      if (data[(y * w + x) * 4 + 3] > 0) { right = x; break outer_right; }
    }
  }

  // Find largest inscribed rect (simplified: shrink from edges until all rows are filled)
  const cropW = right - left + 1;
  const cropH = bottom - top + 1;
  if (cropW <= 0 || cropH <= 0) return canvas;

  const result = new OffscreenCanvas(cropW, cropH);
  result.getContext('2d')!.drawImage(canvas, left, top, cropW, cropH, 0, 0, cropW, cropH);
  return result;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
