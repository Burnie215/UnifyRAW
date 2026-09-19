import type { CompiledPlan, DerivedTextureSpec, FboBinding, RenderNode } from './types';
import type { NodeRegistry } from './NodeRegistry';
import { ProgramCache } from './ProgramCache';
import { FboPool, type PoolFbo } from './FboPool';

export class ExecuteError extends Error {
  readonly nodeId?: string;

  constructor(message: string, nodeId?: string) {
    super(message);
    this.name = 'ExecuteError';
    this.nodeId = nodeId;
  }
}

export interface ExecuteResult {
  /** Terminal output texture handle (reader extracts pixels). */
  outputTexture: WebGLTexture;
  /** label -> tap FBO texture. */
  taps: Map<string, WebGLTexture>;
}

/**
 * Runtime that executes a CompiledPlan against bound source data.
 *
 * Decoupled from the user's RenderGraph: all topology lives in the plan
 * (plan.augmentedNodes / plan.augmentedEdges). Per-node parameters may be
 * supplied via the `paramsByNode` argument to execute() — useful for slider
 * drags that update params without recompiling the plan.
 *
 * Lifecycle:
 *   1. new PipelineExecutor(gl, registry) — sets up quad VAO + caches
 *   2. bindExternalData(nodeId, data) per source node before each execute
 *   3. execute(plan, paramsByNode?) — awaits async deps, runs the plan
 *   4. release() — frees FBOs + programs
 */
export class PipelineExecutor {
  private readonly gl: WebGL2RenderingContext;
  private readonly registry: NodeRegistry;
  private readonly programs: ProgramCache;
  private readonly fbos: FboPool;
  private readonly externalData = new Map<string, unknown>();
  /** (nodeId, sampler name) -> GL texture reused across renders, re-uploaded
   *  whenever derivedTextures() returns fresh data (cheap; same texture
   *  handle, only the pixels change). */
  private readonly derivedTextures = new Map<string, WebGLTexture>();
  private quadVao: WebGLVertexArrayObject | null = null;
  private quadBuffer: WebGLBuffer | null = null;

  constructor(gl: WebGL2RenderingContext, registry: NodeRegistry) {
    this.gl = gl;
    this.registry = registry;
    this.programs = new ProgramCache(gl);
    this.fbos = new FboPool(gl);
    this.initQuad();
  }

  /** Provide source pixel data for a node before execute(). */
  bindExternalData(nodeId: string, data: unknown): void {
    this.externalData.set(nodeId, data);
  }

  clearExternalData(): void {
    this.externalData.clear();
  }

  release(): void {
    this.programs.clear();
    this.fbos.release();
    for (const tex of this.derivedTextures.values()) {
      this.gl.deleteTexture(tex);
    }
    this.derivedTextures.clear();
    if (this.quadVao) {
      this.gl.deleteVertexArray(this.quadVao);
      this.quadVao = null;
    }
    if (this.quadBuffer) {
      this.gl.deleteBuffer(this.quadBuffer);
      this.quadBuffer = null;
    }
  }

