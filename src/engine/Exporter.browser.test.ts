/**
 * What the exporter renders — the wiring, not the pixels.
 *
 * The bug this measures: `exportPhoto` built its own single chain out of the
 * FLATTENED adjustments, so every adjustment layer fell out of the exported
 * file. Presets are adjustment layers (`applyPresetAsLayer`), so a photo with
 * a look exported without it while the canvas and the thumbnail showed it.
 *
 * The pixels themselves are already measured next door
 * ([graph/compat/layerStack.browser.test.ts](./graph/compat/layerStack.browser.test.ts)):
 * the layered graph renders correctly. What was never checked is that the
 * export ASKS for that graph — so that is what these tests pin down, through
 * a stand-in pipeline service that records what it is handed.
 *
 * Browser-mode-only: exportPhoto needs Image, OffscreenCanvas and
 * createImageBitmap. Run with: npx vitest run --project browser Exporter
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeFrame, exportPhoto, renderPhoto, defaultExportOptions } from './Exporter';
import {
  setDefaultPipelineService, KIND_COMPOSITE, KIND_RASTERIZED_MASK_SOURCE,
  KIND_CROP, KIND_HSL_DETAIL, KIND_OUTPUT_COLOR_SPACE, KIND_RETOUCH, maskNodeIdForLayer,
} from './graph';
import { OUTPUT_COLOR_SPACES, iccProfileFor } from './outputColorSpaces';
import type { RawPixelData } from './raw/RawDecoderStrategy';
import type { WorkerPipelineService } from './graph';
import { createDocument, createDocLayer, documentToAdjustments, type PhotoDocument } from './DocumentModel';
import { serializeGraph } from './graph/serialize';
import { buildDocumentGraph } from './graph/documentGraph';
import { defaultAdjustments, type Adjustments } from '../types';
import type { RenderGraph } from './graph';
import type { MaskDefinition } from './Mask';

const MASK: MaskDefinition = {
  id: 'm1', name: 'Radial', type: 'radial-gradient', visible: true,
  center: { x: 0.5, y: 0.5 }, radiusX: 0.3, radiusY: 0.3, feather: 0.5,
};

const SPOT = {
  id: 's1', mode: 'clone' as const,
  target: { x: 0.5, y: 0.5, radius: 0.1 },
  source: { x: 0.25, y: 0.25 },
  feather: 0.5, opacity: 1,
};

interface Recorded {
  graphs: RenderGraph[];
  compileOptions: Array<{ terminalFormat?: string } | undefined>;
  bound: string[];
  unbound: string[];
  /** What bindSource was handed — raw16 payload vs. ImageBitmap. */
  sources: unknown[];
  renders: { sourceId: string; params?: Map<string, unknown>; extraSources?: Record<string, string> }[];
}

/** A pipeline service that renders nothing and remembers everything.
 *  `size` is what it claims to have rendered — pass a different one to play
 *  a pipeline whose plan renders at another geometry than the export asked
 *  for. */
