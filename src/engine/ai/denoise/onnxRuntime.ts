/**
 * ONNX Runtime Web wrapper for denoise.
 *
 * Backend priority: webgpu → wasm. WebGPU is dramatically faster (~5-10x)
 * but availability is uneven — Chrome stable, Safari 18+, Firefox behind
 * flag. The probe uses an actual feature-detect, not UA sniffing.
 *
 * Sessions are cached per (model-bytes, backend) — re-running denoise on
 * a second image reuses the warmed-up session and skips ~200ms of init.
 */
import type { InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import { loadWasmOrtRuntime, type WasmOrtRuntime } from '../onnxWasmRuntime';

// Load only the execution provider selected for this session. The `/all`
// entry bundled WebGPU, WebGL and the 21 MB JSEP fallback together and also
// introduced a direct-eval build warning. Provider-specific entry points are
// both smaller and explicit about the code that can execute.
type OrtRuntime = WasmOrtRuntime;

export type DenoiseBackend = 'webgpu' | 'wasm';

let cachedBackend: DenoiseBackend | null = null;

/**
 * Pick the best backend available *right now*. Cached after first call —
 * the answer cannot change within a session (GPU adapter doesn't appear
 * mid-flight).
 */
export async function pickBackend(): Promise<DenoiseBackend> {
  if (cachedBackend) return cachedBackend;
  if ('gpu' in navigator) {
    try {
      const adapter = await (navigator as Navigator & { gpu: { requestAdapter: () => Promise<unknown> } })
        .gpu.requestAdapter();
      if (adapter) {
        cachedBackend = 'webgpu';
        return cachedBackend;
      }
    } catch {
      // fall through to wasm
    }
  }
  cachedBackend = 'wasm';
  return cachedBackend;
}

// Keyed by `${modelKey}::${backend}` — modelKey identifies the bytes
// (filename+version is enough since version is in the filename).
const sessionCache = new Map<string, Promise<InferenceSession>>();
let sessionRuntimes = new WeakMap<InferenceSession, OrtRuntime>();

async function loadRuntime(backend: DenoiseBackend): Promise<OrtRuntime> {
  if (backend === 'webgpu') {
    // Both provider entry points expose the same public API. Keep the common
    // structural type so sessions and tensors remain tied to their runtime.
    return import('onnxruntime-web/webgpu') as Promise<OrtRuntime>;
  }
  return loadWasmOrtRuntime();
}

export interface SessionOptions {
  modelBytes: ArrayBuffer;
  modelKey: string;       // stable id for cache, e.g. "dncnn.v1"
  backend?: DenoiseBackend;
}

export async function getSession(opts: SessionOptions): Promise<InferenceSession> {
  const backend = opts.backend ?? await pickBackend();
  const key = `${opts.modelKey}::${backend}`;
  const existing = sessionCache.get(key);
  if (existing) return existing;

  const created = createSession(opts.modelBytes, backend);
  sessionCache.set(key, created);
  // If session creation fails, drop the rejected promise so the next call retries
  created.catch(() => sessionCache.delete(key));
  return created;
}

async function createSession(
  modelBytes: ArrayBuffer,
  backend: DenoiseBackend,
): Promise<InferenceSession> {
  const ort = await loadRuntime(backend);
  // TS 6 made Uint8Array generic, which breaks onnxruntime-web's overload
  // resolution for InferenceSession.create — TS picks the `(uri: string)`
  // overload and rejects any buffer form. Explicit overload pick:
  type CreateFromBuffer = (buf: Uint8Array, options?: import('onnxruntime-common').InferenceSession.SessionOptions) => Promise<InferenceSession>;
  const create = ort.InferenceSession.create as unknown as CreateFromBuffer;
  const session = await create(new Uint8Array(modelBytes), {
    executionProviders: [backend],
    graphOptimizationLevel: 'all',
  });
  sessionRuntimes.set(session, ort);
  return session;
}

/**
 * Run a single tile through the session. Caller is responsible for layout —
 * `input` must already be NCHW float32, [1, C, H, W].
 */
export async function runTile(
  session: InferenceSession,
  inputName: string,
  outputName: string,
  input: Float32Array,
  shape: [number, number, number, number],
): Promise<Float32Array> {
  const ort = sessionRuntimes.get(session);
  if (!ort) throw new Error('ONNX session runtime is no longer available');
  const tensor = new ort.Tensor('float32', input, shape);
  const feeds: Record<string, Tensor> = { [inputName]: tensor };
  const result = await session.run(feeds);
  const out = result[outputName];
  if (!out) {
    throw new Error(`Model did not produce expected output "${outputName}"; got: ${Object.keys(result).join(', ')}`);
  }
  return out.data as Float32Array;
}

/** Force a re-probe on next pickBackend(). For tests / settings UI. */
export function resetBackendCache(): void {
  cachedBackend = null;
  sessionCache.clear();
  sessionRuntimes = new WeakMap();
}