  async execute(plan: CompiledPlan, paramsByNode?: Map<string, unknown>): Promise<ExecuteResult> {
    // 1. Await async prepare() — any AI inference / cloud fetch must be ready.
    for (const [nodeId, promise] of plan.asyncDependencies) {
      try {
        await promise;
      } catch (e) {
        const cause = e instanceof Error ? e.message : String(e);
        throw new ExecuteError(`async prepare() failed for node '${nodeId}': ${cause}`, nodeId);
      }
    }

    // 2. Pre-compute predecessor lookups from augmented edges (avoids
    //    O(n*m) per-node scans during the render loop). `byNode` drives
    //    primary input + identity-skip; `byPort` adds secondary samplers
    //    for multi-input kinds (Compositor, Mask).
    const predecessorByNode = buildPredecessorIndex(plan);
    const secondaryByPort = buildSecondaryPredecessorIndex(plan);

    // 3. Identity-skip is a per-execute decision: paramsByNode overrides can
    //    flip nodes from identity to active (or vice versa) without forcing
    //    a recompile. Re-evaluate with the effective params here.
    const effectiveSkips = computeEffectiveSkips(plan, paramsByNode, this.registry);
    // A requested terminal format is an observable output contract, not an
    // optimisation hint. An identity-skipped shader terminal could otherwise
    // hand its predecessor texture to the caller without ever writing the
    // requested FBO format (notably an RGBA8 texture to renderToPixels16).
    const terminalNode = plan.augmentedNodes.get(plan.output);
    if (plan.terminalFormat && terminalNode &&
        this.registry.require(terminalNode.kind).fragmentShader) {
      effectiveSkips.delete(plan.output);
    }

    // 4. Runtime slot allocation (liveness-based): a producer's FBO may only
    //    be recycled once every consumer of it has executed, and a node must
    //    never be assigned the slot it samples from. Straight chains resolve
    //    to the classic 2-slot ping-pong; fan-out topologies (layer chains
    //    sharing a source) allocate extra slots as needed.
    const { bindings: runtimeFbo, slotCounts } = computeRuntimeFboMap(
      plan, effectiveSkips, this.registry, predecessorByNode, secondaryByPort,
    );

    // 5. Allocate FBO pool with the slot counts the allocation decided on.
    this.fbos.build(plan, slotCounts);

    // 6. Walk nodes in execution order.
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    for (const nodeId of plan.topologicalOrder) {
      if (effectiveSkips.has(nodeId)) continue;
      this.runNode(plan, nodeId, paramsByNode, predecessorByNode, secondaryByPort, runtimeFbo, effectiveSkips);
    }

    // 7. Resolve terminal output texture + tap textures. If the terminal
    //    node itself was identity-skipped, walk back through the chain to
    //    the last node that actually wrote a FBO.
    const effectiveOutput = resolveEffectiveProducer(plan.output, effectiveSkips, predecessorByNode);
    const terminalBinding = runtimeFbo.get(effectiveOutput);
    if (!terminalBinding) {
      throw new ExecuteError(`output node '${effectiveOutput}' has no FBO binding`, effectiveOutput);
    }
    const outputFbo = this.fbos.fboForNode(effectiveOutput, terminalBinding.poolIndex);

    const taps = new Map<string, WebGLTexture>();
    for (const [label, tapNodeId] of plan.taps) {
      const effective = resolveEffectiveProducer(tapNodeId, effectiveSkips, predecessorByNode);
      const tapBinding = runtimeFbo.get(effective);
      if (!tapBinding) continue;
      const tapFbo = this.fbos.fboForNode(effective, tapBinding.poolIndex);
      taps.set(label, tapFbo.texture);
    }

    return { outputTexture: outputFbo.texture, taps };
  }

  // ─── Per-node executors ─────────────────────────────────────────

  private runNode(
    plan: CompiledPlan,
    nodeId: string,
    paramsByNode: Map<string, unknown> | undefined,
    predecessorByNode: Map<string, string>,
    secondaryByPort: Map<string, Map<string, string>>,
    runtimeFbo: Map<string, FboBinding>,
    effectiveSkips: Set<string>,
  ): void {
    const node = plan.augmentedNodes.get(nodeId);
    if (!node) throw new ExecuteError(`node '${nodeId}' not in augmented graph`, nodeId);
    const kind = this.registry.require(node.kind);
    const params = paramsByNode?.get(nodeId) ?? node.params;

    if (kind.category === 'source' || kind.category === 'decoder') {
      this.runSource(node, params, runtimeFbo);
      return;
    }
    if (kind.fragmentShader) {
      this.runShaderPass(node, params, predecessorByNode, secondaryByPort, runtimeFbo, effectiveSkips);
      return;
    }
    // Shaderless kinds (tap category) never reach here — they are always
    // in effectiveSkips, and output/tap resolution walks through them to
    // the producing node's FBO.
    throw new ExecuteError(
      `kind '${kind.kind}' has no fragmentShader and is not a source/tap`, node.id);
  }

