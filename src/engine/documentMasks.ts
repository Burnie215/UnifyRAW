/**
 * Rasterize a document's masks and bind them, so a graph's `mask:<layerId>`
 * inputs have a texture.
 *
 * Not a nicety: a mask source node with nothing bound makes the executor
 * throw (`source node 'mask:L0' has no bound external data`) and the whole
 * render is lost. Every surface that renders a `DocumentGraph` with masks
 * has to do exactly this, so it lives here once rather than once per caller
 * — the same reason `documentGraph.ts` exists.
 *
 * Mask shapes are normalized (0..1), so one shape serves every geometry the
 * document is rendered at: preview, full-resolution export, 300px thumbnail.
 */
import { renderMaskToCanvas } from './Mask';
import type { DocumentMaskLayer, WorkerPipelineService } from './graph';

export interface BoundMasks {
  /** Node id → bound source id, for the render call's `extraSources`. */
  extraSources: Record<string, string>;
  /** Source ids to hand back to `unbindDocumentMasks` when done. */
  boundIds: string[];
}

export async function bindDocumentMasks(
  svc: WorkerPipelineService,
  maskLayers: DocumentMaskLayer[],
  idPrefix: string,
  width: number,
  height: number,
): Promise<BoundMasks> {
  const extraSources: Record<string, string> = {};
  const boundIds: string[] = [];
  for (const layer of maskLayers) {
    const sourceId = `${idPrefix}-mask-${layer.layerId}`;
    const bitmap = await createImageBitmap(renderMaskToCanvas(layer.mask, width, height));
    await svc.bindSource(sourceId, bitmap);
    boundIds.push(sourceId);
    extraSources[layer.nodeId] = sourceId;
  }
  return { extraSources, boundIds };
}

/** Release what `bindDocumentMasks` bound. Safe to call with an empty list. */
export function unbindDocumentMasks(svc: WorkerPipelineService, boundIds: string[]): void {
  for (const id of boundIds) void svc.unbindSource(id);
}

/** `extraSources` as the render calls want it: the map, or nothing at all. */
export function extraSourcesOf(masks: BoundMasks): Record<string, string> | undefined {
  return masks.boundIds.length > 0 ? masks.extraSources : undefined;
}
