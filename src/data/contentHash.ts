/**
 * Fast content hash: SHA-256(first 64KB + fileSize as 8-byte BE).
 * Practically unique for photos, runs in ~1ms regardless of file size.
 */
export async function computeContentHash(file: File): Promise<string> {
  const CHUNK = 65536;
  const slice = file.slice(0, CHUNK);
  const buffer = await slice.arrayBuffer();

  const sizeBuffer = new ArrayBuffer(8);
  new DataView(sizeBuffer).setBigUint64(0, BigInt(file.size));

  const combined = new Uint8Array(buffer.byteLength + 8);
  combined.set(new Uint8Array(buffer), 0);
  combined.set(new Uint8Array(sizeBuffer), buffer.byteLength);

  const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
