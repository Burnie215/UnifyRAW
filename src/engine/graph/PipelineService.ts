import type { CompiledPlan, RenderGraph } from './types';
import { NodeRegistry } from './NodeRegistry';
import { GraphCompiler, type CompileOptions } from './GraphCompiler';
import { PipelineExecutor } from './PipelineExecutor';
import { registerAllBuiltins } from './registerBuiltins';
import type { Raw16SourceData } from './sources';

/** Any input shape the built-in source kinds know how to upload. */
export type RenderSource = ImageBitmap | Raw16SourceData;

/**
 * Singleton-style fassade around the graph subsystem. Owns:
 *   - one WebGL2 context (the executor's)
 *   - one NodeRegistry with all built-in kinds pre-registered
 *   - one GraphCompiler + one PipelineExecutor
 *   - a topology-keyed CompiledPlan cache so slider drags don't recompile
 *
 * Phase 1: main-thread only — consumers (editor, thumbs, presets, exporter)
 * all share the same instance to guarantee identical pixel output across
 * render paths (fixes the original preset-thumb-mismatch bug structurally).
 *
 * Phase 1.5 will wrap this in an OffscreenCanvas Worker so the main thread
 * never blocks on GL. The public API stays unchanged — the worker is an
 * internal swap.
 */
export class PipelineService {
  readonly registry: NodeRegistry;
  private readonly compiler: GraphCompiler;
  private readonly executor: PipelineExecutor;
  private readonly gl: WebGL2RenderingContext;
  private readonly planCache = new Map<string, CompiledPlan>();
  /** Scratch canvas for readPixels-to-blob conversions. Created on first use. */
  private blobCanvas: OffscreenCanvas | null = null;
  /** Texture→backbuffer blit for renderToImageBitmap. Created on first use. */
  private blitter: Blitter | null = null;

  constructor(gl: WebGL2RenderingContext, registry?: NodeRegistry) {
    this.gl = gl;
    this.registry = registry ?? new NodeRegistry();
    registerAllBuiltins(this.registry);
    this.compiler = new GraphCompiler(this.registry);
    this.executor = new PipelineExecutor(gl, this.registry);
  }

  /** Compile a graph, caching by topology hash. Same graph → same plan.
   *  LRU-capped: preview/one-shot consumers churn distinct graph ids, and
   *  an unbounded cache would grow for the whole worker lifetime. */
  async compile(graph: RenderGraph, options?: CompileOptions): Promise<CompiledPlan> {
    const key = planCacheKey(graph, options);
    const cached = this.planCache.get(key);
    if (cached && cached.graphRevision === graph.metadata.revision) {
      // Refresh recency (Map preserves insertion order).
      this.planCache.delete(key);
      this.planCache.set(key, cached);
      return cached;
    }

    const plan = await this.compiler.compile(graph, options);
    this.planCache.delete(key);
    this.planCache.set(key, plan);
    while (this.planCache.size > MAX_CACHED_PLANS) {
      const oldest = this.planCache.keys().next().value as string;
      this.planCache.delete(oldest);
    }
    return plan;
  }

  /** Drop a single plan from the cache (e.g. after editing graph topology). */
  invalidatePlan(graph: RenderGraph, options?: CompileOptions): void {
    this.planCache.delete(planCacheKey(graph, options));
  }

  clearPlanCache(): void {
    this.planCache.clear();
  }

  /**
   * Render `plan` against `source` bound to its primary source node with
   * optional per-node param overrides. Returns the terminal output texture
   * handle + any captured tap textures.
   *
   * `source` may be an ImageBitmap (for `imageBitmapSource` plans) or a
   * `Raw16SourceData` (for `raw16Source` plans). The source node's
   * `uploadSource` validates the shape at runtime.
   *
   * `extraByNode` binds additional source-category nodes by node id (e.g.
   * per-layer mask sources in layered plans). The primary source node is
   * the one source node NOT listed there.
   */
  async renderToTexture(
    plan: CompiledPlan,
    source: RenderSource,
    paramsByNode?: Map<string, unknown>,
    extraByNode?: Map<string, RenderSource>,
  ): Promise<{ output: WebGLTexture; taps: Map<string, WebGLTexture> }> {
    const sourceNodeId = findSourceNodeId(plan, this.registry, extraByNode);
    this.executor.bindExternalData(sourceNodeId, source);
    if (extraByNode) {
      for (const [nodeId, data] of extraByNode) {
        this.executor.bindExternalData(nodeId, data);
      }
    }
    try {
      const result = await this.executor.execute(plan, paramsByNode);
      return { output: result.outputTexture, taps: result.taps };
    } finally {
      this.executor.clearExternalData();
    }
  }

