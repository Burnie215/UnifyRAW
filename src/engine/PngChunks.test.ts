import { describe, expect, it } from 'vitest';

import { embedIccInPng } from './PngChunks';

function minimalPng(): Blob {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  return new Blob([bytes], { type: 'image/png' });
}

function pngProfileName(bytes: Uint8Array): string | null {
  for (let i = 8; i + 12 <= bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + i, 4).getUint32(0, false);
    const type = new TextDecoder().decode(bytes.subarray(i + 4, i + 8));
    if (type === 'iCCP') {
      const data = bytes.subarray(i + 8, i + 8 + length);
      const end = data.indexOf(0);
      return end >= 0 ? new TextDecoder().decode(data.subarray(0, end)) : null;
    }
    i += 12 + length;
  }
  return null;
}

describe('PNG ICC embedding', () => {
  it('labels the chunk with the profile it contains', async () => {
    const tagged = await embedIccInPng(minimalPng(), new Uint8Array([1, 2, 3]), 'Adobe RGB');
    expect(pngProfileName(new Uint8Array(await tagged.arrayBuffer()))).toBe('Adobe RGB');
  });
});