function recordingService(size: [number, number] = [4, 4]): { rec: Recorded; svc: WorkerPipelineService } {
  const rec: Recorded = { graphs: [], compileOptions: [], bound: [], unbound: [], sources: [], renders: [] };
  const [rw, rh] = size;
  const svc = {
    async compile(graph: RenderGraph, options?: { terminalFormat?: string }) {
      rec.graphs.push(graph);
      rec.compileOptions.push(options);
      return { planId: 'plan' };
    },
    async bindSource(id: string, source?: unknown) {
      rec.bound.push(id);
      rec.sources.push(source);
      // The real service transfers the buffer to the worker. Emulate that or
      // "transfer instead of clone" is not observable from out here at all.
      const pixels = (source as { pixels?: Uint16Array } | undefined)?.pixels;
      if (pixels?.buffer instanceof ArrayBuffer) {
        structuredClone(pixels.buffer, { transfer: [pixels.buffer] });
      }
    },
    async unbindSource(id: string) { rec.unbound.push(id); },
    async releasePlan() { /* nothing to release */ },
    // setDefaultPipelineService releases whatever it replaces.
    async release() { /* nothing to release */ },
    async renderToPixels(
      _plan: unknown, sourceId: string,
      params?: Map<string, unknown>, extraSources?: Record<string, string>,
    ) {
      rec.renders.push({ sourceId, params, extraSources });
      // Left half black, right half light — enough for the canvas + encoder
      // steps that follow, and a pattern a shifted copy cannot fake.
      const pixels = new Uint8Array(rw * rh * 4);
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const i = (y * rw + x) * 4;
          const v = x < rw / 2 ? 0 : 200;
          pixels[i] = v; pixels[i + 1] = v; pixels[i + 2] = v; pixels[i + 3] = 255;
        }
      }
      return { width: rw, height: rh, pixels };
    },
    async renderToPixels16(
      _plan: unknown, sourceId: string,
      params?: Map<string, unknown>, extraSources?: Record<string, string>,
    ) {
      rec.renders.push({ sourceId, params, extraSources });
      const pixels = new Uint16Array(rw * rh * 4);
      for (let i = 0; i < rw * rh; i++) {
        const value = Math.round(i * 65535 / Math.max(1, rw * rh - 1));
        pixels[i * 4] = value;
        pixels[i * 4 + 1] = value;
        pixels[i * 4 + 2] = value;
        pixels[i * 4 + 3] = 65535;
      }
      return { width: rw, height: rh, pixels };
    },
  } as unknown as WorkerPipelineService;
  return { rec, svc };
}

/** A 4x4 image as a blob URL — exportPhoto loads through an <img>. */
async function imageUrl(): Promise<string> {
  const canvas = new OffscreenCanvas(4, 4);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 4, 4);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return URL.createObjectURL(blob);
}

function documentWithLayer(over: Partial<PhotoDocument['layers'][number]> = {}): PhotoDocument {
  const doc = createDocument();
  const layer = createDocLayer('adjustment');
  return {
    ...doc,
    layers: [
      ...doc.layers,
      { ...layer, id: 'L1', adjustments: { exposure: 40 }, opacity: 0.75, blendMode: 'multiply', ...over },
    ],
  };
}

function graphLedWithStaleRetouchField(): PhotoDocument {
  const classic = { ...createDocument(), retouch: [SPOT] };
  const graph = buildDocumentGraph(classic, {
    kind: 'imageBitmap', geometry: { width: 4, height: 4, pixelRatio: 1 },
  }).graph;
  return {
    ...createDocument(),
    pipelineMode: 'graph',
    pipelineGraph: serializeGraph(graph),
    retouch: [],
  };
}


/** A 16-bit raw buffer of `w`x`h`, mid grey. Only its identity and its
 *  byteLength matter here — the recording service renders its own pattern. */
function rawPixels(w: number, h: number): RawPixelData {
  return {
    data: new Uint16Array(w * h * 3).fill(30000),
    width: w, height: h, channels: 3, bits: 16,
    colorMatrix: null, asShotNeutral: null,
  };
}

/** The blob's bytes, drawn back into a canvas so pixels can be read. */
async function pixelsOf(blob: Blob): Promise<(x: number, y: number) => number[]> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  return (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
}

/** Tags of the first IFD of a little-endian TIFF, tag -> SHORT values. */
function tiffTags(bytes: Uint8Array): Map<number, number[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    const tag = view.getUint16(at, true);
    const type = view.getUint16(at + 2, true);
    const n = view.getUint32(at + 4, true);
    if (type === 3 && n <= 2) {
      tags.set(tag, Array.from({ length: n }, (_, k) => view.getUint16(at + 8 + k * 2, true)));
    } else if (type === 3) {
      const off = view.getUint32(at + 8, true);
      tags.set(tag, Array.from({ length: n }, (_, k) => view.getUint16(off + k * 2, true)));
    } else {
      tags.set(tag, [view.getUint32(at + 8, true)]);
    }
  }
  return tags;
}

