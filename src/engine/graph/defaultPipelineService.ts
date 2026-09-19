/**
 * Default production PipelineService = the WorkerPipelineService.
 *
 * Production code (preset thumbs, library thumb-renderer, exporter, editor
 * live render) all share this single off-thread service. The main thread
 * never owns a GL context; all GL work happens in `PipelineWorker`.
 *
 * Tests that need bit-exact pixel assertions instantiate the in-process
 * `PipelineService` directly with their own GL context.
 */
import { WorkerPipelineService } from './WorkerPipelineService';
import { NodeRegistry } from './NodeRegistry';
import { registerAllBuiltins } from './registerBuiltins';

let _defaultInstance: WorkerPipelineService | null = null;

/**
 * Get the shared production WorkerPipelineService. Allocated lazily on
 * first use; lives for the rest of the session.
 *
 * Requires WebGL2 + OffscreenCanvas + Web Workers. The worker itself
 * throws on cold-start if WebGL2 is unavailable; surface the error in the
 * UI via a capability gate at app boot (Phase 1.D).
 */
export function getDefaultPipelineService(): WorkerPipelineService {
  if (_defaultInstance) return _defaultInstance;
  _defaultInstance = new WorkerPipelineService();
  return _defaultInstance;
}

export function setDefaultPipelineService(instance: WorkerPipelineService | null): void {
  if (_defaultInstance && _defaultInstance !== instance) {
    void _defaultInstance.release();
  }
  _defaultInstance = instance;
}

/**
 * Main-thread mirror of the worker's node registry. The worker spins up
 * its own registry on cold-start; the UI (graph editor, inspector, library
 * panel) needs a parallel one to enumerate kinds + their schemas without
 * crossing the worker bridge.
 *
 * Both sides call registerAllBuiltins(), so the set of kinds stays in sync
 * by construction.
 */
let _uiRegistry: NodeRegistry | null = null;

export function getMainThreadNodeRegistry(): NodeRegistry {
  if (_uiRegistry) return _uiRegistry;
  _uiRegistry = new NodeRegistry();
  registerAllBuiltins(_uiRegistry);
  return _uiRegistry;
}
