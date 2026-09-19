import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import type { ExportWarning } from '../engine/Exporter';
import { exportWarningToast } from '../export/exportWarningToast';
import { ToastProvider, useToast } from './Toast';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WARNING: ExportWarning = {
  code: 'deflate-unavailable',
  requestedCompression: 'deflate',
  actualCompression: 'none',
  message: 'Deflate compression is unavailable; the TIFF was written uncompressed.',
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function WarningTrigger() {
  const toast = useToast();
  return createElement('button', {
    onClick: () => toast.push(exportWarningToast(WARNING, (key) => `translated:${key}`)),
  }, 'emit warning');
}

describe('TIFF export warning toast', () => {
  it('renders the Deflate fallback as a visible, deduplicated warning toast', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(ToastProvider, null, createElement(WarningTrigger)));
    });

    const trigger = host.querySelector('button') as HTMLButtonElement;
    await act(async () => {
      trigger.click();
      trigger.click();
    });

    const statuses = host.querySelectorAll('[role="status"]');
    expect(statuses).toHaveLength(1);
    const content = statuses[0].firstElementChild!;
    expect(content.children[0].textContent).toBe('translated:dialogs.export.deflateFallbackTitle');
    expect(content.children[1].textContent).toBe('translated:dialogs.export.deflateFallback');
    expect((statuses[0] as HTMLElement).style.borderLeft).toContain('rgb(245, 166, 35)');
  });
});