/** The ICC payload of a JPEG's APP2 segment, or null. */
function jpegIcc(bytes: Uint8Array): Uint8Array | null {
  const marker = 'ICC_PROFILE';
  for (let i = 0; i < bytes.length - marker.length; i++) {
    let hit = true;
    for (let k = 0; k < marker.length; k++) {
      if (bytes[i + k] !== marker.charCodeAt(k)) { hit = false; break; }
    }
    // marker, NUL, sequence number, total count — then the profile.
    if (hit) return bytes.subarray(i + marker.length + 3);
  }
  return null;
}

/** The ICCP payloads of a WebP RIFF container. */
function webpIccChunks(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const profiles: Uint8Array[] = [];
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    const type = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
    if (type === 'ICCP') profiles.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size + (size & 1);
  }
  return profiles;
}

interface PngChunk {
  type: string;
  data: Uint8Array;
}

function pngChunks(bytes: Uint8Array): PngChunk[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset, false);
    chunks.push({
      type: new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8)),
      data: bytes.subarray(offset + 8, offset + 8 + length),
    });
    offset += 12 + length;
  }
  return chunks;
}

async function inflatePng(parts: Uint8Array[]): Promise<Uint8Array> {
  const output = new Blob(parts.map((part) => part.slice().buffer)).stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(output).arrayBuffer());
}

const ADJUSTMENTS: Adjustments = { ...defaultAdjustments, contrast: 20 };

