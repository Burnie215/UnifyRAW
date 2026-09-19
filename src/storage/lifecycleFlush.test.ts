import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogStorage } from './CatalogStorage';
import { attachLifecycleFlush } from './lifecycleFlush';

type FakeDocument = EventTarget & { visibilityState: DocumentVisibilityState };

function setup(flushNow: () => Promise<void> = () => Promise.resolve()) {
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' }) as FakeDocument;
  const win = new EventTarget();
  const storage = { flushNow: vi.fn(flushNow) };
  const detach = attachLifecycleFlush(storage as unknown as CatalogStorage, doc as unknown as Document, win as unknown as Window);
  const hide = () => {
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  const show = () => {
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
  };
  const pagehide = () => win.dispatchEvent(new Event('pagehide'));
  return { storage, detach, hide, show, pagehide };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('attachLifecycleFlush', () => {
  it('flushes once when the page is hidden, not when it comes back', () => {
    const { storage, hide, show } = setup();
    hide();
    expect(storage.flushNow).toHaveBeenCalledTimes(1);
    show();
    expect(storage.flushNow).toHaveBeenCalledTimes(1);
  });

  it('flushes on pagehide', () => {
    const { storage, pagehide } = setup();
    pagehide();
    expect(storage.flushNow).toHaveBeenCalledTimes(1);
  });

  it('stops listening once detached', () => {
    const { storage, detach, hide, pagehide } = setup();
    detach();
    hide();
    pagehide();
    expect(storage.flushNow).not.toHaveBeenCalled();
  });

  it('logs a failed flush instead of leaving it unhandled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = new Error('disk full');
    const { pagehide } = setup(() => Promise.reject(error));
    pagehide();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[storage] lifecycle flush failed', error));
  });
});