  /**
   * Render to raw RGBA8 pixels in top-row-first (ImageData) convention.
   * Use this when the caller still needs to do post-processing on a 2D
   * canvas (e.g. Exporter applying spot removals + watermark + ICC).
   */
  async renderToPixels(
    plan: CompiledPlan,
    source: RenderSource,
    paramsByNode?: Map<string, unknown>,
    extraByNode?: Map<string, RenderSource>,
  ): Promise<{ width: number; height: number; pixels: Uint8Array }> {
    const { output } = await this.renderToTexture(plan, source, paramsByNode, extraByNode);
    const geom = terminalGeometry(plan);
    const pixels = readPixelsImageOrder(this.gl, output, geom.width, geom.height);
    return { width: geom.width, height: geom.height, pixels };
  }

  /** Render to normalized RGBA16 pixels without an ImageData/canvas round-trip. */
  async renderToPixels16(
    plan: CompiledPlan,
    source: RenderSource,
    paramsByNode?: Map<string, unknown>,
    extraByNode?: Map<string, RenderSource>,
  ): Promise<{ width: number; height: number; pixels: Uint16Array }> {
    const terminal = plan.perNodeFbo.get(plan.output);
    if (plan.terminalFormat !== 'rgba16f' || terminal?.format !== 'rgba16f') {
      throw new Error('PipelineService: renderToPixels16 requires terminalFormat rgba16f');
    }
    const { output } = await this.renderToTexture(plan, source, paramsByNode, extraByNode);
    const geom = terminalGeometry(plan);
    const pixels = readPixels16(this.gl, output, geom.width, geom.height);
    return { width: geom.width, height: geom.height, pixels };
  }

  /**
   * Render to a JPEG/PNG blob. Convenience wrapper for thumbnail / preset
   * paths that need a Blob URL for `<img>` consumption. Reads pixels back
   * from the executor's output texture (already in image order), draws into
   * an OffscreenCanvas, and encodes.
   */
  async renderToBlob(
    plan: CompiledPlan,
    source: RenderSource,
    paramsByNode?: Map<string, unknown>,
    options: { type?: string; quality?: number; maxDim?: number } = {},
    extraByNode?: Map<string, RenderSource>,
  ): Promise<Blob> {
    const r = await this.renderToPixels(plan, source, paramsByNode, extraByNode);
    return pixelsToBlob(this.getBlobCanvas(r.width, r.height), r.pixels, r, options);
  }

  /**
   * Render to a directly-drawable ImageBitmap WITHOUT a CPU readback: blits
   * the terminal texture onto the GL canvas backbuffer and transfers it.
   * This is the editor's per-frame display path — renderToPixels' readPixels
   * (GPU stall) plus two full-frame copies are avoided entirely.
   */
  async renderToImageBitmap(
    plan: CompiledPlan,
    source: RenderSource,
    paramsByNode?: Map<string, unknown>,
    extraByNode?: Map<string, RenderSource>,
  ): Promise<{ width: number; height: number; bitmap: ImageBitmap }> {
    const { output } = await this.renderToTexture(plan, source, paramsByNode, extraByNode);
    const geom = terminalGeometry(plan);
    if (!this.blitter) this.blitter = new Blitter(this.gl);
    const bitmap = this.blitter.toImageBitmap(output, geom.width, geom.height);
    return { width: geom.width, height: geom.height, bitmap };
  }

  /** Frees GL resources. Subsequent calls fail. */
  release(): void {
    this.executor.release();
    this.planCache.clear();
    this.blobCanvas = null;
    this.blitter?.release();
    this.blitter = null;
  }

