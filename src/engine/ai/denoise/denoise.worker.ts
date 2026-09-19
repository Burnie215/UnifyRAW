/**
 * AI denoise worker.
 *
 * Receives a full-resolution Float32 RGBA image + ONNX model bytes,
 * runs the model tile-by-tile, blends overlaps with a 2-D cosine window,
 * and emits the denoised image. Sequential per tile — running tiles in
 * parallel against the same ONNX session is not safe and would OOM on
 * iGPUs anyway.
 *
 * Cosine blending instead of linear-falloff: linear leaves visible seams
 * because the spatial derivative of the weight is constant inside the
 * overlap band, so any model bias appears as a faint grid. The cosine
 * window has a smooth zero-derivative join at the edges → seams disappear.
 */
import { getSession, runTile } from './onnxRuntime';
import type { DenoiseWorkerRequest, DenoiseWorkerMessage } from './denoiseProtocol';

self.addEventListener('message', (ev: MessageEvent<DenoiseWorkerRequest>) => {
  void handle(ev.data).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', message });
  });
});

function post(msg: DenoiseWorkerMessage, transfer?: Transferable[]) {
  (self as unknown as { postMessage: (m: unknown, t?: Transferable[]) => void })
    .postMessage(msg, transfer);
}

async function handle(req: DenoiseWorkerRequest): Promise<void> {
  const { pixels, width, height, modelBytes, descriptor } = req;
  const overlap = req.overlap ?? 32;
  const tile = descriptor.tileSize;
  const stride = tile - overlap;

  const session = await getSession({
    modelBytes,
    modelKey: `${descriptor.id}.${descriptor.version}`,
  });

  // Cosine window, precomputed once. window[i] = 0.5*(1-cos(pi * i / overlap))
  // ramps from 0..1 over `overlap` pixels at each edge, plateaus at 1 in
  // the center. We apply it as a separable product window(x)*window(y).
  const win = new Float32Array(tile);
  for (let i = 0; i < tile; i++) {
    const distFromEdge = Math.min(i, tile - 1 - i);
    if (distFromEdge >= overlap) win[i] = 1;
    else win[i] = 0.5 * (1 - Math.cos((Math.PI * distFromEdge) / overlap));
  }

  // Output accumulators (premultiplied by weight) + weight sum, in float32.
  const accum = new Float32Array(width * height * 3);
  const wAccum = new Float32Array(width * height);

  // Tile positions — last row/column clamped so we never read off-edge.
  const xs = stepPositions(width, tile, stride);
  const ys = stepPositions(height, tile, stride);
  const tilesTotal = xs.length * ys.length;
  let tilesDone = 0;

  const inputBuf = new Float32Array(3 * tile * tile);
  for (const py of ys) {
    for (const px of xs) {
      // Extract tile → CHW
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const si = ((py + y) * width + (px + x)) * 4;
          const di = y * tile + x;
          inputBuf[di]                    = pixels[si];
          inputBuf[tile * tile + di]      = pixels[si + 1];
          inputBuf[2 * tile * tile + di]  = pixels[si + 2];
        }
      }

      const output = await runTile(
        session,
        descriptor.inputName,
        descriptor.outputName,
        inputBuf,
        [1, 3, tile, tile],
      );

      // Blend into accumulators with cosine window
      for (let y = 0; y < tile; y++) {
        const wy = win[y];
        for (let x = 0; x < tile; x++) {
          const w = wy * win[x];
          if (w <= 0) continue;
          const gIdx = (py + y) * width + (px + x);
          const pIdx = y * tile + x;
          accum[gIdx * 3]     += output[pIdx] * w;
          accum[gIdx * 3 + 1] += output[tile * tile + pIdx] * w;
          accum[gIdx * 3 + 2] += output[2 * tile * tile + pIdx] * w;
          wAccum[gIdx]        += w;
        }
      }

      tilesDone++;
      post({ type: 'progress', tilesDone, tilesTotal });
    }
  }

  // Normalize accumulators → RGBA output (re-use the input buffer slot,
  // it has the right size). We write into a fresh buffer so that callers
  // can keep both input and output if they want a mix.
  const out = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const w = wAccum[i] || 1;
    out[i * 4]     = accum[i * 3]     / w;
    out[i * 4 + 1] = accum[i * 3 + 1] / w;
    out[i * 4 + 2] = accum[i * 3 + 2] / w;
    out[i * 4 + 3] = pixels[i * 4 + 3];   // alpha pass-through
  }

  post({ type: 'result', pixels: out, width, height }, [out.buffer]);
}

/** Tile-origin positions covering [0..size) with `tile` window + `stride`. */
function stepPositions(size: number, tile: number, stride: number): number[] {
  if (size <= tile) return [0];
  const positions: number[] = [];
  for (let p = 0; p + tile <= size; p += stride) positions.push(p);
  // Make sure the last tile aligns with the right/bottom edge — avoids a
  // sliver of unprocessed pixels at the end.
  const last = size - tile;
  if (positions[positions.length - 1] !== last) positions.push(last);
  return positions;
}
