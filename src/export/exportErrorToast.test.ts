import { describe, expect, it, vi } from 'vitest';
import { ExportError, type ExportErrorCode } from './ExportError';
import { exportErrorToast } from './exportErrorToast';

describe('export error toast mapping', () => {
  const t = (key: string) => key;

  it.each([
    ['conflict', 'dialogs.export.errors.conflict'],
    ['too-large', 'dialogs.export.errors.tooLarge'],
    ['quota', 'dialogs.export.errors.quota'],
    ['server', 'dialogs.export.errors.server'],
    ['network', 'dialogs.export.errors.network'],
  ] satisfies Array<[ExportErrorCode, string]>)('maps %s to its specific message', (code, key) => {
    const toast = exportErrorToast(new ExportError(code, 'detail'), t, vi.fn());
    expect(toast).toEqual({
      title: 'dialogs.export.errors.title',
      message: key,
      kind: 'error',
    });
  });

  it('gives an authentication failure a working source-settings action', () => {
    const openSources = vi.fn();
    const toast = exportErrorToast(new ExportError('auth', 'denied'), t, openSources);

    expect(toast.message).toBe('dialogs.export.errors.auth');
    expect(toast.action?.label).toBe('dialogs.export.errors.openSources');
    toast.action?.onClick();
    expect(openSources).toHaveBeenCalledOnce();
  });
});
