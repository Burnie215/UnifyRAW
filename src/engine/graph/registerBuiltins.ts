import type { NodeRegistry } from './NodeRegistry';
import { registerBuiltinConverts } from './builtins';
import { registerBuiltinSources } from './sources';
import { registerBuiltinPassKinds } from './passKinds';
import { registerBuiltinCompositors } from './compositorKinds';
import { registerBuiltinMaskKinds } from './maskKinds';
import { registerBuiltinLutKinds } from './lutKinds';
import { registerBuiltinEncoderKinds } from './encoderKinds';
import { registerBuiltinPreviewKind } from './previewKind';

/**
 * The one list of built-in kind modules. Worker-side (PipelineService
 * constructor) and main-thread (getMainThreadNodeRegistry) registries both
 * call this — a kind registered here exists on BOTH sides by construction,
 * instead of two hand-maintained "keep in lockstep" lists.
 */
export function registerAllBuiltins(registry: NodeRegistry): void {
  registerBuiltinConverts(registry);
  registerBuiltinSources(registry);
  registerBuiltinPassKinds(registry);
  registerBuiltinCompositors(registry);
  registerBuiltinMaskKinds(registry);
  registerBuiltinLutKinds(registry);
  registerBuiltinEncoderKinds(registry);
  registerBuiltinPreviewKind(registry);
}
