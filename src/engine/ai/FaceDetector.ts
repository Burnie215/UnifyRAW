/**
 * FaceDetector — detect faces and extract embeddings via ONNX Runtime Web.
 *
 * Models (all Apache-2.0/MIT, loaded lazily from /models/):
 * - Face detection: BlazeFace / UltraFace (~1-2MB) → bounding boxes + confidence
 * - Face embedding: MobileFaceNet (~5MB) → 128-dim vector for clustering/recognition
 *
 * Falls back to no-op if ONNX Runtime is unavailable.
 */

import { loadWasmOrtRuntime, type WasmOrtRuntime } from './onnxWasmRuntime';
import type { InferenceSession } from 'onnxruntime-web/wasm';

const DETECT_INPUT_SIZE = 320;  // UltraFace input
const EMBED_INPUT_SIZE = 112;   // MobileFaceNet input
const EMBED_DIM = 128;

export interface FaceDetection {
  x: number;          // normalized 0..1
  y: number;
  width: number;
  height: number;
  confidence: number; // 0..1
}

export interface FaceWithEmbedding extends FaceDetection {
  embedding: number[];  // 128-dim L2-normalized vector
}

/**
 * Detect faces in an image. Returns bounding boxes with confidence scores.
 */
export async function detectFaces(imageUrl: string): Promise<FaceDetection[]> {
  try {
    const ort = await loadWasmOrtRuntime();
    const session = await ort.InferenceSession.create('/models/ultraface-slim.onnx', {
      executionProviders: ['wasm'],
    });

    const { canvas, originalWidth, originalHeight } = await prepareImage(imageUrl, DETECT_INPUT_SIZE);
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, DETECT_INPUT_SIZE, DETECT_INPUT_SIZE);

    // CHW float32 normalized [0,1]
    const tensor = new Float32Array(3 * DETECT_INPUT_SIZE * DETECT_INPUT_SIZE);
    const px = DETECT_INPUT_SIZE * DETECT_INPUT_SIZE;
    for (let i = 0; i < px; i++) {
      tensor[i] = imageData.data[i * 4] / 255;
      tensor[px + i] = imageData.data[i * 4 + 1] / 255;
      tensor[2 * px + i] = imageData.data[i * 4 + 2] / 255;
    }

    const feeds: Record<string, unknown> = {
      input: new ort.Tensor('float32', tensor, [1, 3, DETECT_INPUT_SIZE, DETECT_INPUT_SIZE]),
    };
    const results = await session.run(feeds as Parameters<typeof session.run>[0]);

    return parseDetections(results, originalWidth, originalHeight);
  } catch {
    // ONNX not available — try canvas-based fallback
    return fallbackFaceDetect(imageUrl);
  }
}

/**
 * Detect faces and extract embeddings for each.
 */
export async function detectFacesWithEmbeddings(imageUrl: string): Promise<FaceWithEmbedding[]> {
  const faces = await detectFaces(imageUrl);
  if (faces.length === 0) return [];

  try {
    const ort = await loadWasmOrtRuntime();
    const session = await ort.InferenceSession.create('/models/mobilefacenet.onnx', {
      executionProviders: ['wasm'],
    });

    const img = await loadImage(imageUrl);

    const results: FaceWithEmbedding[] = [];
    for (const face of faces) {
      const embedding = await extractEmbedding(ort, session, img, face);
      results.push({ ...face, embedding });
    }

    return results;
  } catch {
    // No embedding model — return faces without embeddings
    return faces.map((f) => ({ ...f, embedding: [] }));
  }
}

/**
 * Cluster faces by cosine similarity of embeddings.
 * Simple greedy clustering: assign to nearest existing cluster or create new one.
 */
export function clusterFaces(
  faces: { embedding: number[]; id?: number }[],
  threshold = 0.6,
): Map<number, number[]> {
  const clusters = new Map<number, { centroid: number[]; members: number[] }>();
  let nextClusterId = 0;

  for (let i = 0; i < faces.length; i++) {
    const emb = faces[i].embedding;
    if (!emb || emb.length === 0) continue;

    let bestCluster = -1;
    let bestSim = threshold;

    for (const [cid, cluster] of clusters) {
      const sim = cosineSimilarity(emb, cluster.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestCluster = cid;
      }
    }

    if (bestCluster >= 0) {
      const cluster = clusters.get(bestCluster)!;
      cluster.members.push(i);
      // Update centroid (running average)
      const n = cluster.members.length;
      for (let j = 0; j < emb.length; j++) {
        cluster.centroid[j] = (cluster.centroid[j] * (n - 1) + emb[j]) / n;
      }
    } else {
      clusters.set(nextClusterId, { centroid: [...emb], members: [i] });
      nextClusterId++;
    }
  }

  // Return cluster ID → face indices
  const result = new Map<number, number[]>();
  for (const [cid, cluster] of clusters) {
    result.set(cid, cluster.members);
  }
  return result;
}

// ─── Helpers ───

