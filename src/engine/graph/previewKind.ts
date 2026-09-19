/**
 * User-placeable preview-tap node. Same shape as the compiler-internal
 * `__tap` (passthrough color in→out, either color-space) but visible in
 * the node library so users can drop one behind any pass to render a
 * thumbnail of the pipeline state at that point.
 *
 * The compiler treats this just like the internal tap (own segment, FBO
 * not recycled). The preview render path renders one sub-graph per
 * preview node and binds the resulting bitmap to the node body — see
 * `usePreviewTapRenderer`.
 */
import type { NodeKindSpec } from './types';
import type { NodeRegistry } from './NodeRegistry';

export const KIND_PREVIEW = 'preview';

export type PreviewParams = Record<string, never>;

const previewKind: NodeKindSpec<PreviewParams> = {
  kind: KIND_PREVIEW,
  category: 'tap',
  userPlaceable: true,
  inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
  outputPorts: [{ id: 'out', type: 'color', space: 'either' }],
  paramSchema: {
    type: 'object',
    properties: {},
  },
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: () => false,
  isAsync: false,
};

/** Register the preview tap kind on a registry. Idempotent via replace. */
export function registerBuiltinPreviewKind(registry: NodeRegistry): void {
  registry.replace(previewKind);
}