  private getBlobCanvas(width: number, height: number): OffscreenCanvas {
    if (!this.blobCanvas || this.blobCanvas.width !== width || this.blobCanvas.height !== height) {
      this.blobCanvas = new OffscreenCanvas(width, height);
    }
    return this.blobCanvas;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Minimal textured-quad blit onto the default framebuffer (the GL canvas
 * backbuffer), used to mint ImageBitmaps via transferToImageBitmap().
 *
 * The vertex stage flips Y: engine textures store the image top at row 0,
 * but the canvas backbuffer presents its HIGHEST rows at the top of the
 * screen — an identity blit would hand out upside-down bitmaps.
 */
class Blitter {
  private readonly gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private buffer: WebGLBuffer | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  toImageBitmap(texture: WebGLTexture, width: number, height: number): ImageBitmap {
    const gl = this.gl;
    const canvas = gl.canvas as OffscreenCanvas;
    if (typeof canvas.transferToImageBitmap !== 'function') {
      throw new Error('Blitter: gl canvas is not an OffscreenCanvas');
    }
    this.ensureProgram();
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    return canvas.transferToImageBitmap();
  }

  release(): void {
    const gl = this.gl;
    if (this.program) { gl.deleteProgram(this.program); this.program = null; }
    if (this.vao) { gl.deleteVertexArray(this.vao); this.vao = null; }
    if (this.buffer) { gl.deleteBuffer(this.buffer); this.buffer = null; }
  }

  private ensureProgram(): void {
    if (this.program) return;
    const gl = this.gl;
    const vsSource = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position.x, -a_position.y, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;
    const fsSource = `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 fragColor;
uniform sampler2D u_texture;
void main() { fragColor = texture(u_texture, v_texCoord); }`;

    const compile = (type: number, src: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Blitter: createShader null');
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Blitter: shader compile failed: ${log}`);
      }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    const program = gl.createProgram();
    if (!program) throw new Error('Blitter: createProgram null');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_position');
    gl.bindAttribLocation(program, 1, 'a_texCoord');
    gl.linkProgram(program);
    gl.detachShader(program, vs);
    gl.detachShader(program, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Blitter: program link failed: ${log}`);
    }
    this.program = program;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'u_texture'), 0);

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) throw new Error('Blitter: vao/buffer creation failed');
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
       1,  1, 1, 1,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    this.vao = vao;
    this.buffer = buffer;
  }
}

/** Generous for one editor session (default graph + layered + a handful of
 *  preview taps + thumb geometries) while bounding worker memory. */
const MAX_CACHED_PLANS = 32;

function planCacheKey(graph: RenderGraph, options?: CompileOptions): string {
  // Cache by graph identity + tap options. Param changes don't invalidate.
  // Geometry changes belong in the graph.id by convention (the default
  // builder seeds id from dimensions), so different sources land in
  // distinct cache slots.
  const taps = options?.captureAfter?.map((c) => `${c.nodeId}=${c.label}`).join('|') ?? '';
  return `${graph.id}|${taps}|terminal:${options?.terminalFormat ?? 'default'}`;
}

function findSourceNodeId(
  plan: CompiledPlan,
  registry: NodeRegistry,
  extraByNode?: Map<string, unknown>,
): string {
  let foundId: string | null = null;
  for (const [id, node] of plan.augmentedNodes) {
    if (extraByNode?.has(id)) continue; // explicitly bound (e.g. mask source)
    const spec = registry.get(node.kind);
    if (spec?.category === 'source') {
      if (foundId !== null) {
        throw new Error('PipelineService: plan has multiple unbound source nodes; bind extras via extraByNode');
      }
      foundId = id;
    }
  }
  if (!foundId) throw new Error('PipelineService: plan has no source node');
  return foundId;
}

function terminalGeometry(plan: CompiledPlan): { width: number; height: number } {
  const binding = plan.perNodeFbo.get(plan.output) ??
    [...plan.perNodeFbo.values()].pop();
  if (!binding) throw new Error('PipelineService: plan has no terminal geometry');
  return { width: binding.geometry.width, height: binding.geometry.height };
}

/**
 * Reads a texture back in top-row-first (ImageData) order.
 *
 * No row flip is needed: sources upload without UNPACK_FLIP_Y (image row 0
 * lands in texture v=0) and the fullscreen quad maps uv(0,0) to clip(-1,-1),
 * so framebuffer row 0 — the first row readPixels returns — IS the image's
 * top row. This is the single place the engine's Y-orientation is decided;
 * every consumer (display, blobs, exporter, previews) receives image order.
 */
function readPixelsImageOrder(
  gl: WebGL2RenderingContext, texture: WebGLTexture, width: number, height: number,
): Uint8Array {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('PipelineService: createFramebuffer null');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  const raw = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  return raw;
}

/** Convert one IEEE-754 binary16 value into an unsigned normalized sample. */
export function halfFloatToUint16(value: number): number {
  const sign = (value & 0x8000) !== 0;
  const exponent = (value >>> 10) & 0x1f;
  const fraction = value & 0x03ff;
  let decoded: number;
  if (exponent === 0) decoded = fraction * (2 ** -24);
  else if (exponent === 0x1f) decoded = fraction === 0 ? Number.POSITIVE_INFINITY : Number.NaN;
  else decoded = (1 + fraction / 1024) * (2 ** (exponent - 15));
  if (sign) decoded = -decoded;
  if (!Number.isFinite(decoded)) return decoded > 0 ? 65535 : 0;
  return Math.round(Math.max(0, Math.min(1, decoded)) * 65535);
}