  private runSource(node: RenderNode, params: unknown, runtimeFbo: Map<string, FboBinding>): void {
    const kind = this.registry.require(node.kind);
    const data = this.externalData.get(node.id);
    if (!data) {
      throw new ExecuteError(`source node '${node.id}' has no bound external data`, node.id);
    }
    if (!kind.uploadSource) {
      throw new ExecuteError(
        `kind '${kind.kind}' is ${kind.category} but provides no uploadSource hook`, node.id);
    }
    const binding = runtimeFbo.get(node.id);
    if (!binding) throw new ExecuteError(`source node '${node.id}' has no FBO binding`, node.id);
    const fbo = this.fbos.fboForNode(node.id, binding.poolIndex);
    kind.uploadSource(this.gl, fbo.texture, params, data);
  }

  private runShaderPass(
    node: RenderNode,
    params: unknown,
    predecessorByNode: Map<string, string>,
    secondaryByPort: Map<string, Map<string, string>>,
    runtimeFbo: Map<string, FboBinding>,
    effectiveSkips: Set<string>,
  ): void {
    const gl = this.gl;
    const kind = this.registry.require(node.kind);
    const program = this.programs.getOrCompile(kind);
    if (!program) {
      throw new ExecuteError(`kind '${kind.kind}' has no compiled program`, node.id);
    }

    const binding = runtimeFbo.get(node.id);
    if (!binding) throw new ExecuteError(`node '${node.id}' has no FBO binding`, node.id);
    const outputFbo = this.fbos.fboForNode(node.id, binding.poolIndex);

    const upstreamNodeId = resolveUpstream(node.id, effectiveSkips, predecessorByNode);
    if (!upstreamNodeId) {
      throw new ExecuteError(`node '${node.id}' has no resolvable predecessor`, node.id);
    }
    const upstreamBinding = runtimeFbo.get(upstreamNodeId);
    if (!upstreamBinding) {
      throw new ExecuteError(`upstream '${upstreamNodeId}' has no FBO binding`, upstreamNodeId);
    }
    const inputTexture = this.fbos.fboForNode(upstreamNodeId, upstreamBinding.poolIndex).texture;
    if (inputTexture === outputFbo.texture) {
      throw new ExecuteError(
        `feedback loop: node '${node.id}' would sample its own render target (input '${upstreamNodeId}')`,
        node.id,
      );
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo.framebuffer);
    gl.viewport(0, 0, outputFbo.geometry.width, outputFbo.geometry.height);
    gl.useProgram(program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTexture);
    const texLoc = this.programs.getUniformLocation(kind, 'u_texture');
    if (texLoc) gl.uniform1i(texLoc, 0);

    // Secondary inputs (multi-input kinds: Compositor, Mask, …). Each
    // input port other than 'in' becomes a sampler uniform named
    // `u_<portId>`. Bound to TEXTURE1.. before derived textures so derived
    // slot indices stay deterministic per-kind.
    const secondary = secondaryByPort.get(node.id);
    let nextSlot = 1;
    if (secondary) {
      for (const port of kind.inputPorts) {
        if (port.id === 'in') continue;
        const producerId = secondary.get(port.id);
        if (!producerId) continue; // optional port — skip if no edge
        // Identity-skipped producers hold no FBO — walk to the node whose
        // FBO actually carries their output (same rule as the primary input).
        const effProducer = resolveEffectiveProducer(producerId, effectiveSkips, predecessorByNode);
        const prodBinding = runtimeFbo.get(effProducer);
        if (!prodBinding) {
          throw new ExecuteError(
            `multi-input '${node.id}' port '${port.id}' producer '${effProducer}' has no FBO binding`,
            node.id,
          );
        }
        const tex = this.fbos.fboForNode(effProducer, prodBinding.poolIndex).texture;
        if (tex === outputFbo.texture) {
          throw new ExecuteError(
            `feedback loop: node '${node.id}' port '${port.id}' would sample its own render target`,
            node.id,
          );
        }
        gl.activeTexture(gl.TEXTURE0 + nextSlot);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const samplerName = `u_${port.id}`;
        const samplerLoc = this.programs.getUniformLocation(kind, samplerName);
        if (samplerLoc) gl.uniform1i(samplerLoc, nextSlot);
        nextSlot++;
      }
    }

    // Derived textures (e.g. ToneCurve LUT) — bound after secondary inputs.
    // The kind controls names + data via derivedTextures(); the executor
    // owns the GL handles and re-uploads pixels on every render so param
    // changes propagate.
    if (kind.derivedTextures) {
      const specs = kind.derivedTextures(params);
      for (let i = 0; i < specs.length; i++) {
        this.uploadAndBindDerived(node.id, specs[i], nextSlot - 1 + i);
        const samplerLoc = this.programs.getUniformLocation(kind, specs[i].name);
        if (samplerLoc) gl.uniform1i(samplerLoc, nextSlot + i);
      }
    }

    // u_resolution is bound automatically when the program declares it —
    // saves every neighbour-sampling kind from threading geometry through
    // its own bindUniforms.
    const resLoc = this.programs.getUniformLocation(kind, 'u_resolution');
    if (resLoc) gl.uniform2f(resLoc, outputFbo.geometry.width, outputFbo.geometry.height);

    if (kind.bindUniforms) {
      kind.bindUniforms(gl, program, params);
    }

    gl.bindVertexArray(this.quadVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private uploadAndBindDerived(nodeId: string, spec: DerivedTextureSpec, slot: number): void {
    const gl = this.gl;
    const key = `${nodeId}::${spec.name}`;
    let tex = this.derivedTextures.get(key);
    // Activate the target unit before ANY bindTexture — a bind on the
    // creation path would otherwise land on the currently active unit
    // (unit 0 = u_texture) and clobber the input binding for this draw.
    gl.activeTexture(gl.TEXTURE1 + slot);
    if (!tex) {
      const created = gl.createTexture();
      if (!created) throw new ExecuteError(`createTexture failed for derived '${spec.name}'`, nodeId);
      tex = created;
      this.derivedTextures.set(key, tex);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const { width, height, pixels } = spec.data;
    if (pixels instanceof Float32Array) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, pixels);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    }
  }

  // ─── Setup ──────────────────────────────────────────────────────

  private initQuad(): void {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('PipelineExecutor: gl.createVertexArray returned null');
    gl.bindVertexArray(vao);

    const buf = gl.createBuffer();
    if (!buf) throw new Error('PipelineExecutor: gl.createBuffer returned null');
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const verts = new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
       1,  1, 1, 1,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);

    gl.bindVertexArray(null);
    this.quadVao = vao;
    this.quadBuffer = buf;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function buildPredecessorIndex(plan: CompiledPlan): Map<string, string> {
  // Primary-input index: producer feeding `to.port === 'in'`. Drives
  // identity-skip walking + FBO inheritance for the main render chain.
  const out = new Map<string, string>();
  for (const edge of plan.augmentedEdges) {
    if (edge.to.port === 'in') {
      out.set(edge.to.node, edge.from.node);
    }
  }
  return out;
}

/**
 * Per-port predecessor index for multi-input kinds (Compositor, Mask, …).
 * Lookup: `byPort.get(nodeId)?.get(portId) === predecessorNodeId`.
 * Excludes the 'in' port (already covered by `buildPredecessorIndex`) so
 * the executor only iterates this map for *secondary* sampler bindings.
 */
function buildSecondaryPredecessorIndex(plan: CompiledPlan): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const edge of plan.augmentedEdges) {
    if (edge.to.port === 'in') continue;
    let inner = out.get(edge.to.node);
    if (!inner) { inner = new Map(); out.set(edge.to.node, inner); }
    inner.set(edge.to.port, edge.from.node);
  }
  return out;
}

