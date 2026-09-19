import type { NodeKindSpec } from './types';
import type { NodeRegistry } from './NodeRegistry';

/**
 * Source-node kinds. Each declares how to upload its external data into a
 * texture; the executor's runSource() calls uploadSource() with whatever
 * the caller bound via PipelineExecutor.bindExternalData(nodeId, data).
 *
 * Two source kinds for the foreseeable future:
 *   - imageBitmapSource: JPEG / HEIF / PNG decoded via createImageBitmap.
 *     Output is gamma-encoded sRGB in an RGBA8 texture.
 *   - raw16Source: 16-bit-per-channel linear pixel data straight from libraw
 *     (Smart-Preview path). Output is linear in an RGBA16F texture.
 *
 * Phase-0 ships imageBitmapSource. raw16Source lands in Phase 1 when the
 * existing RAW-decode pipeline gets ported.
 */

export const KIND_IMAGE_BITMAP_SOURCE = '__source.imageBitmap';

interface ImageBitmapSourceParams {
  /** Source dimensions. Caller sets these from the bitmap before compile so
   *  the geometry-propagation pass has something concrete to work with. */
  width: number;
  height: number;
  pixelRatio?: number;
}

const imageBitmapSource: NodeKindSpec<ImageBitmapSourceParams> = {
  kind: KIND_IMAGE_BITMAP_SOURCE,
  category: 'source',
  inputPorts: [],
  outputPorts: [{ id: 'out', type: 'color', space: 'gamma' }],
  paramSchema: {
    type: 'object',
    properties: {
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
      pixelRatio: { type: 'number', minimum: 1, default: 1 },
    },
    required: ['width', 'height'],
  },
  inputSpace: 'gamma',
  outputSpace: 'gamma',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: () => false,
  isAsync: false,
  outputGeometry: (_geoms, params) => ({
    width: params.width,
    height: params.height,
    pixelRatio: params.pixelRatio ?? 1,
  }),
  uploadSource: (gl, texture, _params, externalData) => {
    if (!(externalData instanceof ImageBitmap)) {
      throw new Error('imageBitmapSource: bound external data must be an ImageBitmap');
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      externalData.width, externalData.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, externalData,
    );
  },
};

// ─── raw16Source: linear 16-bit RGB pixels straight from libraw ────

export const KIND_RAW16_SOURCE = '__source.raw16';

interface Raw16SourceParams {
  width: number;
  height: number;
  pixelRatio?: number;
  /** 3 = RGB, 4 = RGBA. RGB gets alpha=1 padded during upload. */
  channels: 3 | 4;
}

/**
 * External data shape callers bind via `executor.bindExternalData(srcId, ...)`:
 * just the pixel buffer + its dimensions. Calibration (AsShotNeutral, color
 * matrix) is *not* part of the source — it belongs on the downstream
 * WhiteBalanceRaw + ColorMatrix nodes as their own params, set by the
 * default-graph builder at compile time.
 */
export interface Raw16SourceData {
  pixels: Uint16Array;
  width: number;
  height: number;
  channels: 3 | 4;
}

const raw16Source: NodeKindSpec<Raw16SourceParams> = {
  kind: KIND_RAW16_SOURCE,
  category: 'source',
  inputPorts: [],
  outputPorts: [{ id: 'out', type: 'color', space: 'linear' }],
  paramSchema: {
    type: 'object',
    properties: {
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
      pixelRatio: { type: 'number', minimum: 1, default: 1 },
      channels: { type: 'integer', minimum: 3, maximum: 4, default: 3 },
    },
    required: ['width', 'height', 'channels'],
  },
  inputSpace: 'linear',
  outputSpace: 'linear',
  requiresFloat: true,
  samplesNeighbors: false,
  isIdentity: () => false,
  isAsync: false,
  outputGeometry: (_geoms, params) => ({
    width: params.width,
    height: params.height,
    pixelRatio: params.pixelRatio ?? 1,
  }),
  uploadSource: (gl, texture, _params, externalData) => {
    const data = externalData as Raw16SourceData | undefined;
    if (!data || !(data.pixels instanceof Uint16Array)) {
      throw new Error('raw16Source: bound external data must be a Raw16SourceData');
    }
    const { pixels, width, height, channels } = data;
    // Normalise Uint16 → Float32 [0,1] + pack to RGBA (alpha=1 for RGB sources).
    const pixelCount = width * height;
    const rgba = new Float32Array(pixelCount * 4);
    if (channels === 3) {
      for (let p = 0; p < pixelCount; p++) {
        const si = p * 3, di = p * 4;
        rgba[di]     = pixels[si]     / 65535;
        rgba[di + 1] = pixels[si + 1] / 65535;
        rgba[di + 2] = pixels[si + 2] / 65535;
        rgba[di + 3] = 1;
      }
    } else {
      for (let p = 0; p < pixelCount; p++) {
        const si = p * 4, di = p * 4;
        rgba[di]     = pixels[si]     / 65535;
        rgba[di + 1] = pixels[si + 1] / 65535;
        rgba[di + 2] = pixels[si + 2] / 65535;
        rgba[di + 3] = pixels[si + 3] / 65535;
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.FLOAT, rgba);
  },
};

// ─── rasterizedMaskSource: pre-rendered mask (Brush, Gradient, AI-Sky) ────
//
// Mask types that are easier to rasterize on the CPU (Brush stroke playback,
// gradient fills, AI segmentation alpha maps) live as ImageBitmaps on the
// main thread and get uploaded here as an RGBA8 texture. The Compositor's
// `mask` port reads from `.r` so a luminance-encoded alpha (all-channels-
// equal greyscale) works directly.

export const KIND_RASTERIZED_MASK_SOURCE = '__source.rasterizedMask';

interface RasterizedMaskSourceParams {
  width: number;
  height: number;
  pixelRatio?: number;
}

const rasterizedMaskSource: NodeKindSpec<RasterizedMaskSourceParams> = {
  kind: KIND_RASTERIZED_MASK_SOURCE,
  category: 'source',
  inputPorts: [],
  outputPorts: [{ id: 'out', type: 'mask', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: {
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
      pixelRatio: { type: 'number', minimum: 1, default: 1 },
    },
    required: ['width', 'height'],
  },
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: () => false,
  isAsync: false,
  outputGeometry: (_geoms, params) => ({
    width: params.width,
    height: params.height,
    pixelRatio: params.pixelRatio ?? 1,
  }),
  uploadSource: (gl, texture, _params, externalData) => {
    if (!(externalData instanceof ImageBitmap)) {
      throw new Error('rasterizedMaskSource: bound external data must be an ImageBitmap');
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA8,
      externalData.width, externalData.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, externalData,
    );
  },
};

/** Convenience: register every built-in source kind. */
export function registerBuiltinSources(registry: NodeRegistry): void {
  registry.replace(imageBitmapSource as NodeKindSpec);
  registry.replace(raw16Source as NodeKindSpec);
  registry.replace(rasterizedMaskSource as NodeKindSpec);
}
