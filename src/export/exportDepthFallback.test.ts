/**
 * Where the dialog's 16-bit promise meets the pixels a decoder delivered.
 *
 * The offer comes from the source's maximum depth, which says what the FILE
 * holds. Whether this browser's libheif can hand those bits over is a
 * different question, and it is only answered once the export has already
 * started - so the answer has to be able to say "8 bit, and here is why".
 */
import { describe, expect, it } from 'vitest';
import { planExportDepth } from './exportDepthFallback';

const pixels16 = { bits: 16 as const, data: new Uint16Array(12) };
const pixels8 = { bits: 8 as const, data: new Uint8Array(12) };

describe('planExportDepth', () => {
  it('keeps 16 bit when the source really delivered 16-bit pixels', () => {
    expect(planExportDepth({ requested: 16, pixels: pixels16, mayFallBack: true }))
      .toEqual({ bitDepth: 16, warning: null });
  });

  it('falls back to 8 bit and says so when a HEIF produced no 16-bit pixels', () => {
    const decision = planExportDepth({ requested: 16, pixels: null, mayFallBack: true });
    expect(decision.bitDepth).toBe(8);
    expect(decision.warning).toMatchObject({
      code: 'source-16bit-unavailable',
      requestedBitDepth: 16,
      actualBitDepth: 8,
    });
  });

  it('never falls back silently', () => {
    const decision = planExportDepth({ requested: 16, pixels: undefined, mayFallBack: true });
    expect(decision.warning).not.toBeNull();
    expect(decision.warning?.message).toBeTruthy();
  });

  it('treats 8-bit pixels as no 16-bit source, not as a 16-bit render', () => {
    expect(planExportDepth({ requested: 16, pixels: pixels8, mayFallBack: true }).bitDepth).toBe(8);
  });

  // A 16-bit buffer typed as bytes is not a 16-bit source; renderPhoto would
  // reject it, and relabelling the export would be the lie this guards.
  it('rejects a 16-bit claim that is not backed by a Uint16Array', () => {
    const decision = planExportDepth({
      requested: 16,
      pixels: { bits: 16, data: new Uint8Array(24) as unknown as Uint16Array },
      mayFallBack: true,
    });
    expect(decision.bitDepth).toBe(8);
  });

  it('leaves a RAW without 16-bit pixels at 16 so the exporter still errors', () => {
    expect(planExportDepth({ requested: 16, pixels: null, mayFallBack: false }))
      .toEqual({ bitDepth: 16, warning: null });
  });

  it('says nothing for an 8-bit export, whatever the pixels are', () => {
    expect(planExportDepth({ requested: 8, pixels: null, mayFallBack: true }))
      .toEqual({ bitDepth: 8, warning: null });
    expect(planExportDepth({ requested: undefined, pixels: pixels16, mayFallBack: true }))
      .toEqual({ bitDepth: 8, warning: null });
  });
});
