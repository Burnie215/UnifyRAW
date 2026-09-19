import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const QUICK_HASH_CHUNK_BYTES = 65_536;

/**
 * Node implementation of src/data/contentHash.ts:
 * SHA-256(first 64 KiB + file size encoded as unsigned 64-bit big endian).
 */
export async function computeLibraryQuickHash(
  filePath: string,
  knownSize?: number,
): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = knownSize === undefined ? await handle.stat() : null;
    const size = knownSize ?? stat!.size;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error('File size cannot be represented safely');
    }

    const chunk = Buffer.allocUnsafe(Math.min(QUICK_HASH_CHUNK_BYTES, size));
    const { bytesRead } = chunk.length > 0
      ? await handle.read(chunk, 0, chunk.length, 0)
      : { bytesRead: 0 };
    const sizeBuffer = Buffer.alloc(8);
    sizeBuffer.writeBigUInt64BE(BigInt(size));

    return createHash('sha256')
      .update(chunk.subarray(0, bytesRead))
      .update(sizeBuffer)
      .digest('hex');
  } finally {
    await handle.close();
  }
}

export async function computeLibraryFullChecksum(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
