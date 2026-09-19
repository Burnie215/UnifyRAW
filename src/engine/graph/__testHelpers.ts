/**
 * Test-only WebGL2 stub. jsdom (vitest's default environment) doesn't ship
 * WebGL, so we fake the minimal surface our graph code touches.
 *
 * Records every call into `.calls` for assertions, and returns deterministic
 * dummy objects (numeric ids) for resources so the code under test can keep
 * them in maps without crashing.
 *
 * Only used in unit tests; do not import in production code.
 */

export interface GlCall {
  op: string;
  args: unknown[];
}

export interface FakeGlOptions {
  /** Return value for getShaderParameter(COMPILE_STATUS) etc. Defaults to true. */
  compileSuccess?: boolean;
  /** Return value for getProgramParameter(LINK_STATUS). Defaults to true. */
  linkSuccess?: boolean;
  /** Status returned by checkFramebufferStatus. */
  framebufferStatus?: number;
  /** Error returned by getError after readPixels. */
  glError?: number;
  /** Whether EXT_color_buffer_half_float is exposed. */
  halfFloatExtension?: boolean;
  /** IMPLEMENTATION_COLOR_READ_FORMAT/TYPE values. */
  implementationReadFormat?: number;
  implementationReadType?: number;
  /** Optional hook to populate a readPixels destination. */
  readPixelsFill?: (args: unknown[]) => void;
}

let resourceCounter = 0;
function nextResource(label: string): { __id: number; __label: string } {
  return { __id: ++resourceCounter, __label: label };
}

export class FakeGl {
  readonly calls: GlCall[] = [];
  private readonly opts: Required<FakeGlOptions>;

  // GL constants we use (rough numeric stand-ins; only equality matters).
  readonly VERTEX_SHADER = 0x8B31;
  readonly FRAGMENT_SHADER = 0x8B30;
  readonly COMPILE_STATUS = 0x8B81;
  readonly LINK_STATUS = 0x8B82;
  readonly TEXTURE_2D = 0x0DE1;
  readonly TEXTURE0 = 0x84C0;
  readonly TEXTURE_WRAP_S = 0x2802;
  readonly TEXTURE_WRAP_T = 0x2803;
  readonly TEXTURE_MIN_FILTER = 0x2801;
  readonly TEXTURE_MAG_FILTER = 0x2800;
  readonly CLAMP_TO_EDGE = 0x812F;
  readonly LINEAR = 0x2601;
  readonly RGBA = 0x1908;
  readonly RGBA8 = 0x8058;
  readonly RGBA16F = 0x881A;
  readonly UNSIGNED_BYTE = 0x1401;
  readonly HALF_FLOAT = 0x140B;
  readonly FRAMEBUFFER = 0x8D40;
  readonly FRAMEBUFFER_COMPLETE = 0x8CD5;
  readonly COLOR_ATTACHMENT0 = 0x8CE0;
  readonly ARRAY_BUFFER = 0x8892;
  readonly STATIC_DRAW = 0x88E4;
  readonly FLOAT = 0x1406;
  readonly TRIANGLE_STRIP = 0x0005;
  readonly BLEND = 0x0BE2;
  readonly DEPTH_TEST = 0x0B71;
  readonly NO_ERROR = 0;
  readonly IMPLEMENTATION_COLOR_READ_TYPE = 0x8B9A;
  readonly IMPLEMENTATION_COLOR_READ_FORMAT = 0x8B9B;

  constructor(opts: FakeGlOptions = {}) {
    this.opts = {
      compileSuccess: true,
      linkSuccess: true,
      framebufferStatus: this.FRAMEBUFFER_COMPLETE,
      glError: this.NO_ERROR,
      halfFloatExtension: true,
      implementationReadFormat: this.RGBA,
      implementationReadType: this.HALF_FLOAT,
      readPixelsFill: () => {},
      ...opts,
    };
  }

  private record(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }

