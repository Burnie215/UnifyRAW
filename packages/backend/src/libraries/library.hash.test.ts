import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { computeLibraryQuickHash } from './library.hash.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe('computeLibraryQuickHash', () => {
  it('matches the browser algorithm for short and long files', async () => {
    const directory = await temporaryDirectory();
    for (const [name, bytes] of [
      ['short.jpg', Buffer.from('PhotoLib hash test')],
      ['long.raw', Buffer.alloc(70_000, 0x5a)],
      ['empty.png', Buffer.alloc(0)],
    ] as const) {
      const file = path.join(directory, name);
      await fs.writeFile(file, bytes);
      expect(await computeLibraryQuickHash(file, bytes.length)).toBe(expectedHash(bytes));
    }
  });
});

function expectedHash(bytes: Buffer): string {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(bytes.length));
  return createHash('sha256')
    .update(bytes.subarray(0, 65_536))
    .update(size)
    .digest('hex');
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-hash-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

