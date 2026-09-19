import type { CompiledPlan, FboFormat, Geometry } from './types';

export interface PoolFbo {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  format: FboFormat;
  geometry: Geometry;
}

export interface SegmentPool {
  /** Segment index in CompiledPlan.segments. */
  segmentIndex: number;
  /** Slot FBOs — count is decided per execute by the runtime allocator
   *  (liveness-based; fan-out needs more than a ping-pong pair). */
  fbos: PoolFbo[];
}

/**
 * Allocates and manages FBOs per segment. Slot counts come from the
 * executor's runtime allocation (computeRuntimeFboMap): a straight chain
 * needs 2 slots (ping-pong), fan-out topologies need more, fully-skipped
 * segments (e.g. tap nodes) need none.
 *
 * Allocation happens eagerly in build(); release() frees everything. The
 * pool is single-use — for plan changes, build a new one (or call release
 * + rebuild).
 */
export class FboPool {
  private readonly gl: WebGL2RenderingContext;
  private readonly pools: SegmentPool[] = [];
  /** node id -> segment pool, set during build for fast lookup at execute. */
  private readonly nodeSegment = new Map<string, number>();
  /** Structural identity of the current allocation (formats, geometries,
   *  slot counts). Same structure → GL objects are reused across builds. */
  private structure: string | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /**
   * Allocate `slotCounts[i]` FBOs for segment i of the plan.
   *
   * Reuses the existing GL framebuffers/textures when the segment structure
   * is unchanged (the per-frame case during slider drags): every slot a pass
   * writes is a full-viewport draw, so stale texels never survive into a
   * read. Only the node→segment lookup is refreshed.
   */
  build(plan: CompiledPlan, slotCounts: number[]): void {
    const structure = plan.segments
      .map((s, i) => {
        const g = s.geometry;
        return `${s.fboFormat}:${g.width}x${g.height}:${slotCounts[i] ?? 0}`;
      })
      .join('|');

    if (structure === this.structure) {
      this.nodeSegment.clear();
      for (let i = 0; i < plan.segments.length; i++) {
        for (const nodeId of plan.segments[i].nodes) this.nodeSegment.set(nodeId, i);
      }
      return;
    }

    this.release();
    this.structure = structure;
    for (let i = 0; i < plan.segments.length; i++) {
      const segment = plan.segments[i];
      const count = slotCounts[i] ?? 0;
      const fbos: PoolFbo[] = [];
      this.pools.push({ segmentIndex: i, fbos });
      try {
        for (let s = 0; s < count; s++) {
          fbos.push(this.createFbo(segment.geometry, segment.fboFormat));
        }
      } catch (error) {
        this.release();
        throw error;
      }
      for (const nodeId of segment.nodes) {
        this.nodeSegment.set(nodeId, i);
      }
    }
  }

  /** Look up the FBO slot for a node's output write target. */
  fboForNode(nodeId: string, poolIndex: number): PoolFbo {
    const segIdx = this.nodeSegment.get(nodeId);
    if (segIdx === undefined) throw new Error(`FboPool: node '${nodeId}' has no segment`);
    const pool = this.pools[segIdx];
    const slot = pool.fbos[poolIndex];
    if (!slot) throw new Error(`FboPool: segment ${segIdx} has no slot ${poolIndex}`);
    return slot;
  }

  segmentCount(): number {
    return this.pools.length;
  }

  release(): void {
    const gl = this.gl;
    for (const pool of this.pools) {
      for (const fbo of pool.fbos) {
        gl.deleteFramebuffer(fbo.framebuffer);
        gl.deleteTexture(fbo.texture);
      }
    }
    this.pools.length = 0;
    this.nodeSegment.clear();
    this.structure = null;
  }

  private createFbo(geometry: Geometry, format: FboFormat): PoolFbo {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('FboPool: gl.createTexture returned null');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    if (format === 'rgba16f') {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA16F, geometry.width, geometry.height, 0,
        gl.RGBA, gl.HALF_FLOAT, null,
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8, geometry.width, geometry.height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null,
      );
    }

    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      gl.deleteTexture(texture);
      throw new Error('FboPool: gl.createFramebuffer returned null');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (format === 'rgba16f') {
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(framebuffer);
        gl.deleteTexture(texture);
        throw new Error(
          `FboPool: RGBA16F framebuffer incomplete (status 0x${status.toString(16)})`,
        );
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return { framebuffer, texture, format, geometry };
  }
}
