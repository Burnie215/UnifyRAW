import type { Adjustments } from '../types';
import { bindDocumentMasks, extraSourcesOf, unbindDocumentMasks } from './documentMasks';
import type { PhotoDocument } from './DocumentModel';
import { iccProfileFor, OUTPUT_COLOR_SPACES, type OutputColorSpaceId } from './outputColorSpaces';
import { encodeTiff, type TiffCompression, type TiffEncodeWarning } from './TiffEncoder';
import { colorMatrix1For, encodeDng, type DngEncodeWarning } from './DngEncoder';
import { linearHalfSamples } from './dngSamples';
import { encodePng16 } from './PngEncoder';
import { embedExifInJpeg, embedIccInJpeg, embedXmpInJpeg } from './JpegSegments';
import { embedExifInPng, embedIccInPng, embedXmpInPng } from './PngChunks';
import { embedIccInWebp } from './WebpChunks';
import { metadataFor, type ExportMetadata } from './exportMetadata';
import type { RawPixelData } from './raw/RawDecoderStrategy';
import {
  getDefaultPipelineService,
  buildAdjustmentsGraph,
  cropFromGraph,
  type BuilderAdjustments,
} from './graph';
import type { LensCoefficients } from './lensProfile';
import {
  buildDocumentGraph,
  KIND_RETOUCH,
  type BuilderSourceSpec,
  type DocumentGraph,
  type Raw16SourceData,
} from './graph';

export interface ExportOptions {
  /**
   * `dng` is 16-bit only and carries no ICC profile - a linear DNG says which
   * space it is in through `ColorMatrix1`, not through a profile.
   */
  format: 'jpeg' | 'png' | 'webp' | 'tiff' | 'dng';
  quality: number;
  maxWidth?: number;
  maxHeight?: number;
  includeMetadata: boolean;
  watermark?: string;
  fileNameTemplate?: string;
  useWebGL?: boolean;
  /** Opt-in high-depth path. The established default remains RGBA8. */
  bitDepth?: 8 | 16;
  /**
   * TIFF and DNG. Defaults to Adobe Deflate; ignored by every other format.
   * The two share the switch because they share the container: DNG is a TIFF,
   * and `DngCompression` is the same pair of choices.
   */
  tiffCompression?: TiffCompression;
  /** Reports an honest, recoverable export degradation to the caller. */
  onWarning?: (warning: ExportWarning) => void;
  /** Include document retouch nodes. Disabled by the dialog for 16-bit. */
  includeRetouch?: boolean;
  /**
   * The space the graph renders in and whose ICC profile the file carries.
   * Default: 'srgb'. Only spaces `iccProfileFor` has a profile for may be
   * offered - an untagged wide-gamut file is read back as sRGB.
   */
  colorSpace?: OutputColorSpaceId;
  /**
   * Where this file came from: capture time and writer as EXIF, the link to
   * the original and to the edit stack as XMP. `includeMetadata: false` drops
   * the EXIF half and keeps the link.
   */
  metadata?: ExportMetadata;
  /**
   * Take ownership of `fullResRaw.data` instead of copying it. Set by callers
   * that do not read the buffer again: at 61 MP the copy is a second 361 MB
   * held at the same moment as the original.
   */
  transferRaw?: boolean;
}

export const defaultExportOptions: ExportOptions = {
  format: 'jpeg',
  quality: 92,
  includeMetadata: true,
  useWebGL: true,
  bitDepth: 8,
  tiffCompression: 'deflate',
  includeRetouch: true,
};

/**
 * A 16-bit export that had to be written at 8 bit because the source could
 * not deliver 16-bit pixels. Separate from the encoder warnings because it
 * happens before the encoder runs - the depth is already decided when the
 * render input is collected.
 */
export interface SourceDepthWarning {
  code: 'source-16bit-unavailable';
  requestedBitDepth: 16;
  actualBitDepth: 8;
  message: string;
}

export type ExportWarning = TiffEncodeWarning | DngEncodeWarning | SourceDepthWarning;

/** Render output in image order. The optional bitDepth on the RGBA8 member
 * keeps existing print/preview fixtures source-compatible. */