function resolveUpstream(
  nodeId: string,
  effectiveSkips: Set<string>,
  predecessorByNode: Map<string, string>,
): string | null {
  let cursor = predecessorByNode.get(nodeId);
  while (cursor && effectiveSkips.has(cursor)) {
    cursor = predecessorByNode.get(cursor);
  }
  return cursor ?? null;
}

/**
 * Returns the id of the node whose FBO actually holds the output for
 * `nodeId`. If `nodeId` itself wrote (non-identity), that's the answer.
 * If it was identity-skipped, walks back through predecessors until a
 * non-skipped one is found. Source nodes always count as writers because
 * uploadSource() populates their FBO.
 */
function resolveEffectiveProducer(
  nodeId: string,
  effectiveSkips: Set<string>,
  predecessorByNode: Map<string, string>,
): string {
  let cursor: string | undefined = nodeId;
  while (cursor && effectiveSkips.has(cursor)) {
    cursor = predecessorByNode.get(cursor);
  }
  return cursor ?? nodeId;
}

/**
 * Re-evaluates `isIdentity` per node using the effective params (override
 * or graph-baked). Compile-time identitySkips reflects only graph.params;
 * paramsByNode overrides at execute time can flip the answer.
 *
 * Sources are never "skipped" — they always upload via uploadSource.
 */