// Never allocate the real worker service here: the next getDefaultPipelineService
// call makes a fresh one if anything still needs it.
afterEach(() => {
  setDefaultPipelineService(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const kindsOf = (graph: RenderGraph) => [...graph.nodes.values()].map((n) => n.kind);

describe('exportPhoto renders what the canvas renders', () => {
  it('hands persisted skin-tone uniformity to the export graph outside the skin-tone tab', async () => {
    const { rec, svc } = recordingService();
    setDefaultPipelineService(svc);
    const doc = createDocument();
    doc.layers[0].adjustments = {
      colorEditorMode: 'advanced',
      skinToneUniformity: { hue: 40, saturation: 0, luminance: 0 },
    };
    await exportPhoto(await imageUrl(), documentToAdjustments(doc), defaultExportOptions, null, doc);

    const params = rec.renders[0].params?.get(`default:${KIND_HSL_DETAIL}`) as {
      skinTone?: { uniHue: number };
    };
    expect(params.skinTone?.uniHue).toBe(0.4);
  });

  it('compiles the layered graph when the document has an adjustment layer', async () => {
    const { rec, svc } = recordingService();
    setDefaultPipelineService(svc);
    await exportPhoto(await imageUrl(), ADJUSTMENTS, defaultExportOptions, null,
      documentWithLayer());

    expect(rec.graphs).toHaveLength(1);
    expect(kindsOf(rec.graphs[0])).toContain(KIND_COMPOSITE);
    // The layer's own branch is there, and it carries the layer's exposure.
    expect([...rec.graphs[0].nodes.keys()]).toContain('layer:L1:default:tone');
    const params = rec.renders[0].params;
    expect(params?.get('comp:L1')).toMatchObject({ opacity: 0.75, blendMode: 'multiply' });
  });

  it('is the bug, spelled out: without the document the layer disappears', async () => {
    // The old call shape, still used by any caller that has no document.
    const { rec, svc } = recordingService();
    setDefaultPipelineService(svc);
    await exportPhoto(await imageUrl(), ADJUSTMENTS, defaultExportOptions, null);

    expect(kindsOf(rec.graphs[0])).not.toContain(KIND_COMPOSITE);
    expect(rec.renders[0].extraSources).toBeUndefined();
  });

  it('binds and releases the mask of a masked layer', async () => {
    const { rec, svc } = recordingService();
    setDefaultPipelineService(svc);
    await exportPhoto(await imageUrl(), ADJUSTMENTS, defaultExportOptions, null,
      documentWithLayer({ mask: MASK }));

    expect(kindsOf(rec.graphs[0])).toContain(KIND_RASTERIZED_MASK_SOURCE);
    const extra = rec.renders[0].extraSources ?? {};
    const maskSourceId = extra[maskNodeIdForLayer('L1')];
    expect(maskSourceId).toBeTruthy();
    expect(rec.bound).toContain(maskSourceId);
    // Nothing may stay bound in the worker after an export.
    expect([...rec.unbound].sort()).toEqual([...rec.bound].sort());
  });

  it('leaves a document without layers on the single chain it always used', async () => {
    const { rec, svc } = recordingService();
    setDefaultPipelineService(svc);
    await exportPhoto(await imageUrl(), ADJUSTMENTS, defaultExportOptions, null,
      createDocument());

    expect(kindsOf(rec.graphs[0])).not.toContain(KIND_COMPOSITE);
    expect(rec.renders[0].extraSources).toBeUndefined();
  });

  it('keeps the crop node geometry in an SDR export instead of stretching it back', async () => {
    const doc = createDocument();
    doc.transform.crop = { x: 0.5, y: 0, width: 0.5, height: 1 };
    const { rec, svc } = recordingService([2, 4]);
    setDefaultPipelineService(svc);

    const blob = await exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'png' }, null, doc);
    const bitmap = await createImageBitmap(blob);

    expect(rec.graphs[0].nodes.get(rec.graphs[0].output)?.kind).toBe(KIND_CROP);
    expect([bitmap.width, bitmap.height]).toEqual([2, 4]);

    const { svc: rawSvc } = recordingService([2, 4]);
    setDefaultPipelineService(rawSvc);
    const rawBlob = await exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'png' }, rawPixels(4, 4), doc);
    const rawBitmap = await createImageBitmap(rawBlob);
    expect([rawBitmap.width, rawBitmap.height]).toEqual([2, 4]);
  });

  it('exports the stored graph of a graph-led photo, not one built from the sliders', async () => {
    // Step 4: for a graph-led photo the graph is the truth and the
    // adjustments are the derived side. The exporter asks the same function
    // the canvas asks, so the file and the screen cannot drift apart.
    const doc = documentWithLayer();
    const stored = serializeGraph(buildDocumentGraph(doc, {
      kind: 'imageBitmap', geometry: { width: 1600, height: 1067, pixelRatio: 2 },
    }).graph);
    const led: PhotoDocument = {
      ...doc,
      pipelineMode: 'graph',
      // Turned away from what the adjustments say — a built graph could
      // never produce this value.
      pipelineGraph: {
        ...stored,
        nodes: stored.nodes.map((n) => (n.id === 'default:tone'
          ? { ...n, params: { ...(n.params as object), exposure: 0.99 } }
          : n)),
      },
    };

    const { rec, svc } = recordingService();
    setDefaultPipelineService(svc);
    await exportPhoto(await imageUrl(), ADJUSTMENTS, defaultExportOptions, null, led);

    expect(rec.graphs[0].nodes.get('default:tone')!.params).toMatchObject({ exposure: 0.99 });
    // Nothing is handed in as an override; the stored nodes are the truth.
    expect([...(rec.renders[0].params ?? [])]).toEqual([]);
    // …and it renders at the export geometry, not at the size it was stored at.
    const source = [...rec.graphs[0].nodes.values()]
      .find((n) => n.kind === '__source.imageBitmap')!;
    expect(source.params).toMatchObject({ width: 4, height: 4, pixelRatio: 1 });
  });

  it('survives a pipeline that renders at another size than the export asked for', async () => {
    // Filling a 4x4 ImageData with 2x2 pixels does not throw — it shifts
    // every row and tiles the picture. A stale plan-cache entry did exactly
    // that to a real export, so the exporter now draws at the size it got.
    const { svc } = recordingService([2, 2]);
    setDefaultPipelineService(svc);
    const blob = await exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'png' }, null, createDocument());

    const bitmap = await createImageBitmap(blob);
    expect([bitmap.width, bitmap.height]).toEqual([4, 4]);
    // The 2x2 render scaled up: left half dark, right half light, opaque.
    // The old code left three of the four rows transparent.
    const c = new OffscreenCanvas(4, 4);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const at = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
    expect(at(0, 3)).toEqual([0, 0, 0, 255]);
    expect(at(3, 3)).toEqual([200, 200, 200, 255]);
  });

  it('takes a preset layer along, which is what the user actually notices', async () => {
    const { rec, svc } = recordingService();
    setDefaultPipelineService(svc);
    await exportPhoto(await imageUrl(), ADJUSTMENTS, defaultExportOptions, null,
      documentWithLayer({
        presetSyncId: 'sync-kodak', opacity: 0.6, blendMode: 'normal',
        adjustments: { saturation: 25, grain: 30 },
      }));

    const params = rec.renders[0].params;
    expect(params?.get('comp:L1')).toMatchObject({ opacity: 0.6, presetSyncId: 'sync-kodak' });
    // The look's own grain rides on the branch, not on the base.
    expect(params?.get('layer:L1:default:effects')).toMatchObject({ grain: 0.3 });
    expect(params?.get('default:effects')).toMatchObject({ grain: 0 });
  });
});