export interface RenderedFrame8 {
  width: number;
  height: number;
  pixels: Uint8Array;
  bitDepth?: 8;
  /** The space the pixels are ENCODED in, which is what gets tagged. */
  colorSpace: OutputColorSpaceId;
}

export interface RenderedFrame16 {
  width: number;
  height: number;
  pixels: Uint16Array;
  bitDepth: 16;
  colorSpace: OutputColorSpaceId;
}

export type RenderedFrame = RenderedFrame8 | RenderedFrame16;

export interface RenderPhotoInput {
  imageUrl: string;
  adjustments: Adjustments;
  document?: PhotoDocument | null;
  /**
   * The photo's camera base development, or null. Only the RAW path uses it -
   * and it has to, or an exported RAW comes out rendered differently from the
   * screen it was judged on.
   */
  baseAdjustments?: BuilderAdjustments | null;
  /** The lens correction for this frame, or null. */
  lensProfile?: LensCoefficients | null;
  fullResRaw?: RawPixelData | null;
  maxWidth?: number;
  maxHeight?: number;
  colorSpace: OutputColorSpaceId;
  bitDepth?: 8 | 16;
  includeRetouch?: boolean;
  /** Hand `fullResRaw.data` to the worker instead of copying it first. */
  transferRaw?: boolean;
}

export interface EncodeOptions {
  format: ExportOptions['format'];
  quality: number;
  watermark?: string;
  maxWidth?: number;
  maxHeight?: number;
  tiffCompression?: TiffCompression;
  onWarning?: (warning: ExportWarning) => void;
  /** Already filtered by `includeMetadata`; see `metadataFor`. */
  metadata?: ExportMetadata;
}

/**
 * What to render, for one export. With a document this is the layered graph
 * the canvas uses — including preset layers, which used to fall out of the
 * export entirely because it built its own single chain from the flattened
 * adjustments. Without one (legacy callers) it stays exactly that chain.
 */
function exportGraph(
  document: PhotoDocument | null | undefined,
  adjustments: Adjustments,
  source: BuilderSourceSpec,
  includeRetouch: boolean,
): DocumentGraph {
  const built = document
    ? buildDocumentGraph(document, source)
    : buildAdjustmentsGraph(adjustments, source);
  return includeRetouch ? built : withoutRetouchNodes(built);
}

/** Bypass every retouch node, including ones persisted in a graph-led edit. */
function withoutRetouchNodes(documentGraph: DocumentGraph): DocumentGraph {
  const graph = documentGraph.graph;
  const nodes = new Map(graph.nodes);
  let edges = [...graph.edges];
  let output = graph.output;
  for (const [nodeId, node] of graph.nodes) {
    if (node.kind !== KIND_RETOUCH) continue;
    const incoming = edges.find((edge) => edge.to.node === nodeId && edge.to.port === 'in');
    if (!incoming) continue;
    const outgoing = edges.filter((edge) => edge.from.node === nodeId);
    edges = edges.filter((edge) => edge.from.node !== nodeId && edge.to.node !== nodeId);
    for (const edge of outgoing) {
      edges.push({
        ...edge,
        id: `${edge.id}__withoutRetouch`,
        from: incoming.from,
      });
    }
    if (output === nodeId) output = incoming.from.node;
    nodes.delete(nodeId);
  }
  return {
    ...documentGraph,
    graph: {
      ...graph,
      id: `${graph.id}#without-retouch`,
      nodes,
      edges,
      output,
    },
  };
}

/**
 * The one render stage: the document's graph, fed from whichever source this
 * photo has, rendered in the space the caller asked for.
 *
 * There used to be two of these, and they disagreed about everything that is
 * not the graph itself — the RAW one took the output space from the settings
 * and returned its blob before watermark, ICC and TIFF ever ran; the bitmap
 * one stated no output space at all and therefore always rendered sRGB
 * (F008, F030). Now both end here, and everything after the pixels exist is
 * `encodeFrame`'s job.
 */
