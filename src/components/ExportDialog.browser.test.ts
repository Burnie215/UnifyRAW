import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

import { ExportDialog } from './ExportDialog';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

type DialogProps = Parameters<typeof ExportDialog>[0];

async function mount(props: Partial<DialogProps> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const onExport = vi.fn();
  await act(async () => {
    root?.render(createElement(ExportDialog, {
      open: true, onClose: vi.fn(), onExport, ...props,
    }));
  });
  return { onExport, host: host! };
}

const buttons = () => [...host!.querySelectorAll('button')];
const byText = (text: string) => buttons().find((button) => button.textContent === text);
const depthButton = (depth: 8 | 16) =>
  buttons().find((button) => button.textContent === `dialogs.export.bits:{"count":${depth}}`);
const formatButtons = () => {
  const row = [...host!.querySelectorAll('.export-row')]
    .find((candidate) => candidate.textContent?.startsWith('dialogs.export.format'));
  return [...(row?.querySelectorAll('button') ?? [])].map((button) => button.textContent);
};
const click = (element: Element | null | undefined) => act(async () => (element as HTMLElement)?.click());

describe('ExportDialog 16-bit constraints', () => {
  it('keeps a locked 16 on screen with its reason and submits 8 bit', async () => {
    const { onExport } = await mount();

    const locked = depthButton(16);
    expect(locked?.disabled).toBe(true);
    expect(host!.textContent).toContain('dialogs.export.depthLocked.source8bit');

    await click(byText('TIFF'));
    await click(host!.querySelector('.dialog-submit'));
    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({
      format: 'tiff', bitDepth: 8, tiffCompression: 'deflate',
    }));
  });

  it('drops the reason once the sources can deliver 16 bit', async () => {
    await mount({ canExport16Bit: true });
    expect(depthButton(16)?.disabled).toBe(false);
    expect(host!.textContent).not.toContain('dialogs.export.depthLocked');
  });

  it('disables watermark and spot removal and submits an honest 16-bit request', async () => {
    const { onExport } = await mount({ canExport16Bit: true });

    await click(byText('TIFF'));
    await click(depthButton(16));

    const watermark = host!.querySelector('input[type="text"][disabled]') as HTMLInputElement | null;
    const spotRow = [...host!.querySelectorAll('.export-row')]
      .find((row) => row.textContent?.includes('dialogs.export.spotRemoval'));
    const spot = spotRow?.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(watermark?.disabled).toBe(true);
    expect(watermark?.placeholder).toBe('dialogs.export.unavailable16');
    expect(spot?.disabled).toBe(true);
    expect(spot?.checked).toBe(false);
    expect(host!.textContent).toContain('dialogs.export.sizeHint16');

    await click(host!.querySelector('.dialog-submit'));
    expect(onExport).toHaveBeenCalledWith(expect.objectContaining({
      format: 'tiff',
      bitDepth: 16,
      tiffCompression: 'deflate',
      watermark: undefined,
      includeRetouch: false,
    }));
  });

  it('narrows the format list to the 16-bit containers and corrects JPEG in silence', async () => {
    const { onExport } = await mount({ canExport16Bit: true });
    expect(formatButtons()).toEqual(['JPEG', 'PNG', 'WEBP', 'TIFF']);

    await click(depthButton(16));
    expect(formatButtons()).toEqual(['PNG', 'TIFF']);

    await click(host!.querySelector('.dialog-submit'));
    expect(onExport).toHaveBeenLastCalledWith(expect.objectContaining({
      format: 'tiff', bitDepth: 16,
    }));

    // Back to 8 bit the full list returns and the old choice is honoured again.
    await click(depthButton(8));
    expect(formatButtons()).toEqual(['JPEG', 'PNG', 'WEBP', 'TIFF']);
    await click(host!.querySelector('.dialog-submit'));
    expect(onExport).toHaveBeenLastCalledWith(expect.objectContaining({
      format: 'jpeg', bitDepth: 8,
    }));
  });

  it('lets the write-back target decide which formats exist at all', async () => {
    const { onExport } = await mount({
      canExport16Bit: true,
      canPushToSource: true,
      sourceLabel: 'Lychee',
      allowedSourceFormats: ['jpg', 'png'],
    });

    await click(byText('Lychee'));
    expect(formatButtons()).toEqual(['JPEG', 'PNG']);

    await click(depthButton(16));
    expect(formatButtons()).toEqual(['PNG']);
    await click(host!.querySelector('.dialog-submit'));
    expect(onExport).toHaveBeenLastCalledWith(expect.objectContaining({
      format: 'png', bitDepth: 16, destination: 'source',
    }));
  });

  it('locks 16 with the destination as the reason when no allowed format carries it', async () => {
    await mount({
      canExport16Bit: true,
      canPushToSource: true,
      sourceLabel: 'Gallery',
      allowedSourceFormats: ['jpg'],
    });

    await click(byText('Gallery'));
    expect(depthButton(16)?.disabled).toBe(true);
    expect(host!.textContent).toContain('dialogs.export.depthLocked.destination');
  });

  it('shows compression only for TIFF and lets the user choose none', async () => {
    const { onExport } = await mount();

    expect(host!.textContent).not.toContain('dialogs.export.compressionDeflate');
    await click(byText('TIFF'));
    expect(byText('dialogs.export.compressionDeflate')?.classList.contains('active')).toBe(true);
    await click(byText('dialogs.export.compressionNone'));
    await click(host!.querySelector('.dialog-submit'));
    expect(onExport).toHaveBeenLastCalledWith(expect.objectContaining({
      format: 'tiff', tiffCompression: 'none',
    }));

    await click(byText('PNG'));
    expect(host!.textContent).not.toContain('dialogs.export.compressionDeflate');
    await click(host!.querySelector('.dialog-submit'));
    expect(onExport).toHaveBeenLastCalledWith(expect.objectContaining({
      format: 'png', tiffCompression: undefined,
    }));
  });

  it('prices the current combination and says so when it cannot', async () => {
    await mount({ canExport16Bit: true, targetSizes: [{ width: 6000, height: 4000 }] });

    await click(byText('TIFF'));
    const sizeRow = () => [...host!.querySelectorAll('.export-row')]
      .find((row) => row.textContent?.startsWith('dialogs.export.estimatedSize'))?.textContent ?? '';
    const atEight = sizeRow();
    expect(atEight).toContain('dialogs.export.estimatedSizeValue');
    expect(atEight).toContain('MB');

    await click(depthButton(16));
    expect(sizeRow()).not.toBe(atEight);

    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    await mount({ targetSizes: [] });
    expect(host!.textContent).toContain('dialogs.export.estimatedSizeUnknown');
  });
});