describe('the encode stage runs behind BOTH render paths', () => {
  // What this measures: the RAW path used to return its blob before spot
  // removal, watermark, colour space and ICC ever ran, and its mime map knew
  // no TIFF — so a RAW exported as TIFF was JPEG bytes under a .tif name
  // (F008). Everything below goes through the raw16 source.

  it('writes a real TIFF with an ICC profile when a RAW is exported as tiff', async () => {
    const { svc } = recordingService([64, 64]);
    setDefaultPipelineService(svc);
    const blob = await exportPhoto(
      await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'tiff' }, rawPixels(64, 64), createDocument(),
    );

    expect(blob.type).toBe('image/tiff');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x49, 0x49, 0x2a, 0x00]);
    const tags = tiffTags(bytes);
    expect(tags.get(258)).toEqual([8, 8, 8]);   // BitsPerSample
    expect(tags.get(259)).toEqual([8]);          // Adobe Deflate is the default
    expect(tags.has(34675)).toBe(true);          // ICCProfile
  });

  it('keeps more than 256 levels in a 16-bit TIFF without a canvas round-trip', async () => {
    const { rec, svc } = recordingService([512, 1]);
    setDefaultPipelineService(svc);
    const blob = await exportPhoto(
      await imageUrl(), ADJUSTMENTS,
      {
        ...defaultExportOptions,
        format: 'tiff',
        bitDepth: 16,
        includeRetouch: false,
        tiffCompression: 'none',
      },
      rawPixels(512, 1), createDocument(),
    );

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const tags = tiffTags(bytes);
    expect(rec.compileOptions[0]).toEqual({ terminalFormat: 'rgba16f' });
    expect(tags.get(258)).toEqual([16, 16, 16]);
    expect(tags.get(339)).toEqual([1, 1, 1]);
    expect(tags.get(259)).toEqual([1]);
    const stripOffset = tags.get(273)![0];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const channels = [0, 1, 2].map((channel) =>
      Array.from({ length: 512 }, (_, i) => view.getUint16(stripOffset + i * 6 + channel * 2, true)));
    for (const values of channels) expect(new Set(values).size).toBeGreaterThan(256);
    expect(channels[0].some((value) => value % 257 !== 0)).toBe(true);
  });

  it('exports a real ICC-tagged 16-bit PNG without quantizing the rendered frame', async () => {
    const { rec, svc } = recordingService([512, 1]);
    setDefaultPipelineService(svc);
    const blob = await exportPhoto(
      await imageUrl(), ADJUSTMENTS,
      {
        ...defaultExportOptions,
        format: 'png',
        bitDepth: 16,
        includeRetouch: false,
        colorSpace: 'adobe-rgb',
      },
      rawPixels(512, 1), createDocument(),
    );

    expect(blob.type).toBe('image/png');
    expect(rec.compileOptions[0]).toEqual({ terminalFormat: 'rgba16f' });
    const chunks = pngChunks(new Uint8Array(await blob.arrayBuffer()));
    expect(chunks.slice(0, 2).map((chunk) => chunk.type)).toEqual(['IHDR', 'iCCP']);
    expect(chunks.at(-1)?.type).toBe('IEND');
    expect(chunks.slice(2, -1).every((chunk) => chunk.type === 'IDAT')).toBe(true);
    expect(chunks[0].data[8]).toBe(16);
    expect(chunks[0].data[9]).toBe(6);

    const scanline = await inflatePng(chunks.filter((chunk) => chunk.type === 'IDAT')
      .map((chunk) => chunk.data));
    const samples = new DataView(scanline.buffer, scanline.byteOffset + 1, scanline.byteLength - 1);
    const channels = [0, 1, 2].map((channel) =>
      Array.from({ length: 512 }, (_, x) => samples.getUint16(x * 8 + channel * 2, false)));
    for (const values of channels) expect(new Set(values).size).toBeGreaterThan(256);
    expect(channels[0].some((value) => value % 257 !== 0)).toBe(true);

    const iccp = chunks.find((chunk) => chunk.type === 'iCCP')!.data;
    const nameEnd = iccp.indexOf(0);
    expect(iccp[nameEnd + 1]).toBe(0);
    const embedded = await inflatePng([iccp.subarray(nameEnd + 2)]);
    expect(embedded).toEqual(iccProfileFor('adobe-rgb'));
  });

  it('fails a 16-bit PNG encode when its mandatory deflate encoder is unavailable', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    await expect(encodeFrame({
      width: 1,
      height: 1,
      pixels: new Uint16Array([1, 2, 3, 65535]),
      bitDepth: 16,
      colorSpace: 'srgb',
    }, { format: 'png', quality: 100 })).rejects.toThrow(/Deflate compression is unavailable/);
  });

  it('reports TIFF Deflate fallback and still returns an uncompressed file', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onWarning = vi.fn();
    const blob = await encodeFrame({
      width: 1,
      height: 1,
      pixels: new Uint16Array([1, 2, 3, 65535]),
      bitDepth: 16,
      colorSpace: 'srgb',
    }, { format: 'tiff', quality: 100, tiffCompression: 'deflate', onWarning });
    const tags = tiffTags(new Uint8Array(await blob.arrayBuffer()));

    expect(blob.type).toBe('image/tiff');
    expect(tags.get(259)).toEqual([1]);
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({
      code: 'deflate-unavailable', actualCompression: 'none',
    }));
  });

  it('carries the fallback warning through the public export options', async () => {
    const url = await imageUrl();
    const { svc } = recordingService([2, 2]);
    setDefaultPipelineService(svc);
    vi.stubGlobal('CompressionStream', undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const onWarning = vi.fn();
    const blob = await exportPhoto(url, ADJUSTMENTS, {
      ...defaultExportOptions,
      format: 'tiff',
      onWarning,
    }, null, createDocument());

    expect(tiffTags(new Uint8Array(await blob.arrayBuffer())).get(259)).toEqual([1]);
    expect(onWarning).toHaveBeenCalledWith(expect.objectContaining({ code: 'deflate-unavailable' }));
  });

  it('requires real 16-bit source pixels instead of upscaling a preview', async () => {
    const { rec, svc } = recordingService();
    setDefaultPipelineService(svc);

    await expect(exportPhoto(
      await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'tiff', bitDepth: 16, includeRetouch: false },
      null, createDocument(),
    )).rejects.toThrow(/requires actual 16-bit source pixels/);
    expect(rec.graphs).toHaveLength(0);
  });

  it('does not route a failed 16-bit RAW render through the bitmap fallback', async () => {
    const { svc } = recordingService();
    setDefaultPipelineService(svc);
    vi.spyOn(svc, 'renderToPixels16').mockRejectedValueOnce(new Error('16-bit render broke'));
    const previewRender = vi.spyOn(svc, 'renderToPixels');

    await expect(renderPhoto({
      imageUrl: await imageUrl(),
      adjustments: ADJUSTMENTS,
      document: createDocument(),
      fullResRaw: rawPixels(4, 4),
      colorSpace: 'srgb',
      bitDepth: 16,
      includeRetouch: false,
    })).rejects.toThrow('16-bit render broke');
    expect(previewRender).not.toHaveBeenCalled();
  });

  it('keeps the established bitmap fallback for an 8-bit request', async () => {
    const { svc } = recordingService();
    setDefaultPipelineService(svc);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(svc, 'renderToPixels').mockRejectedValueOnce(new Error('RAW render broke'));

    const frame = await renderPhoto({
      imageUrl: await imageUrl(),
      adjustments: ADJUSTMENTS,
      document: createDocument(),
      fullResRaw: rawPixels(4, 4),
      colorSpace: 'srgb',
      bitDepth: 8,
    });
    expect(frame.bitDepth).toBe(8);
    expect(svc.renderToPixels).toHaveBeenCalledTimes(2);
  });

  it('rejects hidden 8-bit-only operations on the programmatic 16-bit path', async () => {
    const doc = { ...createDocument(), retouch: [SPOT] };
    await expect(exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'tiff', bitDepth: 16 }, rawPixels(4, 4), doc))
      .rejects.toThrow(/spot removal is unavailable/);
    await expect(exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'tiff', bitDepth: 16, watermark: 'WM' },
      rawPixels(4, 4), createDocument()))
      .rejects.toThrow(/watermarks are unavailable/);

    const stale = graphLedWithStaleRetouchField();
    await expect(exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'tiff', bitDepth: 16 }, rawPixels(4, 4), stale))
      .rejects.toThrow(/spot removal is unavailable/);

    const { rec, svc } = recordingService();
    setDefaultPipelineService(svc);
    await expect(exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'tiff', bitDepth: 16, includeRetouch: false },
      rawPixels(4, 4), stale)).resolves.toMatchObject({ type: 'image/tiff' });
    expect(kindsOf(rec.graphs[0])).not.toContain(KIND_RETOUCH);
  });

  it('stamps the watermark on a RAW export, not only on the bitmap path', async () => {
    const { svc } = recordingService([64, 64]);
    setDefaultPipelineService(svc);
    const options = { ...defaultExportOptions, format: 'png' as const };
    const plain = await exportPhoto(await imageUrl(), ADJUSTMENTS,
      options, rawPixels(64, 64), createDocument());
    const marked = await exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...options, watermark: 'WM' }, rawPixels(64, 64), createDocument());

    const a = await pixelsOf(plain);
    const b = await pixelsOf(marked);
    let differing = 0;
    for (let y = 44; y < 64; y++) {
      for (let x = 30; x < 64; x++) if (String(a(x, y)) !== String(b(x, y))) differing++;
    }
    expect(differing).toBeGreaterThan(0);
  });

  it('compiles the document retouch into the exported graph', async () => {
    // The spots used to be an argument the app never filled, applied on the
    // CPU after the render (F009). They are a document field and a graph node
    // now, so the export gets them the way it gets layers and masks: by
    // asking `buildDocumentGraph`. The pixels the node produces are measured
    // in graph/compat/retouch.browser.test.ts.
    const { rec, svc } = recordingService([64, 64]);
    setDefaultPipelineService(svc);
    const spot = {
      id: 's1', mode: 'clone' as const,
      target: { x: 0.75, y: 0.5, radius: 8 / 64 },
      source: { x: 0.25, y: 0.5 },
      feather: 0.5, opacity: 1,
    };
    const doc: PhotoDocument = { ...createDocument(), retouch: [spot] };
    await exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'png' }, rawPixels(64, 64), doc);

    expect(kindsOf(rec.graphs[0])).toContain(KIND_RETOUCH);
    const node = [...rec.graphs[0].nodes.values()].find((n) => n.kind === KIND_RETOUCH)!;
    expect(node.params).toMatchObject({ spots: [{ tx: 0.75, ty: 0.5, sx: 0.25, mode: 'clone' }] });
    // …and a document without spots keeps the graph it always had.
    const { rec: plain, svc: plainSvc } = recordingService([64, 64]);
    setDefaultPipelineService(plainSvc);
    await exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'png' }, rawPixels(64, 64), createDocument());
    expect(kindsOf(plain.graphs[0])).not.toContain(KIND_RETOUCH);
  });

  it('renders in the chosen colour space and tags the file with its profile', async () => {
    const { rec, svc } = recordingService();
    setDefaultPipelineService(svc);
    const blob = await exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, colorSpace: 'adobe-rgb' }, null, createDocument());

    // The bitmap path used to state no output space at all, so the graph
    // rendered sRGB while the canvas rendered the setting (F030).
    const ocs = [...rec.graphs[0].nodes.values()].find((n) => n.kind === KIND_OUTPUT_COLOR_SPACE);
    expect(ocs?.params).toMatchObject({ matrix: OUTPUT_COLOR_SPACES['adobe-rgb'].matrix });

    const icc = jpegIcc(new Uint8Array(await blob.arrayBuffer()));
    const adobe = iccProfileFor('adobe-rgb')!;
    expect(icc).not.toBeNull();
    expect([...icc!.subarray(0, 16)]).toEqual([...adobe.subarray(0, 16)]);
  });

  it('embeds the rendered colour space in WebP exports', async () => {
    const { svc } = recordingService();
    setDefaultPipelineService(svc);
    const blob = await exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, format: 'webp', colorSpace: 'adobe-rgb' }, null, createDocument());

    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    const profiles = webpIccChunks(bytes);
    const adobe = iccProfileFor('adobe-rgb')!;
    expect(profiles).toHaveLength(1);
    expect([...profiles[0].subarray(0, 16)]).toEqual([...adobe.subarray(0, 16)]);
  });

  it('hands the raw buffer to the worker instead of copying it', async () => {
    const { rec, svc } = recordingService([64, 64]);
    setDefaultPipelineService(svc);
    const raw = rawPixels(64, 64);
    await exportPhoto(await imageUrl(), ADJUSTMENTS,
      { ...defaultExportOptions, transferRaw: true }, raw, createDocument());

    expect((rec.sources[0] as { pixels: Uint16Array }).pixels).toBe(raw.data);
    // bindSource transferred it, so the caller's view is detached.
    expect(raw.data.byteLength).toBe(0);
  });

  it('copies the raw buffer when the caller keeps it', async () => {
    const { rec, svc } = recordingService([64, 64]);
    setDefaultPipelineService(svc);
    const raw = rawPixels(64, 64);
    await exportPhoto(await imageUrl(), ADJUSTMENTS,
      defaultExportOptions, raw, createDocument());

    // Identity by `===`, not by toBe: the copy handed to bindSource is
    // detached by then, and a failing toBe would try to walk it.
    expect((rec.sources[0] as { pixels: Uint16Array }).pixels === raw.data).toBe(false);
    expect(raw.data.byteLength).toBe(64 * 64 * 3 * 2);
  });

  it('returns a RAW frame within both requested size limits', async () => {
    const { svc } = recordingService([64, 32]);
    setDefaultPipelineService(svc);
    const frame = await renderPhoto({
      imageUrl: await imageUrl(),
      adjustments: ADJUSTMENTS,
      document: createDocument(),
      fullResRaw: rawPixels(64, 32),
      maxWidth: 24,
      maxHeight: 16,
      colorSpace: 'srgb',
    });

    expect([frame.width, frame.height]).toEqual([24, 12]);
    expect(frame.pixels).toHaveLength(24 * 12 * 4);
  });
});
