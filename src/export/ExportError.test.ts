import { describe, expect, it } from 'vitest';
import { classifyExportStatus, requestExportResponse } from './ExportError';

describe('export response classification', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [409, 'conflict'],
    [413, 'too-large'],
    [429, 'quota'],
    [507, 'quota'],
    [500, 'server'],
    [503, 'server'],
    [400, 'server'],
  ] as const)('maps HTTP %i to %s', (status, code) => {
    expect(classifyExportStatus(status)).toBe(code);
  });

  it('preserves the status on a structured HTTP error', async () => {
    const result = requestExportResponse('Immich', async () => new Response('down', { status: 503 }));
    await expect(result).rejects.toMatchObject({
      name: 'ExportError',
      code: 'server',
      status: 503,
    });
  });

  it('maps a rejected request to a network error', async () => {
    const result = requestExportResponse('Lychee', async () => { throw new TypeError('fetch failed'); });
    await expect(result).rejects.toMatchObject({
      name: 'ExportError',
      code: 'network',
    });
  });
});
