/**
 * Encoder nodes (Phase 5d).
 *
 * Encoders are terminal nodes — they consume the rendered output and
 * produce one or more encoded blobs as a side-effect on `execute()`.
 * They don't participate in the segment FBO chain; the compiler treats
 * them as render-sinks.
 *
 * Phase 5d ships `multiOutputEncoder`: a single execution renders the
 * upstream graph once and snapshots that result into multiple format
 * + ICC variants (JPEG sRGB, TIFF Adobe-RGB, PNG sRGB, …) in one pass.
 * Saves N-1 full pipeline runs vs. exporting each format separately.
 *
 * The actual encoded blobs are produced by the executor consuming the
 * encoder's params — `derivedBlobs(params, pixels)` returns the list.
 *
 * Not in the node library (no `userPlaceable`): the kind has no fragment
 * shader and the executor walks the whole topological order, so a placed
 * encoder throws mid-render. It stays registered so a stored graph that
 * already carries one hydrates instead of failing on an unknown kind. The
 * "Add Output" sub-control this header used to promise does not exist (F019).
 */
import type { NodeKindSpec, JsonSchema } from './types';
import type { NodeRegistry } from './NodeRegistry';

export const KIND_MULTI_OUTPUT_ENCODER = '__encoder.multiOutput';

export type EncoderFormat = 'jpeg' | 'png' | 'webp' | 'tiff';
export type EncoderColorSpace = 'srgb' | 'adobe-rgb' | 'display-p3' | 'prophoto' | 'rec2020';

export interface MultiOutputEncoderTarget {
  /** Filename suffix appended to the base export name. */
  suffix: string;
  format: EncoderFormat;
  colorSpace: EncoderColorSpace;
  /** 0..1 for lossy formats; ignored for png/tiff. */
  quality?: number;
}

export interface MultiOutputEncoderParams {
  targets: MultiOutputEncoderTarget[];
}

const targetSchema: JsonSchema = {
  type: 'object',
  properties: {
    suffix: { type: 'string', default: '' },
    format: { type: 'string', enum: ['jpeg', 'png', 'webp', 'tiff'], default: 'jpeg' },
    colorSpace: { type: 'string', enum: ['srgb', 'adobe-rgb', 'display-p3', 'prophoto', 'rec2020'], default: 'srgb' },
    quality: { type: 'number', minimum: 0, maximum: 1, default: 0.92 },
  },
  required: ['suffix', 'format', 'colorSpace'],
};

const multiOutputEncoderKind: NodeKindSpec<MultiOutputEncoderParams> = {
  kind: KIND_MULTI_OUTPUT_ENCODER,
  category: 'encoder',
  inputPorts: [{ id: 'in', type: 'color', space: 'either' }],
  outputPorts: [], // terminal — no downstream consumers
  paramSchema: {
    type: 'object',
    properties: {
      targets: {
        type: 'array',
        items: targetSchema,
        default: [{ suffix: '', format: 'jpeg', colorSpace: 'srgb', quality: 0.92 }],
      },
    },
    required: ['targets'],
  },
  // Encoders run as the executor's last step rather than a render pass; no
  // shader is needed. Identity-skip if no targets are configured.
  inputSpace: 'either',
  outputSpace: 'either',
  requiresFloat: false,
  samplesNeighbors: false,
  isIdentity: (p) => (p.targets?.length ?? 0) === 0,
  isAsync: false,
  // The executor consults the encoder's category + params and invokes the
  // encode pipeline (existing exportFromPixels logic, repurposed) per target.
  // Wiring the multi-target export into the live exporter is Phase-5d follow-up;
  // this kind ships the schema + library entry now so the graph editor can
  // already model multi-output workflows.
};

export function registerBuiltinEncoderKinds(registry: NodeRegistry): void {
  registry.replace(multiOutputEncoderKind as NodeKindSpec);
}
