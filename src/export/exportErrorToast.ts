import type { ExportError } from './ExportError';

type Translate = (key: string) => string;

export interface ExportErrorToastSpec {
  title: string;
  message: string;
  kind: 'error';
  action?: { label: string; onClick: () => void };
}

/** Pure mapping from provider failure to one actionable, localised toast. */
export function exportErrorToast(
  error: ExportError,
  t: Translate,
  openSources: () => void,
): ExportErrorToastSpec {
  const title = t('dialogs.export.errors.title');
  switch (error.code) {
    case 'auth':
      return {
        title,
        message: t('dialogs.export.errors.auth'),
        kind: 'error',
        action: {
          label: t('dialogs.export.errors.openSources'),
          onClick: openSources,
        },
      };
    case 'conflict':
      return { title, message: t('dialogs.export.errors.conflict'), kind: 'error' };
    case 'too-large':
      return { title, message: t('dialogs.export.errors.tooLarge'), kind: 'error' };
    case 'quota':
      return { title, message: t('dialogs.export.errors.quota'), kind: 'error' };
    case 'server':
      return { title, message: t('dialogs.export.errors.server'), kind: 'error' };
    case 'network':
      return { title, message: t('dialogs.export.errors.network'), kind: 'error' };
  }
}
