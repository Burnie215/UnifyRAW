/**
 * Fast image dimension reading from blob headers.
 * Parses JPEG/PNG/WebP headers without full pixel decode (~1ms vs seconds).
 */

export async function readImageDimensions(blob: Blob): Promise<{ w: number; h: number } | null> {
  const header = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  if (header.length < 24) return null;

  // PNG: signature + IHDR
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) {
    const w = (header[16] << 24) | (header[17] << 16) | (header[18] << 8) | header[19];
    const h = (header[20] << 24) | (header[21] << 16) | (header[22] << 8) | header[23];
    return { w, h };
  }

  // JPEG: find SOF marker
  if (header[0] === 0xFF && header[1] === 0xD8) {
    let offset = 2;
    while (offset < header.length - 9) {
      if (header[offset] !== 0xFF) break;
      const marker = header[offset + 1];
      // SOF0, SOF1, SOF2, SOF3 (baseline, extended, progressive, lossless)
      if (marker >= 0xC0 && marker <= 0xC3) {
        const h = (header[offset + 5] << 8) | header[offset + 6];
        const w = (header[offset + 7] << 8) | header[offset + 8];
        return { w, h };
      }
      // Skip segment
      const segLen = (header[offset + 2] << 8) | header[offset + 3];
      offset += 2 + segLen;
    }
  }

  // WebP
  if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
      header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) {
    // VP8 (lossy)
    if (header[12] === 0x56 && header[13] === 0x50 && header[14] === 0x38 && header[15] === 0x20) {
      const w = ((header[26] | (header[27] << 8)) & 0x3FFF);
      const h = ((header[28] | (header[29] << 8)) & 0x3FFF);
      return { w, h };
    }
    // VP8L (lossless)
    if (header[12] === 0x56 && header[13] === 0x50 && header[14] === 0x38 && header[15] === 0x4C) {
      const bits = header[21] | (header[22] << 8) | (header[23] << 16) | (header[24] << 24);
      const w = (bits & 0x3FFF) + 1;
      const h = ((bits >> 14) & 0x3FFF) + 1;
      return { w, h };
    }
    // VP8X (extended)
    if (header[12] === 0x56 && header[13] === 0x50 && header[14] === 0x38 && header[15] === 0x58) {
      const w = ((header[24]) | (header[25] << 8) | (header[26] << 16)) + 1;
      const h = ((header[27]) | (header[28] << 8) | (header[29] << 16)) + 1;
      return { w, h };
    }
  }

  return null;
}
