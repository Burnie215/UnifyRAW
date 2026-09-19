import type { CatalogStorage } from './CatalogStorage';

/**
 * Flushes the catalog when the page is hidden or unloaded. Neither event can
 * hold the page open for the async write, so this only starts it early; the
 * short idle time of the flush throttle is what bounds the loss. Returns the
 * function that removes both listeners.
 */
export function attachLifecycleFlush(
  storage: CatalogStorage,
  doc: Document = document,
  win: Window = window,
): () => void {
  const flush = () => {
    void storage.flushNow().catch((e) => console.warn('[storage] lifecycle flush failed', e));
  };
  const onVisibilityChange = () => {
    if (doc.visibilityState === 'hidden') flush();
  };
  doc.addEventListener('visibilitychange', onVisibilityChange);
  win.addEventListener('pagehide', flush);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    win.removeEventListener('pagehide', flush);
  };
}