function computeEffectiveSkips(
  plan: CompiledPlan,
  paramsByNode: Map<string, unknown> | undefined,
  registry: NodeRegistry,
): Set<string> {
  if (!paramsByNode || paramsByNode.size === 0) return plan.identitySkips;
  const out = new Set<string>();
  for (const [id, node] of plan.augmentedNodes) {
    const kind = registry.require(node.kind);
    if (kind.category === 'source' || kind.category === 'decoder') continue;
    // Taps are passthrough sinks — always skipped, params can't change that.
    if (kind.category === 'tap') {
      out.add(id);
      continue;
    }
    const params = paramsByNode.get(id) ?? node.params;
    try {
      if (kind.isIdentity(params)) out.add(id);
    } catch {
      // kind-impl bug — treat as non-identity, surfaces in rendering
    }
  }
  return out;
}

/**
 * Builds a runtime FBO map keyed by node id, walking the GLOBAL topological
 * order (the same order execute() runs nodes in) and allocating slots per
 * segment with liveness tracking:
 *
 *   - A slot is reusable once its current occupant has zero remaining
 *     consumers (all reads of that producer's output have executed).
 *   - A node is never assigned a slot occupied by one of its own inputs
 *     (would sample its own render target — a WebGL feedback loop).
 *   - The effective terminal output and all tap targets are pinned: their
 *     slots survive until execute() has read them back.
 *
 * Straight chains degenerate to the classic 2-slot ping-pong; fan-out
 * (e.g. layered documents sharing one source) grows the slot count as
 * needed. Returns the per-segment slot counts for FboPool.build().
 *
 * Geometry + format come from the segment spec — those are compile-time
 * invariants. Only the slot allocation is runtime.
 */
