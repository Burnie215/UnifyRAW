/**
 * The neutral RAW render, in software — what the editor shows before any
 * slider is touched.
 *
 * The auto modes need to analyse the image the sliders will actually act on.
 * For a RAW that is *not* `displayUrl`: `SmartPreviewStrategy` builds its
 * preview JPEG straight from the linear 16-bit buffer, skipping the
 * WhiteBalanceRaw node that the render graph runs first. As-shot gains are
 * typically around [2.1, 1.0, 1.5], so the preview comes out roughly half a
 * stop dark and colour-cast against the render.
 *
 * Measured on eight photographs, preview against neutral raw16 render:
 * median +12.4, p01..p99 range +18.6, gray-world warmth +0.13. Feeding the
 * preview to the reference match made it land 14.8 code values too bright with
 * 3.4% of the frame newly blown; analysing this function's output instead, the
 * same match returns all six tone sliders at exactly zero.
 *
 * This mirrors the head of the raw16 chain in `DefaultGraphBuilder`:
 *   raw16 (linear) → WhiteBalanceRaw → ColorMatrix → … → OutputColorSpace
 * with every adjustment node at identity, which is what the neutral render is.
 */
import type { RawPixelData } from './RawDecoderStrategy';
import { rawWhiteBalanceGains } from './whiteBalance';

/** Linear → sRGB, the transfer function the OutputColorSpace node applies. */
function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** 4096-entry encode table — the per-pixel `Math.pow` is the whole cost here. */
const SRGB_ENCODE = (() => {
  const table = new Uint8ClampedArray(4097);
  for (let i = 0; i <= 4096; i++) table[i] = Math.round(linearToSrgb(i / 4096) * 255);
  return table;
})();

const encode = (v: number) => SRGB_ENCODE[v <= 0 ? 0 : v >= 1 ? 4096 : Math.round(v * 4096)];

/**
 * Render `raw` to RGBA8 with every adjustment neutral, optionally downsampling
 * so the caller gets analysis-sized pixels without a second resize pass.
 *
 * Returns null for anything but 16-bit data — the 8-bit fallback preview has
 * already been through the same encode, so `displayUrl` is the right input
 * there and there is nothing to reconstruct.
 */
export function neutralRawRender(
  raw: RawPixelData,
  maxDim = 0,
): { pixels: Uint8ClampedArray; width: number; height: number } | null {
  if (raw.bits !== 16 || !(raw.data instanceof Uint16Array)) return null;

  const gains = rawWhiteBalanceGains(raw.asShotNeutral, 0, 0);
  const matrix = raw.colorMatrix && raw.colorMatrix.length >= 9 ? raw.colorMatrix : null;
  const src = raw.data;
  const channels = raw.channels;

  // Nearest-neighbour stride. The statistics this feeds are histogram
  // percentiles and channel means, which a box filter would not measurably
  // improve, and the button already samples at 400px for the same reason.
  const step = maxDim > 0 ? Math.max(1, Math.ceil(Math.max(raw.width, raw.height) / maxDim)) : 1;
  const width = Math.ceil(raw.width / step);
  const height = Math.ceil(raw.height / step);
  const out = new Uint8ClampedArray(width * height * 4);

  let di = 0;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(raw.height - 1, y * step);
    for (let x = 0; x < width; x++) {
      const sx = Math.min(raw.width - 1, x * step);
      const si = (sy * raw.width + sx) * channels;

      let r = (src[si] / 65535) * gains[0];
      let g = (src[si + 1] / 65535) * gains[1];
      let b = (src[si + 2] / 65535) * gains[2];

      if (matrix) {
        const mr = matrix[0] * r + matrix[1] * g + matrix[2] * b;
        const mg = matrix[3] * r + matrix[4] * g + matrix[5] * b;
        const mb = matrix[6] * r + matrix[7] * g + matrix[8] * b;
        r = mr; g = mg; b = mb;
      }

      out[di] = encode(r);
      out[di + 1] = encode(g);
      out[di + 2] = encode(b);
      out[di + 3] = 255;
      di += 4;
    }
  }
  return { pixels: out, width, height };
}