async function prepareImage(url: string, size: number): Promise<{
  canvas: OffscreenCanvas; originalWidth: number; originalHeight: number;
}> {
  const img = await loadImage(url);
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, size, size);
  return { canvas, originalWidth: img.width, originalHeight: img.height };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function parseDetections(
  results: Record<string, { data: Float32Array | Uint8Array; dims: readonly number[] }>,
  _origW: number,
  _origH: number,
): FaceDetection[] {
  const keys = Object.keys(results);
  // UltraFace outputs: scores [1,N,2] and boxes [1,N,4]
  const scoresKey = keys.find((k) => results[k].dims.length === 3 && results[k].dims[2] === 2) ?? keys[0];
  const boxesKey = keys.find((k) => results[k].dims.length === 3 && results[k].dims[2] === 4) ?? keys[1];

  if (!scoresKey || !boxesKey) return [];

  const scores = results[scoresKey].data as Float32Array;
  const boxes = results[boxesKey].data as Float32Array;
  const numDetections = results[scoresKey].dims[1];

  const faces: FaceDetection[] = [];
  for (let i = 0; i < numDetections; i++) {
    const confidence = scores[i * 2 + 1]; // class 1 = face
    if (confidence < 0.5) continue;

    const x1 = Math.max(0, boxes[i * 4]);
    const y1 = Math.max(0, boxes[i * 4 + 1]);
    const x2 = Math.min(1, boxes[i * 4 + 2]);
    const y2 = Math.min(1, boxes[i * 4 + 3]);

    faces.push({
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      confidence,
    });
  }

  // NMS (simple: remove overlapping detections)
  return nms(faces, 0.3);
}

function nms(faces: FaceDetection[], iouThreshold: number): FaceDetection[] {
  const sorted = [...faces].sort((a, b) => b.confidence - a.confidence);
  const keep: FaceDetection[] = [];

  for (const face of sorted) {
    let suppressed = false;
    for (const kept of keep) {
      if (iou(face, kept) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) keep.push(face);
  }
  return keep;
}

function iou(a: FaceDetection, b: FaceDetection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const aArea = a.width * a.height;
  const bArea = b.width * b.height;
  return inter / (aArea + bArea - inter);
}

async function extractEmbedding(
  ort: WasmOrtRuntime,
  session: InferenceSession,
  img: HTMLImageElement,
  face: FaceDetection,
): Promise<number[]> {
  // Crop face region with 20% padding
  const pad = 0.2;
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height / 2;
  const size = Math.max(face.width, face.height) * (1 + pad * 2);
  const cropX = Math.max(0, cx - size / 2) * img.width;
  const cropY = Math.max(0, cy - size / 2) * img.height;
  const cropW = Math.min(size * img.width, img.width - cropX);
  const cropH = Math.min(size * img.height, img.height - cropY);

  const canvas = new OffscreenCanvas(EMBED_INPUT_SIZE, EMBED_INPUT_SIZE);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, EMBED_INPUT_SIZE, EMBED_INPUT_SIZE);

  const imageData = ctx.getImageData(0, 0, EMBED_INPUT_SIZE, EMBED_INPUT_SIZE);
  const tensor = new Float32Array(3 * EMBED_INPUT_SIZE * EMBED_INPUT_SIZE);
  const px = EMBED_INPUT_SIZE * EMBED_INPUT_SIZE;

  // Normalize to [-1, 1] (MobileFaceNet expects this)
  for (let i = 0; i < px; i++) {
    tensor[i] = (imageData.data[i * 4] / 255 - 0.5) / 0.5;
    tensor[px + i] = (imageData.data[i * 4 + 1] / 255 - 0.5) / 0.5;
    tensor[2 * px + i] = (imageData.data[i * 4 + 2] / 255 - 0.5) / 0.5;
  }

  const feeds: Record<string, unknown> = {
    input: new ort.Tensor('float32', tensor, [1, 3, EMBED_INPUT_SIZE, EMBED_INPUT_SIZE]),
  };
  const results = await session.run(feeds as Parameters<typeof session.run>[0]);
  const outputKey = Object.keys(results)[0];
  const raw = results[outputKey].data as Float32Array;

  // L2-normalize
  const embedding = Array.from(raw.slice(0, EMBED_DIM));
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < embedding.length; i++) embedding[i] /= norm;

  return embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // Already L2-normalized, so dot product = cosine similarity
}

/**
 * Fallback face detection using canvas-based skin color heuristic.
 * Very rough — returns large face-like regions based on skin tone.
 */
async function fallbackFaceDetect(imageUrl: string): Promise<FaceDetection[]> {
  const img = await loadImage(imageUrl);
  const size = 200;
  const scale = Math.min(size / img.width, size / img.height, 1);
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;

  // Simple skin-color detection (YCbCr space)
  const skinMap = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.169 * r - 0.331 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.419 * g - 0.081 * b;
    skinMap[i / 4] = (y > 80 && cb > 85 && cb < 135 && cr > 135 && cr < 180) ? 1 : 0;
  }

  // Find largest connected skin region as rough face estimate
  const skinRatio = skinMap.reduce((s, v) => s + v, 0) / skinMap.length;
  if (skinRatio < 0.01 || skinRatio > 0.5) return []; // No clear face

  // Simple bounding box of skin pixels
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (skinMap[y * w + x]) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (maxX <= minX || maxY <= minY) return [];

  return [{
    x: minX / w,
    y: minY / h,
    width: (maxX - minX) / w,
    height: (maxY - minY) / h,
    confidence: 0.3,
  }];
}