function computeRuntimeFboMap(
  plan: CompiledPlan,
  effectiveSkips: Set<string>,
  registry: NodeRegistry,
  predecessorByNode: Map<string, string>,
  secondaryByPort: Map<string, Map<string, string>>,
): { bindings: Map<string, FboBinding>; slotCounts: number[] } {
  const segOfNode = new Map<string, number>();
  for (let i = 0; i < plan.segments.length; i++) {
    for (const nodeId of plan.segments[i].nodes) segOfNode.set(nodeId, i);
  }

  const isActive = (nodeId: string): boolean => {
    const node = plan.augmentedNodes.get(nodeId);
    const kind = node ? registry.get(node.kind) : undefined;
    const isSource = kind?.category === 'source' || kind?.category === 'decoder';
    return isSource || !effectiveSkips.has(nodeId);
  };

  /** Unique effective producers this node samples (primary + secondary). */
  const effectiveInputsOf = (nodeId: string): Set<string> => {
    const inputs = new Set<string>();
    const primary = resolveUpstream(nodeId, effectiveSkips, predecessorByNode);
    if (primary) inputs.add(primary);
    const secondary = secondaryByPort.get(nodeId);
    if (secondary) {
      for (const producerId of secondary.values()) {
        inputs.add(resolveEffectiveProducer(producerId, effectiveSkips, predecessorByNode));
      }
    }
    return inputs;
  };

  // Pass 1: how many active consumers does each effective producer have?
  const consumersRemaining = new Map<string, number>();
  for (const nodeId of plan.topologicalOrder) {
    if (!isActive(nodeId)) continue;
    for (const p of effectiveInputsOf(nodeId)) {
      consumersRemaining.set(p, (consumersRemaining.get(p) ?? 0) + 1);
    }
  }

  // Terminal + tap textures are read back after the node walk — never recycle.
  const pinned = new Set<string>();
  pinned.add(resolveEffectiveProducer(plan.output, effectiveSkips, predecessorByNode));
  for (const tapNodeId of plan.taps.values()) {
    pinned.add(resolveEffectiveProducer(tapNodeId, effectiveSkips, predecessorByNode));
  }
  // Source slots are pinned too, because recycling one as a later pass's
  // render target is measurably broken. Reproducer (see
  // compat/layerStack.browser.test.ts): a masked adjustment layer under an
  // unmasked one put the mask source and the second compositor on the same
  // segment slot, and the rendered image came out as the mask itself — in the
  // browser test and on the editor's canvas alike.
  //
  // Why that happens at GL level is NOT established. The obvious candidate is
  // disproven: `uploadSource` re-specifies the slot's texture, but the
  // segment there is rgba8 like the upload, the framebuffer stays COMPLETE
  // and a later clear does land in it (measured). Pinning removes the whole
  // class for one extra FBO per source, which is why it is the fix here
  // rather than a narrower rule about compositors — an unexplained hazard is
  // not one to route around precisely.
  for (const [nodeId, node] of plan.augmentedNodes) {
    const category = registry.get(node.kind)?.category;
    if (category === 'source' || category === 'decoder') pinned.add(nodeId);
  }

  // Pass 2: allocate slots in execution order.
  const bindings = new Map<string, FboBinding>();
  const slotOccupant: (string | null)[][] = plan.segments.map(() => []);
  for (const nodeId of plan.topologicalOrder) {
    if (!isActive(nodeId)) continue;
    const segIdx = segOfNode.get(nodeId);
    if (segIdx === undefined) continue;
    const segment = plan.segments[segIdx];
    const inputs = effectiveInputsOf(nodeId);

    const slots = slotOccupant[segIdx];
    let chosen = -1;
    for (let s = 0; s < slots.length; s++) {
      const occ = slots[s];
      // Inputs of this node always have remaining >= 1 here (this node's
      // own consumption is decremented only after slot selection), so a
      // freeable slot can never hold one of its inputs.
      if (occ === null || (!pinned.has(occ) && (consumersRemaining.get(occ) ?? 0) === 0)) {
        chosen = s;
        break;
      }
    }
    if (chosen === -1) {
      chosen = slots.length;
      slots.push(null);
    }
    slots[chosen] = nodeId;
    bindings.set(nodeId, {
      poolIndex: chosen,
      format: segment.fboFormat,
      geometry: segment.geometry,
    });

    for (const p of inputs) {
      const r = consumersRemaining.get(p);
      if (r !== undefined) consumersRemaining.set(p, r - 1);
    }
  }

  return { bindings, slotCounts: slotOccupant.map((s) => s.length) };
}

export const __internals = {
  buildPredecessorIndex, buildSecondaryPredecessorIndex, resolveUpstream,
  resolveEffectiveProducer, computeEffectiveSkips, computeRuntimeFboMap,
};

// Re-export the FBO type for consumers that want to read pixels back later.
export type { PoolFbo };
