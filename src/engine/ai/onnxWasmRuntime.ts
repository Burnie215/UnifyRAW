/**
 * Lazy ONNX WASM runtime with explicit URLs for its Emscripten glue and
 * binary. onnxruntime-web discovers these files by filename at runtime;
 * bundlers cannot see that string-based import unless both assets are made
 * part of the module graph explicitly.
 */

export type WasmOrtRuntime = typeof import('onnxruntime-web/wasm');

const wasmModuleUrl = new URL(
  '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
  import.meta.url,
).href;

const wasmBinaryUrl = new URL(
  '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
  import.meta.url,
).href;

let runtimePromise: Promise<WasmOrtRuntime> | null = null;

export function loadWasmOrtRuntime(): Promise<WasmOrtRuntime> {
  if (!runtimePromise) {
    runtimePromise = import('onnxruntime-web/wasm')
      .then((runtime) => {
        runtime.env.wasm.wasmPaths = {
          mjs: wasmModuleUrl,
          wasm: wasmBinaryUrl,
        };
        return runtime;
      })
      .catch((error) => {
        // A transient chunk or asset fetch failure must remain retryable.
        runtimePromise = null;
        throw error;
      });
  }
  return runtimePromise;
}
