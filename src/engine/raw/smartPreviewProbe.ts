import { apiFetch } from '../../platform/api';

export type SmartPreviewFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Ask the backend whether it already holds the Smart Preview for `key`.
 *
 * The POST route answers from its cache too, but only after the browser has
 * pushed the whole RAW (up to RAW_MAX_UPLOAD_MB) up the wire (F054). This
 * probe is a few hundred bytes, so a hit — a second device, a second browser,
 * an OPFS wiped by "Clear site data" — saves the upload entirely.
 *
 * Returns null for every miss: 404 is the normal one, any other status or a
 * network error is reported once and then left to the POST that follows,
 * which surfaces the real error. An abort is rethrown so the caller can drop
 * the whole decode instead of starting an upload nobody waits for.
 */
export async function probeSmartPreviewCache(
  key: string,
  size: number,
  fetchImpl: SmartPreviewFetch = apiFetch,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const url = `/api/raw/smart-preview/${encodeURIComponent(key)}?size=${size}`;
  let response: Response;
  try {
    response = await fetchImpl(url, signal ? { signal } : undefined);
  } catch (e) {
    if (isAbortError(e)) throw e;
    console.warn('[SmartPreview] cache probe failed, falling back to upload:', e);
    return null;
  }
  if (response.ok) return response.blob();
  if (response.status !== 404) {
    console.warn(`[SmartPreview] cache probe failed with HTTP ${response.status}, falling back to upload`);
  }
  return null;
}

// Not `instanceof Error`: fetch rejects with a DOMException, which only some
// runtimes derive from Error.
function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}
