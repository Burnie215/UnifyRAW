import { describe, expect, it, vi } from 'vitest';
import { ExportError, type ExportErrorCode } from './ExportError';
import { retryExport } from './exportRetry';

describe('export retry policy', () => {
  it.each(['server', 'network'] as const)('tries %s failures three times with exponential backoff', async (code) => {
    const operation = vi.fn().mockRejectedValue(new ExportError(code, 'temporary'));
    const sleep = vi.fn(async () => {});

    await expect(retryExport(operation, { sleep })).rejects.toMatchObject({ code });

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it('returns an eventual retry result', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new ExportError('server', 'temporary'))
      .mockResolvedValueOnce('asset-id');

    await expect(retryExport(operation, { sleep: async () => {} })).resolves.toBe('asset-id');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each(['auth', 'conflict', 'too-large', 'quota'] satisfies ExportErrorCode[])(
    'does not retry %s failures',
    async (code) => {
      const operation = vi.fn().mockRejectedValue(new ExportError(code, 'permanent'));
      const sleep = vi.fn(async () => {});

      await expect(retryExport(operation, { sleep })).rejects.toMatchObject({ code });
      expect(operation).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it('does not retry an unclassified application failure', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('render failed'));
    await expect(retryExport(operation, { sleep: async () => {} })).rejects.toThrow('render failed');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
