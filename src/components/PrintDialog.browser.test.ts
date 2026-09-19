/**
 * What the print dialog actually sends to the printer.
 *
 * The bug this measures: the dialog counted pages honestly ("9 page(s) for 35
 * photos") but `handlePrint` rendered ONE canvas and put that one image in the
 * print window, so every photo past the first cellful was silently dropped.
 * The assertion is the pair - the number of pages the dialog promises and the
 * number of sheets in the print window have to be the same number.
 *
 * Browser-mode-only: renderPrintPage needs a real canvas and the page images
 * have to actually decode for `onload` to fire.
 * Run with: npx vitest run --project browser PrintDialog
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** `t:` in front, so a string that reached the DOM WITHOUT going through the
 *  translator is distinguishable from one that did. */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts ? `t:${key} ${JSON.stringify(opts)}` : `t:${key}`),
  }),
}));

import { PrintDialog } from './PrintDialog';
import { PRINT_LAYOUTS } from '../engine/PrintEngine';
import type { RenderedFrame } from '../engine/Exporter';
import type { PrintTarget } from '../hooks/useDialogState';
import type { PhotoView } from '../storage/repos';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

/** A flat frame of its own shade, so two sheets of the same layout cannot come
 *  out as the same data URL and pass a "how many sheets" test by accident. */
function frame(value: number, width = 24, height = 16): RenderedFrame {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = value;
    pixels[i * 4 + 1] = value;
    pixels[i * 4 + 2] = value;
    pixels[i * 4 + 3] = 255;
  }
  return { width, height, pixels, colorSpace: 'srgb' };
}

function targetsOf(count: number): PrintTarget[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `photo-${i}.jpg`,
    // A real PhotoView always has a name and a sourceId; the dialog reads both
    // to decide what "native" delivers for this photo (RawDecoder.isRawFile,
    // sourceManager.get). Leaving them off made the cast a lie and the memo throw.
    photo: { id: i + 1, width: 24, height: 16, name: `photo-${i}.jpg`, sourceId: 'fixture' } as unknown as PhotoView,
  }));
}

const renderTarget = (photo: PhotoView) => Promise.resolve(frame(20 + photo.id * 30));

/** The window `handlePrint` opens, with a real element to append into so the
 *  page images genuinely decode. */
function stubPrintWindow() {
  const body = document.createElement('div');
  body.style.cssText = 'position:fixed;left:-10000px;top:0;';
  document.body.appendChild(body);
  const seen = { printed: 0, closed: 0, body };
  const fake = {
    document: {
      write: () => {},
      createElement: (tag: string) => document.createElement(tag),
      body,
    },
    print: () => { seen.printed += 1; },
    close: () => { seen.closed += 1; },
  } as unknown as Window;
  vi.spyOn(window, 'open').mockImplementation(() => fake);
  cleanups.push(() => body.remove());
  return seen;
}

const selectValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;

async function until(predicate: () => boolean, what: string, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }
}

function submitButton(host: HTMLElement): HTMLButtonElement {
  return host.querySelector<HTMLButtonElement>('.dialog-submit')!;
}

/** The dialog re-renders every photo whenever the cell size moves, so every
 *  settings change has to be waited out before the page count means anything. */
const settle = (host: HTMLElement) =>
  until(() => !submitButton(host).disabled, 'the dialog to be ready to print');

async function mount(targets: PrintTarget[]): Promise<HTMLElement> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:700px;';
  document.body.appendChild(host);
  let root!: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(createElement(PrintDialog, {
      open: true, onClose: () => {}, targets, renderTarget,
    }));
  });
  cleanups.push(() => { act(() => root.unmount()); host.remove(); });
  await settle(host);
  return host;
}

/** Drives one of the dialog's selects (paper, layout, DPI, image resolution,
 *  sharpening) and waits for the re-render it triggers. */
async function choose(host: HTMLElement, index: number, value: string): Promise<void> {
  const select = host.querySelectorAll('select')[index];
  await act(async () => {
    selectValue.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle(host);
}

async function print(host: HTMLElement, win: { printed: number }): Promise<void> {
  await act(async () => { submitButton(host).click(); });
  await until(() => win.printed === 1, 'the print window to print');
}

describe('print dialog paging', () => {
  it('puts one sheet in the print window for every page it promises', async () => {
    const win = stubPrintWindow();
    const created = vi.spyOn(URL, 'createObjectURL');
    const revoked = vi.spyOn(URL, 'revokeObjectURL');
    const host = await mount(targetsOf(3));
    // 150 DPI keeps three A4 sheets to a size a test can encode as PNG.
    await choose(host, 2, '150');

    const promise = host.querySelector('.print-pages-info')!.textContent!;
    expect(promise).toContain('dialogs.print.pagesFor');
    // One photo per sheet at the default single-image layout.
    expect(promise).toContain('"pages":3');
    expect(promise).toContain('"photos":3');

    await print(host, win);

    expect(win.body.querySelectorAll('.print-page').length).toBe(3);
    expect(win.body.querySelectorAll('.print-page img').length).toBe(3);
    expect(win.closed).toBe(1);

    // Three different sheets, not the first one three times.
    const sources = new Set([...win.body.querySelectorAll('img')].map((img) => img.src));
    expect(sources.size).toBe(3);
    expect(created).toHaveBeenCalledTimes(3);
    expect(revoked.mock.calls.map(([url]) => url)).toEqual(
      created.mock.results.map(({ value }) => value),
    );
  });

  it('fills each sheet with a whole cellful before starting the next', async () => {
    const win = stubPrintWindow();
    const host = await mount(targetsOf(5));
    await choose(host, 1, 'grid-2x2');
    await choose(host, 2, '150');

    expect(host.querySelector('.print-pages-info')!.textContent).toContain('"pages":2');

    await print(host, win);
    expect(win.body.querySelectorAll('.print-page').length).toBe(2);
  });

  it('takes the layout names from i18n, not from the engine', async () => {
    const host = await mount(targetsOf(1));
    const options = [...host.querySelectorAll('select')[1].options].map((o) => o.textContent);
    // The mocked `t` answers with the key, so an untranslated German literal
    // out of PRINT_LAYOUTS would show up here as itself.
    expect(options).toEqual(PRINT_LAYOUTS.map((l) => `t:${l.labelKey}`));
  });

  it('says nothing about pages when everything fits on one sheet', async () => {
    const host = await mount(targetsOf(4));
    await choose(host, 1, 'grid-2x2');
    expect(host.querySelector('.print-pages-info')).toBeNull();
  });
});
