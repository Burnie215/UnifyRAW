/**
 * The one conversion between an editor slider's ±100 scale and the shader-scale
 * number a graph node's params carry.
 *
 * `DefaultGraphBuilder.div100` writes such a param on the way in and
 * `paramsToAdjustments.mul100` reads it back on the way out. An inspector that
 * spells the factor a third time is a third opinion, and the one time it was
 * spelled wrong (raw UI value into the param) every graph-mode slider acted
 * 100x too strong. Kept out of the .tsx so the node project can measure the
 * factor without a renderer (F139).
 */

/** Editor scale (±100) to param scale (±1). */
export function toParam(uiValue: number): number {
  return uiValue / 100;
}

/** Param scale (±1) to editor scale (±100). */
export function toUi(paramValue: number | undefined): number {
  return Math.round((paramValue ?? 0) * 100);
}