  // Programs / shaders
  createShader(type: number) { this.record('createShader', type); return nextResource('shader'); }
  shaderSource(s: unknown, src: string) { this.record('shaderSource', s, src); }
  compileShader(s: unknown) { this.record('compileShader', s); }
  getShaderParameter(_s: unknown, _p: number) { return this.opts.compileSuccess; }
  getShaderInfoLog(_s: unknown) { return ''; }
  deleteShader(s: unknown) { this.record('deleteShader', s); }
  createProgram() { this.record('createProgram'); return nextResource('program'); }
  attachShader(p: unknown, s: unknown) { this.record('attachShader', p, s); }
  detachShader(p: unknown, s: unknown) { this.record('detachShader', p, s); }
  bindAttribLocation(p: unknown, i: number, n: string) { this.record('bindAttribLocation', p, i, n); }
  linkProgram(p: unknown) { this.record('linkProgram', p); }
  getProgramParameter(_p: unknown, _q: number) { return this.opts.linkSuccess; }
  getProgramInfoLog(_p: unknown) { return ''; }
  deleteProgram(p: unknown) { this.record('deleteProgram', p); }
  useProgram(p: unknown) { this.record('useProgram', p); }
  getUniformLocation(p: unknown, n: string) { this.record('getUniformLocation', p, n); return nextResource('uniform'); }
  uniform1i(loc: unknown, v: number) { this.record('uniform1i', loc, v); }
  uniform1f(loc: unknown, v: number) { this.record('uniform1f', loc, v); }
  uniform2f(loc: unknown, x: number, y: number) { this.record('uniform2f', loc, x, y); }

  // Buffers / VAO
  createBuffer() { this.record('createBuffer'); return nextResource('buffer'); }
  bindBuffer(t: number, b: unknown) { this.record('bindBuffer', t, b); }
  bufferData(t: number, d: unknown, u: number) { this.record('bufferData', t, d, u); }
  createVertexArray() { this.record('createVertexArray'); return nextResource('vao'); }
  bindVertexArray(v: unknown) { this.record('bindVertexArray', v); }
  enableVertexAttribArray(i: number) { this.record('enableVertexAttribArray', i); }
  vertexAttribPointer(i: number, n: number, t: number, no: boolean, s: number, o: number) {
    this.record('vertexAttribPointer', i, n, t, no, s, o);
  }
  deleteBuffer(b: unknown) { this.record('deleteBuffer', b); }
  deleteVertexArray(v: unknown) { this.record('deleteVertexArray', v); }

  // Textures
  createTexture() { this.record('createTexture'); return nextResource('texture'); }
  bindTexture(t: number, tex: unknown) { this.record('bindTexture', t, tex); }
  texParameteri(t: number, p: number, v: number) { this.record('texParameteri', t, p, v); }
  texImage2D(...args: unknown[]) { this.record('texImage2D', ...args); }
  activeTexture(u: number) { this.record('activeTexture', u); }
  deleteTexture(t: unknown) { this.record('deleteTexture', t); }

  // Framebuffer
  createFramebuffer() { this.record('createFramebuffer'); return nextResource('fbo'); }
  bindFramebuffer(t: number, f: unknown) { this.record('bindFramebuffer', t, f); }
  framebufferTexture2D(...args: unknown[]) { this.record('framebufferTexture2D', ...args); }
  checkFramebufferStatus(t: number) {
    this.record('checkFramebufferStatus', t);
    return this.opts.framebufferStatus;
  }
  deleteFramebuffer(f: unknown) { this.record('deleteFramebuffer', f); }

  // Capabilities + readback
  getExtension(name: string) {
    this.record('getExtension', name);
    return this.opts.halfFloatExtension ? {} : null;
  }
  getParameter(parameter: number) {
    this.record('getParameter', parameter);
    if (parameter === this.IMPLEMENTATION_COLOR_READ_FORMAT) return this.opts.implementationReadFormat;
    if (parameter === this.IMPLEMENTATION_COLOR_READ_TYPE) return this.opts.implementationReadType;
    return null;
  }
  readPixels(...args: unknown[]) {
    this.record('readPixels', ...args);
    this.opts.readPixelsFill(args);
  }
  getError() { this.record('getError'); return this.opts.glError; }

  // Draw / state
  viewport(x: number, y: number, w: number, h: number) { this.record('viewport', x, y, w, h); }
  enable(c: number) { this.record('enable', c); }
  disable(c: number) { this.record('disable', c); }
  drawArrays(m: number, f: number, c: number) { this.record('drawArrays', m, f, c); }

  /** Returns indices in `calls` where op matches — handy for assertion. */
  findCalls(op: string): GlCall[] {
    return this.calls.filter((c) => c.op === op);
  }
}

/** Type-cast helper so test code can pass `FakeGl` where WebGL2 is expected. */
export function asGl(fake: FakeGl): WebGL2RenderingContext {
  return fake as unknown as WebGL2RenderingContext;
}
