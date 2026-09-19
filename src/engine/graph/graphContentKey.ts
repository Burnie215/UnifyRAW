/**
 * A graph's content as one string: nodes (id, kind, params), wiring and
 * output. Not the positions, not the revision, and not the source node's
 * geometry, which belongs to whoever renders rather than to the edit.
 *
 * Two questions are asked of it. `graphPersistence` wants to know whether a
 * graph says anything the document does not already say. `documentGraph`
 * needs a plan-cache identity for a stored graph that changes with its
 * params, because a stored graph carries them baked into its nodes.
 */
import { KIND_IMAGE_BITMAP_SOURCE, KIND_RAW16_SOURCE } from './sources';
import { KIND_CUSTOM_LUT } from './lutKinds';
import type { RenderGraph } from './types';

const GEOMETRY_KINDS = new Set<string>([KIND_IMAGE_BITMAP_SOURCE, KIND_RAW16_SOURCE]);

/**
 * Large JSON arrays are shared between all graphs hydrated from one document
 * revision. Hash and freeze them once per payload object: `storedGraphFor`
 * rebuilds the surrounding graph for every render target, but deliberately
 * keeps the authored params (and therefore the samples array) by reference.
 *
 * Freezing makes the identity cache a checked invariant rather than an
 * assumption about callers. Typed arrays and other objects cannot use it:
 * they stay mutable and are therefore serialized afresh on every call. A
 * WeakMap keeps neither documents nor their history alive.
 */
const LARGE_PARAM_CONTENT_KEYS = new WeakMap<object, string>();

export function graphContentKey(graph: RenderGraph): string {
  return contentKey(graph, false);
}

function contentKey(graph: RenderGraph, compactLargeParams: boolean): string {
  const nodes = [...graph.nodes.values()]
    .map((n) => {
      let params = (n.params && typeof n.params === 'object')
        ? { ...(n.params as Record<string, unknown>) }
        : n.params;
      if (GEOMETRY_KINDS.has(n.kind) && params && typeof params === 'object') {
        const p = params as Record<string, unknown>;
        delete p.width; delete p.height; delete p.pixelRatio;
      }
      if (compactLargeParams && n.kind === KIND_CUSTOM_LUT && params && typeof params === 'object') {
        const samples = (params as Record<string, unknown>).samples;
        if (samples && typeof samples === 'object') {
          params = {
            ...(params as Record<string, unknown>),
            samples: { contentKey: largeParamContentKey(samples) },
          };
        }
      }
      return { id: n.id, kind: n.kind, params };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = graph.edges
    .map((e) => `${e.from.node}:${e.from.port}->${e.to.node}:${e.to.port}`)
    .sort();
  return JSON.stringify({ nodes, edges, output: graph.output });
}

/**
 * FNV-1a (32 bit) over the graph's plan-relevant content.
 *
 * `graphContentKey` intentionally retains the full values because graph
 * persistence uses it as an equality key. The plan-cache variant replaces an
 * inline LUT's ~108k values with a cached length-qualified compound digest.
 * The compound has two independent 32-bit components so it does not insert
 * another 32-bit collision bottleneck ahead of the cache's existing final
 * FNV-1a key.
 */
export function graphContentHash(graph: RenderGraph): string {
  return fnv1a32(contentKey(graph, true));
}

function largeParamContentKey(payload: object): string {
  const cacheable = isPlainArray(payload);
  if (cacheable && Object.isFrozen(payload)) {
    const cached = LARGE_PARAM_CONTENT_KEYS.get(payload);
    if (cached !== undefined) return cached;
  }
  const json = JSON.stringify(payload);
  const key = `${json.length}:${compoundDigest64(json)}`;
  if (cacheable) {
    // Only publish a cache entry after both serialization and freezing have
    // succeeded. A hostile Proxy can reject Object.freeze; it remains on the
    // safe, uncached path just like every mutable ArrayBuffer view.
    try {
      Object.freeze(payload);
    } catch {
      return key;
    }
    if (Object.isFrozen(payload)) LARGE_PARAM_CONTENT_KEYS.set(payload, key);
  }
  return key;
}

function isPlainArray(value: object): value is unknown[] {
  return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
}

/** FNV-1a plus Jenkins one-at-a-time, accumulated together in one scan. */
function compoundDigest64(key: string): string {
  let fnv = 0x811c9dc5;
  let jenkins = 0;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    fnv ^= code;
    fnv = Math.imul(fnv, 0x01000193);
    jenkins += code;
    jenkins += jenkins << 10;
    jenkins ^= jenkins >>> 6;
  }
  jenkins += jenkins << 3;
  jenkins ^= jenkins >>> 11;
  jenkins += jenkins << 15;
  return `${hex32(fnv)}${hex32(jenkins)}`;
}

function fnv1a32(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hex32(hash);
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
