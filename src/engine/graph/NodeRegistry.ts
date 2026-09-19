import type { NodeKindSpec, NodeCategory } from './types';

/**
 * Public registry for node-kinds. The compiler and executor resolve
 * `RenderNode.kind` strings through this. Plugin entry-point — first-party
 * adjustments (Tone, ToneCurve, ...) register at module load, and Phase 5h
 * custom GLSL plugins will register via the same surface.
 *
 * The class is exported so tests can spin up isolated registries; the
 * module-level singleton `nodeRegistry` is what production code uses.
 */
export class NodeRegistry {
  private readonly kinds = new Map<string, NodeKindSpec>();

  /** Register a node-kind. Throws if `spec.kind` is already taken. */
  register(spec: NodeKindSpec): void {
    if (this.kinds.has(spec.kind)) {
      throw new Error(`NodeRegistry: kind '${spec.kind}' already registered`);
    }
    validateSpec(spec);
    this.kinds.set(spec.kind, spec);
  }

  /** Replace an existing kind. Used by test helpers + hot-reload. */
  replace(spec: NodeKindSpec): void {
    validateSpec(spec);
    this.kinds.set(spec.kind, spec);
  }

  unregister(kind: string): void {
    this.kinds.delete(kind);
  }

  get(kind: string): NodeKindSpec | undefined {
    return this.kinds.get(kind);
  }

  /** Lookup or throw — for code paths that should never see an unknown kind. */
  require(kind: string): NodeKindSpec {
    const spec = this.kinds.get(kind);
    if (!spec) throw new Error(`NodeRegistry: kind '${kind}' is not registered`);
    return spec;
  }

  has(kind: string): boolean {
    return this.kinds.has(kind);
  }

  list(category?: NodeCategory): NodeKindSpec[] {
    const all = Array.from(this.kinds.values());
    return category ? all.filter((s) => s.category === category) : all;
  }

  /** Drop everything. Test-only — production code never calls this. */
  clear(): void {
    this.kinds.clear();
  }
}

function validateSpec(spec: NodeKindSpec): void {
  if (!spec.kind || typeof spec.kind !== 'string') {
    throw new Error('NodeRegistry: spec.kind must be a non-empty string');
  }
  const portIds = new Set<string>();
  for (const p of [...spec.inputPorts, ...spec.outputPorts]) {
    if (portIds.has(p.id)) {
      throw new Error(`NodeRegistry: duplicate port id '${p.id}' on kind '${spec.kind}'`);
    }
    portIds.add(p.id);
  }
  // Encoder and tap nodes terminate a branch — they consume but don't produce
  // a downstream chain. Everything else must have at least one output.
  const SINKS: ReadonlySet<typeof spec.category> = new Set(['encoder', 'tap']);
  if (spec.outputPorts.length === 0 && !SINKS.has(spec.category)) {
    throw new Error(`NodeRegistry: kind '${spec.kind}' (${spec.category}) needs at least one output port`);
  }
  if (spec.isAsync && !spec.prepare) {
    throw new Error(`NodeRegistry: kind '${spec.kind}' declares isAsync=true but provides no prepare() hook`);
  }
}

/** Module-level singleton used by production code paths. */
export const nodeRegistry = new NodeRegistry();
