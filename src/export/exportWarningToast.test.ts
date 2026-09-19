/**
 * Every recoverable export degradation has to reach the user as a toast.
 * A missing case here is a silently different file, which is exactly what
 * the warnings exist to prevent.
 */
import { describe, expect, it } from 'vitest';
import type { ExportWarning } from '../engine/Exporter';
import { exportWarningToast } from './exportWarningToast';

const t = (key: string) => `translated:${key}`;

const WARNINGS: ExportWarning[] = [
  {
    code: 'deflate-unavailable',
    requestedCompression: 'deflate',
    actualCompression: 'none',
    message: 'x',
  },
  {
    code: 'source-16bit-unavailable',
    requestedBitDepth: 16,
    actualBitDepth: 8,
    message: 'x',
  },
];

describe('exportWarningToast', () => {
  it('maps the 16-bit fallback to its own visible notice', () => {
    expect(exportWarningToast(WARNINGS[1], t)).toEqual({
      title: 'translated:dialogs.export.depthFallbackTitle',
      message: 'translated:dialogs.export.depthFallback',
      kind: 'warning',
      dedupeKey: 'export-source-16bit-unavailable',
    });
  });

  it('gives every warning a translated text and its own dedupe key', () => {
    const specs = WARNINGS.map((warning) => exportWarningToast(warning, t));
    for (const spec of specs) {
      expect(spec.title.startsWith('translated:')).toBe(true);
      expect(spec.message.startsWith('translated:')).toBe(true);
      expect(spec.kind).toBe('warning');
    }
    expect(new Set(specs.map((spec) => spec.dedupeKey)).size).toBe(WARNINGS.length);
  });
});