/** Reads an RGBA16F texture without routing through ImageData or a canvas. */
export function readPixels16(
  gl: WebGL2RenderingContext, texture: WebGLTexture, width: number, height: number,
): Uint16Array {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('PipelineService: createFramebuffer null');
  const pixels = new Uint16Array(width * height * 4);
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(
        `PipelineService: RGBA16F readback framebuffer incomplete (status 0x${status.toString(16)})`,
      );
    }

    const implementationFormat = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number;
    const implementationType = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;
    const useHalfFloat = implementationFormat === gl.RGBA && implementationType === gl.HALF_FLOAT;
    const samplesPerRow = width * 4;
    const bytesPerSample = useHalfFloat ? Uint16Array.BYTES_PER_ELEMENT : Float32Array.BYTES_PER_ELEMENT;
    // Bound transient readback memory independently of full image height.
    const rowsPerChunk = Math.max(1, Math.min(
      height, Math.floor((4 * 1024 * 1024) / Math.max(1, samplesPerRow * bytesPerSample)),
    ));
    const chunkSamples = rowsPerChunk * samplesPerRow;
    const scratch = useHalfFloat
      ? new Uint16Array(chunkSamples)
      : new Float32Array(chunkSamples);

    for (let y = 0; y < height; y += rowsPerChunk) {
      const rowCount = Math.min(rowsPerChunk, height - y);
      const sampleCount = rowCount * samplesPerRow;
      if (useHalfFloat) {
        const half = scratch as Uint16Array;
        gl.readPixels(0, y, width, rowCount, gl.RGBA, gl.HALF_FLOAT, half);
        assertReadPixelsSucceeded(gl, 'HALF_FLOAT', y);
        const offset = y * samplesPerRow;
        for (let i = 0; i < sampleCount; i++) pixels[offset + i] = halfFloatToUint16(half[i]);
      } else {
        // EXT_color_buffer_half_float guarantees RGBA/FLOAT readback even on
        // implementations that don't expose RGBA/HALF_FLOAT as their pair.
        const floats = scratch as Float32Array;
        gl.readPixels(0, y, width, rowCount, gl.RGBA, gl.FLOAT, floats);
        assertReadPixelsSucceeded(gl, 'FLOAT', y);
        const offset = y * samplesPerRow;
        for (let i = 0; i < sampleCount; i++) pixels[offset + i] = floatToUint16(floats[i]);
      }
    }
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
  }
  return pixels;
}

function floatToUint16(value: number): number {
  if (!Number.isFinite(value)) return value > 0 ? 65535 : 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 65535);
}

function assertReadPixelsSucceeded(
  gl: WebGL2RenderingContext, readType: 'HALF_FLOAT' | 'FLOAT', row: number,
): void {
  const glError = gl.getError();
  if (glError !== gl.NO_ERROR) {
    throw new Error(
      `PipelineService: ${readType} readPixels failed at row ${row} (GL error 0x${glError.toString(16)})`,
    );
  }
}

async function pixelsToBlob(
  canvas: OffscreenCanvas, pixels: Uint8Array,
  geom: { width: number; height: number },
  options: { type?: string; quality?: number; maxDim?: number },
): Promise<Blob> {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('PipelineService: blob canvas 2d unavailable');
  // Pixels arrive in ImageData order (readPixelsImageOrder) — copy into a
  // Uint8ClampedArray over a fresh ArrayBuffer for the ImageData constructor.
  const { width, height } = geom;
  const clamped = new Uint8ClampedArray(pixels.byteLength);
  clamped.set(pixels);
  const data = new ImageData(clamped, width, height);
  ctx.putImageData(data, 0, 0);

  // Thumbnail consumers encode small: downscale before encoding so caches
  // hold thumb-sized JPEGs instead of full render resolution.
  const maxDim = options.maxDim;
  if (maxDim && Math.max(width, height) > maxDim) {
    const scale = maxDim / Math.max(width, height);
    const outW = Math.max(1, Math.round(width * scale));
    const outH = Math.max(1, Math.round(height * scale));
    const small = new OffscreenCanvas(outW, outH);
    const smallCtx = small.getContext('2d');
    if (smallCtx) {
      smallCtx.drawImage(canvas, 0, 0, outW, outH);
      return small.convertToBlob({
        type: options.type ?? 'image/jpeg',
        quality: options.quality ?? 0.85,
      });
    }
  }

  return canvas.convertToBlob({
    type: options.type ?? 'image/jpeg',
    quality: options.quality ?? 0.85,
  });
}