export async function renderPhoto(input: RenderPhotoInput): Promise<RenderedFrame> {
  // Full-resolution RAW — bypass <img>/createImageBitmap and feed the 16-bit
  // linear pixel buffer straight into the pipeline. Keeps highlight headroom
  // and applies the raw WB/color-matrix passes the editor uses.
  const raw = input.fullResRaw;
  if (input.bitDepth === 16) {
    if (!raw || raw.bits !== 16 || !(raw.data instanceof Uint16Array)) {
      throw new Error('Exporter: 16-bit export requires actual 16-bit source pixels');
    }
    // A failed high-depth render must not be relabelled as 16 bit after
    // falling back to the 8-bit display preview.
    return renderFromRaw16(raw, input);
  }
  if (raw && raw.bits === 16) {
    try {
      return await renderFromRaw16(raw, input);
    } catch (e) {
      console.warn('[renderPhoto] HDR raw render failed, falling back to the preview path:', e);
    }
  }
  return renderFromBitmap(input);
}

function documentContainsRetouch(document: PhotoDocument | null | undefined): boolean {
  if (!document) return false;
  if ((document.retouch?.length ?? 0) > 0) return true;
  return document.pipelineMode === 'graph' &&
    (document.pipelineGraph?.nodes.some((node) => node.kind === KIND_RETOUCH) ?? false);
}

/**
 * The one encode stage: downscale, watermark, ICC, container.
 *
 * Everything here used to sit behind the RAW path's `return`, which is why a
 * RAW exported as TIFF came out as JPEG bytes under a .tif name and carried
 * neither watermark nor profile (F008).
 */
