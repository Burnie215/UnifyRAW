import type { NodeKindSpec } from './types';

/**
 * Default vertex shader for full-screen quad passes. Nodes can override via
 * NodeKindSpec.vertexShader, but the overwhelming majority of adjustment
 * passes share this single shape.
 */
export const DEFAULT_VERTEX_SHADER = `#version 300 es
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
  v_texCoord = a_texCoord;
}`;

export class ProgramCompileError extends Error {
  readonly kind: string;
  readonly shaderType: 'vertex' | 'fragment' | 'link';
  readonly log: string;

  constructor(kind: string, shaderType: 'vertex' | 'fragment' | 'link', log: string) {
    super(`Program compile failed for kind '${kind}' (${shaderType}): ${log}`);
    this.name = 'ProgramCompileError';
    this.kind = kind;
    this.shaderType = shaderType;
    this.log = log;
  }
}

/**
 * Compiles and caches WebGL programs per NodeKindSpec. The cache key is
 * the kind name — assumes a kind's shader is immutable for the lifetime of
 * the cache instance. Hot-reload during dev clears the cache.
 *
 * Nodes without a fragment shader (source / pass-through tap / encoder)
 * are absent from the cache; getProgram() returns undefined.
 */
export class ProgramCache {
  private readonly gl: WebGL2RenderingContext;
  private readonly programs = new Map<string, WebGLProgram>();
  private readonly uniformLocations = new Map<string, Map<string, WebGLUniformLocation>>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** Returns the cached or freshly compiled program, or undefined if the
   *  kind has no fragment shader (source / passthrough). */
  getOrCompile(spec: NodeKindSpec): WebGLProgram | undefined {
    if (!spec.fragmentShader) return undefined;
    const cached = this.programs.get(spec.kind);
    if (cached) return cached;

    const program = this.compile(
      spec.kind,
      spec.vertexShader ?? DEFAULT_VERTEX_SHADER,
      spec.fragmentShader,
    );
    this.programs.set(spec.kind, program);
    return program;
  }

  /** Looks up (and lazily caches) a uniform location for a given kind. */
  getUniformLocation(spec: NodeKindSpec, name: string): WebGLUniformLocation | null {
    const program = this.getOrCompile(spec);
    if (!program) return null;
    let kindLocs = this.uniformLocations.get(spec.kind);
    if (!kindLocs) {
      kindLocs = new Map();
      this.uniformLocations.set(spec.kind, kindLocs);
    }
    if (kindLocs.has(name)) return kindLocs.get(name) ?? null;
    const loc = this.gl.getUniformLocation(program, name);
    kindLocs.set(name, loc as WebGLUniformLocation);
    return loc;
  }

  size(): number {
    return this.programs.size;
  }

  /** Release all GPU resources. Test helper + hot-reload. */
  clear(): void {
    for (const program of this.programs.values()) {
      this.gl.deleteProgram(program);
    }
    this.programs.clear();
    this.uniformLocations.clear();
  }

  private compile(kind: string, vsSource: string, fsSource: string): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(kind, 'vertex', gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(kind, 'fragment', gl.FRAGMENT_SHADER, fsSource);

    const program = gl.createProgram();
    if (!program) throw new ProgramCompileError(kind, 'link', 'gl.createProgram returned null');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, 'a_position');
    gl.bindAttribLocation(program, 1, 'a_texCoord');
    gl.linkProgram(program);

    // Shaders can be detached + deleted once linked — frees up driver memory.
    gl.detachShader(program, vs);
    gl.detachShader(program, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '<no log>';
      gl.deleteProgram(program);
      throw new ProgramCompileError(kind, 'link', log);
    }
    return program;
  }

  private compileShader(kind: string, which: 'vertex' | 'fragment', type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) throw new ProgramCompileError(kind, which, 'gl.createShader returned null');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? '<no log>';
      gl.deleteShader(shader);
      throw new ProgramCompileError(kind, which, log);
    }
    return shader;
  }
}
