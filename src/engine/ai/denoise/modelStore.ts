/**
 * AI-denoise model store.
 *
 * Models live on the server under `/models/denoise/<id>.<version>.onnx` and
 * are pulled on first use, then cached in OPFS. Re-runs read straight from
 * OPFS — no network, no IndexedDB blob hop. Integrity is verified against
 * a SHA-256 manifest before a model is handed to the runtime.
 *
 * OPFS is the right home for these blobs: chunked writes (no full-blob
 * `Blob` allocation), no quota games like IndexedDB. WKWebView (iOS) has
 * partial OPFS support — fall back to an in-memory Map there so the
 * feature still works for the current session.
 */

export interface DenoiseModelDescriptor {
  id: 'scunet-psnr';
  /** Display label for the UI dropdown. */
  label: string;
  version: string;       // bumped → cache invalidates
  filename: string;      // public-server path under /models/denoise/
  sha256: string;        // hex, lowercase — full file hash (verify with `sha256sum`)
  /** Approx file size in MB, for the download progress UI ("14 / 88 MB"). */
  sizeMB: number;
  inputName: string;     // ONNX input tensor name (model-specific)
  outputName: string;    // ONNX output tensor name
  /** Tile size the model was trained / works best at. */
  tileSize: number;
  /** Channel order the model expects: 'rgb' (3 ch) — luma-only models would
   *  pre-extract Y; we only ship full-RGB models for now. */
  channels: 3;
}

/** Registry. Each model's `sha256` is the actual hash of the .onnx in
 *  public/models/denoise/ — see MODEL_LICENSES.md for sources and terms. */
export const DENOISE_MODELS: Record<string, DenoiseModelDescriptor> = {
  'scunet-psnr': {
    id: 'scunet-psnr',
    label: 'SCUNet (real-world, PSNR)',
    version: 'v1',
    filename: 'scunet-psnr.v1.onnx',
    sha256: 'b0f8c12f1575bb49e39a85924152f1c6d4b527a4aae0432c9e5c7397123465e3',
    sizeMB: 88,
    inputName: 'input',
    outputName: 'output',
    tileSize: 256,
    channels: 3,
  },
};

const OPFS_DIR = 'models/denoise';

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !navigator.storage.getDirectory) return null;
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

async function getOpfsDir(): Promise<FileSystemDirectoryHandle | null> {
  const root = await getOpfsRoot();
  if (!root) return null;
  let dir = root;
  for (const part of OPFS_DIR.split('/')) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// In-memory fallback for environments without working OPFS write (iOS WKWebView).
const memoryCache = new Map<string, ArrayBuffer>();

export interface ModelFetchProgress {
  loaded: number;
  total: number;
  /** 'opfs' = pulled from cache, 'network' = downloading. */
  source: 'opfs' | 'network' | 'memory';
}

/**
 * Returns the model bytes, fetching + caching as needed.
 * Verifies SHA-256 every time bytes come from the network. OPFS hits are
 * trusted (the integrity check happened on first download).
 */
export async function loadDenoiseModel(
  descriptor: DenoiseModelDescriptor,
  onProgress?: (p: ModelFetchProgress) => void,
): Promise<ArrayBuffer> {
  const cacheKey = `${descriptor.filename}`;

  // 1. Memory cache (already loaded this session)
  const inMem = memoryCache.get(cacheKey);
  if (inMem) {
    onProgress?.({ loaded: inMem.byteLength, total: inMem.byteLength, source: 'memory' });
    return inMem;
  }

  // 2. OPFS cache
  const dir = await getOpfsDir();
  if (dir) {
    try {
      const handle = await dir.getFileHandle(cacheKey);
      const file = await handle.getFile();
      const buf = await file.arrayBuffer();
      onProgress?.({ loaded: buf.byteLength, total: buf.byteLength, source: 'opfs' });
      memoryCache.set(cacheKey, buf);
      return buf;
    } catch {
      // not in OPFS yet — fall through to network
    }
  }

  // 3. Network fetch with progress
  const url = `/models/denoise/${descriptor.filename}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model fetch failed: ${url} (${res.status})`);

  const total = Number(res.headers.get('Content-Length') ?? 0);
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    await verifyAndCache(descriptor, buf, dir, cacheKey);
    onProgress?.({ loaded: buf.byteLength, total: buf.byteLength, source: 'network' });
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.({ loaded, total: total || loaded, source: 'network' });
  }
  const buf = new ArrayBuffer(loaded);
  const view = new Uint8Array(buf);
  let offset = 0;
  for (const c of chunks) { view.set(c, offset); offset += c.byteLength; }

  await verifyAndCache(descriptor, buf, dir, cacheKey);
  return buf;
}

async function verifyAndCache(
  descriptor: DenoiseModelDescriptor,
  buf: ArrayBuffer,
  dir: FileSystemDirectoryHandle | null,
  key: string,
): Promise<void> {
  // Skip verification when descriptor sha256 is the placeholder — lets us
  // ship code before the model file is checked in. Real models MUST have a
  // real hash; otherwise the placeholder check silently disables integrity.
  if (descriptor.sha256 && !descriptor.sha256.startsWith('__')) {
    const actual = await sha256Hex(buf);
    if (actual !== descriptor.sha256.toLowerCase()) {
      throw new Error(
        `Model SHA-256 mismatch for ${descriptor.filename}: expected ${descriptor.sha256}, got ${actual}`,
      );
    }
  }
  memoryCache.set(key, buf);
  if (dir) {
    try {
      const handle = await dir.getFileHandle(key, { create: true });
      const writable = await handle.createWritable();
      await writable.write(buf);
      await writable.close();
    } catch (err) {
      console.warn('[denoise/modelStore] OPFS write failed, model kept in memory only:', err);
    }
  }
}

/** Remove a cached model file (used by settings „cache leeren"). */
export async function evictDenoiseModel(descriptor: DenoiseModelDescriptor): Promise<void> {
  memoryCache.delete(descriptor.filename);
  const dir = await getOpfsDir();
  if (!dir) return;
  try {
    await dir.removeEntry(descriptor.filename);
  } catch {
    // not cached, nothing to do
  }
}