export async function encodeFrame(frame: RenderedFrame, options: EncodeOptions): Promise<Blob> {
  const { width, height } = fitWithin(frame.width, frame.height, options.maxWidth, options.maxHeight);
  if (frame.bitDepth !== 16 && options.format === 'dng') {
    throw new Error('Exporter: DNG is a 16-bit format and has no 8-bit encoding');
  }
  if (frame.bitDepth === 16) {
    if (options.format !== 'tiff' && options.format !== 'png' && options.format !== 'dng') {
      throw new Error('Exporter: 16-bit encoding supports TIFF, PNG and DNG only');
    }
    if (options.watermark) {
      throw new Error('Exporter: watermarks are unavailable for 16-bit export');
    }
    const resized = width === frame.width && height === frame.height
      ? frame
      : resampleFrame16(frame, width, height);
    if (options.format === 'dng') return encodeDngFrame(resized, options);
    const icc = iccProfileFor(frame.colorSpace) ?? undefined;
    if (options.format === 'png') {
      const png = await encodePng16(resized.pixels, {
        width: resized.width,
        height: resized.height,
        channels: 4,
      }, icc ? { data: icc, name: OUTPUT_COLOR_SPACES[frame.colorSpace].displayName } : undefined);
      return embedPngMetadata(png, options.metadata);
    }
    return encodeTiff(resized.pixels, {
      width: resized.width,
      height: resized.height,
      bits: 16,
      compression: options.tiffCompression ?? 'deflate',
      onWarning: options.onWarning,
      metadata: options.metadata,
    }, icc);
  }

  const full = frameToCanvas(frame);

  // Downscale only, and after the render: a max size is a limit on the file,
  // not a different picture.
  let canvas = full;
  if (width !== frame.width || height !== frame.height) {
    canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.drawImage(full, 0, 0, width, height);
  }
  const ctx = canvas.getContext('2d')!;

  if (options.watermark) {
    ctx.font = `${Math.max(12, height * 0.02)}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(options.watermark, width - 20, height - 15);
  }

  // The graph already rendered IN this space (the outputColorSpace node), so
  // there is nothing left to convert — only to declare.
  const icc = iccProfileFor(frame.colorSpace);

  if (options.format === 'tiff') {
    return encodeTiff(ctx.getImageData(0, 0, width, height).data, {
      width,
      height,
      bits: 8,
      compression: options.tiffCompression ?? 'deflate',
      onWarning: options.onWarning,
      metadata: options.metadata,
    }, icc ?? undefined);
  }

  let blob = await canvas.convertToBlob({
    type: MIME_BY_FORMAT[options.format],
    quality: options.format === 'png' ? undefined : options.quality / 100,
  });

  if (icc) {
    if (options.format === 'jpeg') blob = await embedIccInJpeg(blob, icc);
    else if (options.format === 'png') {
      blob = await embedIccInPng(blob, icc, OUTPUT_COLOR_SPACES[frame.colorSpace].displayName);
    } else if (options.format === 'webp') blob = await embedIccInWebp(blob, icc);
  }

  // WebP is left out on purpose: its metadata chunks are a separate container
  // problem, and the two formats that leave UnifyRAW as an archive copy are
  // the ones that have to carry the link.
  if (options.metadata) {
    if (options.format === 'jpeg') {
      // Each writer inserts at the front, so the finished file reads
      // EXIF APP1, XMP APP1, ICC APP2 - the order readers expect.
      if (options.metadata.xmp) blob = await embedXmpInJpeg(blob, options.metadata.xmp);
      blob = await embedExifInJpeg(blob, options.metadata);
    } else if (options.format === 'png') {
      blob = await embedPngMetadata(blob, options.metadata);
    }
  }
  return blob;
}

/**
 * `UniqueCameraModel` for the virtual camera a linear DNG describes. It names
 * the OUTPUT SPACE because that space is the camera's native one: the file's
 * `ColorMatrix1` is derived from it, so a converter that caches one profile
 * per camera model would otherwise mix an sRGB and an Adobe RGB file under a
 * single identity.
 *
 * Deliberately not `getBrand().name`. This is a format identifier like
 * `.photolib` and `@photolib/*`, not a label on screen: a white-label rename
 * must not silently give the same pipeline a second camera identity, and the
 * engine stays free of the React brand store.
 */
function dngCameraModel(colorSpace: OutputColorSpaceId): string {
  return `UnifyRAW Linear ${OUTPUT_COLOR_SPACES[colorSpace].displayName}`;
}

/**
 * The 16-bit frame as a linear DNG.
 *
 * The range is the honest limit of this route: the `outputColorSpace` node
 * clamps at 1.0 before the readback, so what lands in the file is linear but
 * display-range, not scene-linear with highlight headroom. A DNG with headroom
 * would need a terminal that skips the transfer curve altogether - a change to
 * the shared render path, not to this function. What the file does deliver is
 * the thing the format was picked for: linear numbers plus a matrix, so a RAW
 * converter opens it with its develop controls instead of a flat picture.
 *
 * Two conversions happen here, and each is the difference between a correct
 * file and a plausible-looking wrong one:
 *
 *  - the samples go through `linearHalfSamples`, because the frame holds
 *    display-referred unorm16 while the file declares `LinearRaw`, and those
 *    are not the same numbers;
 *  - `ColorMatrix1` comes from `colorMatrix1For(frame.colorSpace)` and never
 *    from the RAW's own `colorMatrix`. The render applied that one already;
 *    writing it into the file makes the reader apply it a second time.
 *
 * No ICC profile is attached: a DNG has no slot for one and needs none, since
 * `ColorMatrix1` already states which primaries the numbers are in. EXIF has
 * no slot here either - `Software` rides along as a TIFF tag, the capture date
 * does not.
 */
function encodeDngFrame(frame: RenderedFrame16, options: EncodeOptions): Promise<Blob> {
  return encodeDng(linearHalfSamples(frame.pixels, frame.colorSpace), {
    width: frame.width,
    height: frame.height,
    colorMatrix: colorMatrix1For(frame.colorSpace),
    uniqueCameraModel: dngCameraModel(frame.colorSpace),
    compression: options.tiffCompression ?? 'deflate',
    xmp: options.metadata?.xmp || undefined,
    software: options.metadata?.software || undefined,
    onWarning: options.onWarning,
  });
}

/** The same two chunks for both PNG depths. */
async function embedPngMetadata(blob: Blob, metadata?: ExportMetadata): Promise<Blob> {
  if (!metadata) return blob;
  let result = metadata.xmp ? await embedXmpInPng(blob, metadata.xmp) : blob;
  result = await embedExifInPng(result, metadata);
  return result;
}

/**
 * Export a photo with adjustments: render once, encode once.
 *
 * `document` is what makes the exported file match the canvas: adjustment
 * layers, blend modes, masks, retouch spots and preset looks all live there,
 * not in the flattened `adjustments`.
 */
export async function exportPhoto(
  imageUrl: string,
  adjustments: Adjustments,
  options: ExportOptions = defaultExportOptions,
  fullResRaw?: RawPixelData | null,
  document?: PhotoDocument | null,
  baseAdjustments?: BuilderAdjustments | null,
  lensProfile?: LensCoefficients | null,
): Promise<Blob> {
  // Phase 1.D: the CSS-filter fallback is gone. WebGL2 + RGBA16F is a hard
  // requirement and the capability gate at boot keeps unsupported
  // environments out of here, so `useWebGL: false` has nothing left to
  // select — it only says "produce nothing", explicitly.
  if (options.useWebGL === false) {
    throw new Error('Exporter: WebGL pipeline failed and no fallback is available. Check WebGL2 + EXT_color_buffer_half_float support.');
  }

  const bitDepth = options.bitDepth ?? 8;
  if (bitDepth === 16 && options.format !== 'tiff' && options.format !== 'png' && options.format !== 'dng') {
    throw new Error('Exporter: 16-bit export supports TIFF, PNG and DNG only');
  }
  if (bitDepth !== 16 && options.format === 'dng') {
    throw new Error('Exporter: DNG is a 16-bit format and has no 8-bit encoding');
  }
  if (bitDepth === 16 && options.watermark) {
    throw new Error('Exporter: watermarks are unavailable for 16-bit export');
  }
  if (bitDepth === 16 && options.includeRetouch !== false && documentContainsRetouch(document)) {
    throw new Error('Exporter: spot removal is unavailable for 16-bit export');
  }

  const frame = await renderPhoto({
    imageUrl,
    adjustments,
    document,
    baseAdjustments: baseAdjustments ?? null,
    lensProfile: lensProfile ?? null,
    fullResRaw,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
    colorSpace: options.colorSpace ?? 'srgb',
    transferRaw: options.transferRaw,
    bitDepth,
    includeRetouch: options.includeRetouch ?? true,
  });

  return encodeFrame(frame, {
    format: options.format,
    quality: options.quality,
    watermark: options.watermark,
    maxWidth: options.maxWidth,
    maxHeight: options.maxHeight,
    tiffCompression: options.tiffCompression,
    onWarning: options.onWarning,
    metadata: metadataFor(options.metadata, options.includeMetadata),
  });
}

export function generateFileName(
  originalName: string,
  template: string = '{name}_edited',
  format: string = 'jpeg',
): string {
  const ext = originalName.lastIndexOf('.');
  const name = ext >= 0 ? originalName.slice(0, ext) : originalName;
  const result = template.replace('{name}', name);
  const formatExt = format === 'jpeg' ? 'jpg' : format === 'tiff' ? 'tif' : format;
  return `${result}.${formatExt}`;
}

const MIME_BY_FORMAT: Record<ExportOptions['format'], string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
  // Never reached: DNG is 16-bit only and leaves through `encodeDng`, not
  // through `convertToBlob`. The map is total so the type stays a Record.
  dng: 'image/x-adobe-dng',
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/** Shrink-to-fit, never enlarge. */
function fitWithin(
  width: number, height: number, maxWidth?: number, maxHeight?: number,
): { width: number; height: number } {
  if (!maxWidth && !maxHeight) return { width, height };
  const scale = Math.min((maxWidth ?? Infinity) / width, (maxHeight ?? Infinity) / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** A view over the frame, not a copy: the buffer came out of the worker by
 *  transfer and nothing else holds it. */
function frameToImageData(frame: RenderedFrame8): ImageData {
  const { pixels } = frame;
  // ImageData refuses a SharedArrayBuffer-backed view; render-to-pixels never
  // produces one (the worker posts a plain transferred buffer).
  const buffer = pixels.buffer as ArrayBuffer;
  return new ImageData(
    new Uint8ClampedArray(buffer, pixels.byteOffset, pixels.byteLength),
    frame.width, frame.height,
  );
}

/**
 * The frame as a canvas, ready to be drawn from.
 *
 * Exported because the print page composes frames with `drawImage` and would
 * otherwise have to rebuild the ImageData itself - `frameToImageData` stays
 * private so there is one place that knows a frame is RGBA8.
 */
export function frameToCanvas(frame: RenderedFrame): OffscreenCanvas {
  if (frame.bitDepth === 16) {
    throw new Error('frameToCanvas: 16-bit frames cannot be represented by ImageData');
  }
  const canvas = new OffscreenCanvas(frame.width, frame.height);
  canvas.getContext('2d')!.putImageData(frameToImageData(frame), 0, 0);
  return canvas;
}

/** The same frame at another size. Only the size-mismatch path uses it. */
function resampleFrame(frame: RenderedFrame8, width: number, height: number): RenderedFrame8 {
  const src = frameToCanvas(frame);
  const out = new OffscreenCanvas(width, height);
  const ctx = out.getContext('2d')!;
  ctx.drawImage(src, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  return {
    width, height,
    pixels: new Uint8Array(data.data.buffer),
    colorSpace: frame.colorSpace,
  };
}

/** Bilinear RGBA16 resize that never crosses the 8-bit Canvas APIs. */
function resampleFrame16(frame: RenderedFrame16, width: number, height: number): RenderedFrame16 {
  const pixels = new Uint16Array(width * height * 4);
  const sx = frame.width / width;
  const sy = frame.height / height;
  for (let y = 0; y < height; y++) {
    const srcY = Math.min(frame.height - 1, (y + 0.5) * sy - 0.5);
    const y0 = Math.max(0, Math.floor(srcY));
    const y1 = Math.min(frame.height - 1, y0 + 1);
    const fy = srcY - y0;
    for (let x = 0; x < width; x++) {
      const srcX = Math.min(frame.width - 1, (x + 0.5) * sx - 0.5);
      const x0 = Math.max(0, Math.floor(srcX));
      const x1 = Math.min(frame.width - 1, x0 + 1);
      const fx = srcX - x0;
      for (let channel = 0; channel < 4; channel++) {
        const a = frame.pixels[(y0 * frame.width + x0) * 4 + channel];
        const b = frame.pixels[(y0 * frame.width + x1) * 4 + channel];
        const c = frame.pixels[(y1 * frame.width + x0) * 4 + channel];
        const d = frame.pixels[(y1 * frame.width + x1) * 4 + channel];
        const top = a + (b - a) * fx;
        const bottom = c + (d - c) * fx;
        pixels[(y * width + x) * 4 + channel] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return { width, height, pixels, bitDepth: 16, colorSpace: frame.colorSpace };
}

/** Render through an `<img>` + ImageBitmap — everything that is not a 16-bit
 *  RAW buffer. */
async function renderFromBitmap(input: RenderPhotoInput): Promise<RenderedFrame> {
  const img = await loadImage(input.imageUrl);
  const { width, height } = fitWithin(img.width, img.height, input.maxWidth, input.maxHeight);

  const sourceId = `exporter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const svc = getDefaultPipelineService();
  let bound = false;
  let maskIds: string[] = [];
  let frame: RenderedFrame | null = null;
  try {
    const bitmap = await createImageBitmap(img, { resizeWidth: width, resizeHeight: height });
    const builderSource: BuilderSourceSpec = {
      kind: 'imageBitmap',
      geometry: { width, height, pixelRatio: 1 },
      // F030: the canvas, the thumbnails and the RAW path all state which
      // space they render in. This one did not, so it silently fell back to
      // sRGB and the exported file disagreed with the screen it was judged on.
      outputColorSpaceId: input.colorSpace,
    };
    // Compile with the real adjustments so compile-time facts (Phase-3
    // space overrides) match the editor's plan for the same edit.
    const spec = exportGraph(input.document, input.adjustments, builderSource, input.includeRetouch ?? true);
    const plan = await svc.compile(spec.graph,
      input.bitDepth === 16 ? { terminalFormat: 'rgba16f' } : undefined);
    await svc.bindSource(sourceId, bitmap); // transfers bitmap to worker
    bound = true;
    const masks = await bindDocumentMasks(svc, spec.maskLayers, sourceId, width, height);
    maskIds = masks.boundIds;
    if (input.bitDepth === 16) {
      const render = await svc.renderToPixels16(plan, sourceId, spec.params, extraSourcesOf(masks));
      frame = { ...render, pixels: render.pixels, bitDepth: 16, colorSpace: input.colorSpace };
    } else {
      const render = await svc.renderToPixels(plan, sourceId, spec.params, extraSourcesOf(masks));
      frame = { ...render, pixels: render.pixels, bitDepth: 8, colorSpace: input.colorSpace };
    }

    // Never assume the pipeline rendered what was asked for. Filling an
    // ImageData with pixels of another size shifts rows and tiles the image.
    // A crop is the intentional exception to source geometry, so compare to
    // the graph's crop contract rather than blindly stretching it away.
    const crop = cropFromGraph(spec.graph);
    const expected = crop
      ? {
          width: Math.max(1, Math.round(width * crop.width)),
          height: Math.max(1, Math.round(height * crop.height)),
        }
      : { width, height };
    if (frame.width !== expected.width || frame.height !== expected.height) {
      frame = frame.bitDepth === 16
        ? resampleFrame16(frame, expected.width, expected.height)
        : resampleFrame(frame, expected.width, expected.height);
    }
    void svc.releasePlan(plan);
  } catch (e) {
    console.warn('[renderPhoto] WebGL pipeline failed:', e);
  } finally {
    if (bound) void svc.unbindSource(sourceId);
    unbindDocumentMasks(svc, maskIds);
  }

  if (!frame) {
    throw new Error('Exporter: WebGL pipeline failed and no fallback is available. Check WebGL2 + EXT_color_buffer_half_float support.');
  }
  return frame;
}

/**
 * Render a 16-bit raw pixel buffer through the SAME graph engine the editor
 * uses (identical chain, identical params). WYSIWYG holds by construction:
 * any kind added to the default chain automatically exports the same way it
 * previews.
 */
async function renderFromRaw16(
  raw: RawPixelData,
  input: RenderPhotoInput,
): Promise<RenderedFrame> {
  if (raw.bits !== 16 || !(raw.data instanceof Uint16Array)) {
    throw new Error('renderPhoto: 16-bit raw source expects Uint16Array data');
  }
  const svc = getDefaultPipelineService();
  const sourceId = `exporter-raw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const builderSource: BuilderSourceSpec = {
    kind: 'raw16',
    geometry: { width: raw.width, height: raw.height, pixelRatio: 1 },
    channels: raw.channels,
    calibration: {
      asShotNeutral: raw.asShotNeutral ?? null,
      colorMatrix: raw.colorMatrix ?? null,
    },
    baseAdjustments: input.baseAdjustments ?? null,
    lensProfile: input.lensProfile ?? null,
    outputColorSpaceId: input.colorSpace,
  };
  const spec = exportGraph(input.document, input.adjustments, builderSource, input.includeRetouch ?? true);
  const plan = await svc.compile(spec.graph,
    input.bitDepth === 16 ? { terminalFormat: 'rgba16f' } : undefined);

  // bindSource TRANSFERS the buffer. A caller that still reads it afterwards
  // needs the copy; the export does not, and at 61 MP that copy is 361 MB
  // held next to the original (F132).
  const raw16: Raw16SourceData = {
    pixels: input.transferRaw ? raw.data : new Uint16Array(raw.data),
    width: raw.width,
    height: raw.height,
    channels: raw.channels,
  };

  let bound = false;
  let maskIds: string[] = [];
  try {
    await svc.bindSource(sourceId, raw16);
    bound = true;
    const masks = await bindDocumentMasks(svc, spec.maskLayers, sourceId, raw.width, raw.height);
    maskIds = masks.boundIds;
    let frame: RenderedFrame;
    if (input.bitDepth === 16) {
      const rendered = await svc.renderToPixels16(plan, sourceId, spec.params, extraSourcesOf(masks));
      frame = { ...rendered, pixels: rendered.pixels, bitDepth: 16, colorSpace: input.colorSpace };
    } else {
      const rendered = await svc.renderToPixels(plan, sourceId, spec.params, extraSourcesOf(masks));
      frame = { ...rendered, pixels: rendered.pixels, bitDepth: 8, colorSpace: input.colorSpace };
    }
    const size = fitWithin(frame.width, frame.height, input.maxWidth, input.maxHeight);
    if (size.width !== frame.width || size.height !== frame.height) {
      frame = frame.bitDepth === 16
        ? resampleFrame16(frame, size.width, size.height)
        : resampleFrame(frame, size.width, size.height);
    }
    return frame;
  } finally {
    if (bound) void svc.unbindSource(sourceId);
    unbindDocumentMasks(svc, maskIds);
    void svc.releasePlan(plan);
  }
}
