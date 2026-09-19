import {
  createSourceFetch,
  resolveSourceTransportMode,
  type SourceFetch,
  type SourceTransportMode,
} from '../platform/sourceTransport';

/**
 * Shared scaffolding for HTTP-based source providers (Cluster A in the
 * cleanup plan). Subclasses must implement `authHeaders()` and the
 * SourceProvider interface methods themselves — this base only provides
 * helpers for the patterns that 13+ providers were duplicating: baseUrl
 * trimming, header construction, JSON GET/POST/PATCH/DELETE,
 * object-URL fetching with auth, and page-number pagination loops.
 *
 * Intentionally does NOT implement SourceProvider — subclasses do that
 * directly so TypeScript still enforces the full contract per provider.
 */
export abstract class BaseHttpSource {
  readonly id: string;
  readonly label: string;
  protected baseUrl: string;
  protected readonly request: SourceFetch;
  protected readonly transportMode: SourceTransportMode;

  constructor(
    id: string,
    label: string,
    serverUrl: string,
    transport?: SourceTransportMode,
    sourceType?: string,
  ) {
    this.id = id;
    this.label = label;
    this.baseUrl = serverUrl.replace(/\/+$/, '');
    this.transportMode = resolveSourceTransportMode(transport, sourceType);
    this.request = createSourceFetch(this.transportMode);
  }

  protected abstract authHeaders(): Record<string, string>;

  protected jsonHeaders(): Record<string, string> {
    return {
      ...this.authHeaders(),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };
  }

  protected multipartHeaders(): Record<string, string> {
    return { ...this.authHeaders(), 'Accept': 'application/json' };
  }

  protected resolveUrl(url: string): string {
    if (url.startsWith('http')) return url;
    return `${this.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  /**
   * Credentials belong to the configured source origin only. Some providers
   * return public CDN URLs for image variants; those may be fetched, but must
   * never receive the source's Authorization header.
   */
  private authHeadersForUrl(url: string): Record<string, string> {
    try {
      const target = new URL(this.resolveUrl(url));
      const source = new URL(this.baseUrl);
      return target.origin === source.origin ? this.authHeaders() : {};
    } catch {
      // Invalid/relative-to-an-invalid-base input fails closed for credentials;
      // the request layer will reject the URL itself.
      return {};
    }
  }

  /** GET → JSON. Returns null on network error, non-2xx, or parse error. */
  protected async getJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    try {
      const res = await this.request(this.resolveUrl(path), {
        method: 'GET',
        headers: this.jsonHeaders(),
        signal,
      });
      if (!res.ok) return null;
      return await res.json() as T;
    } catch {
      return null;
    }
  }

  /** POST JSON body → JSON response. Returns null on failure. */
  protected async postJson<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await this.request(this.resolveUrl(path), {
        method: 'POST',
        headers: this.jsonHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (!text) return null;
      try { return JSON.parse(text) as T; } catch { return null; }
    } catch {
      return null;
    }
  }

  /** POST JSON, return raw text. Useful when responses are bare strings. */
  protected async postText(path: string, body: unknown): Promise<string | null> {
    try {
      const res = await this.request(this.resolveUrl(path), {
        method: 'POST',
        headers: this.jsonHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  /** Fire-and-forget JSON request returning only an ok-flag. */
  protected async sendJson(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<boolean> {
    try {
      const res = await this.request(this.resolveUrl(path), {
        method,
        headers: this.jsonHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Fetch a binary URL with auth. `onMissing` hears a deleted upstream asset. */
  protected async fetchAsBlob(
    url: string,
    onMissing?: () => void,
    signal?: AbortSignal,
  ): Promise<Blob | null> {
    if (signal?.aborted) return null;
    try {
      const res = await this.request(this.resolveUrl(url), {
        headers: this.authHeadersForUrl(url),
        signal,
      });
      if (!res.ok) {
        if (res.status === 400 || res.status === 404) onMissing?.();
        return null;
      }
      const blob = await res.blob();
      return signal?.aborted ? null : blob;
    } catch {
      return null;
    }
  }

  /** Fetch a binary URL with auth → object-URL. Returns null on failure. */
  protected async fetchAsObjectUrl(url: string, onMissing?: () => void): Promise<string | null> {
    const blob = await this.fetchAsBlob(url, onMissing);
    return blob ? URL.createObjectURL(blob) : null;
  }

  /** Fetch a binary URL with auth → File. Returns null on failure; see `fetchAsObjectUrl`. */
  protected async fetchAsFile(
    url: string,
    name: string,
    onMissing?: () => void,
    signal?: AbortSignal,
  ): Promise<File | null> {
    if (signal?.aborted) return null;
    try {
      const res = await this.request(this.resolveUrl(url), {
        headers: this.authHeadersForUrl(url),
        signal,
      });
      if (!res.ok) {
        if (res.status === 400 || res.status === 404) onMissing?.();
        return null;
      }
      const blob = await res.blob();
      if (signal?.aborted) return null;
      return new File([blob], name, { type: blob.type });
    } catch {
      return null;
    }
  }

  /**
   * Page-number pagination. `pathBuilder(page)` returns the URL for page N
   * (1-indexed); `extract` pulls items + current/last page from the body.
   * Stops when current >= last or on the first failed page, which
   * `onFailedPage` hears about.
   */
  protected async *paginatePageNum<T>(
    pathBuilder: (page: number) => string,
    extract: (body: unknown) => { items: T[]; current?: number; last?: number },
    signal?: AbortSignal,
    onFailedPage?: (path: string) => void,
  ): AsyncIterable<T> {
    let page = 1;
    while (true) {
      const path = pathBuilder(page);
      const body = await this.getJson<unknown>(path, signal);
      if (body === null) {
        onFailedPage?.(path);
        return;
      }
      const { items, current, last } = extract(body);
      for (const item of items) yield item;
      const cur = current ?? page;
      const lst = last ?? cur;
      if (cur >= lst) return;
      page = cur + 1;
    }
  }
}
