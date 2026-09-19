import type { SourceProvider, PhotoRef, SourceBrowseItem } from './types';
import {
  createSourceFetch,
  resolveSourceTransportMode,
  type SourceFetch,
  type SourceTransportConfig,
  type SourceTransportMode,
} from '../platform/sourceTransport';
import {
  buildDavResourceUrl,
  normalizeDavRelativePath,
  normalizeDavRootUrl,
  resolveDavHref,
} from './webdavUrl';
import {
  classifySourceConnectionFailure,
  classifySourceConnectionResponse,
  type SourceConnectionError,
} from './connectionError';
import { ListingFailures } from './IncompleteListingError';
import { SIDECAR_DIR, photoDirOf, sidecarPathFor } from './sidecarPath';

export interface WebDAVConfig extends SourceTransportConfig {
  url: string;
  username: string;
  password: string;
  basePath?: string;
  selectedPaths?: string[];
}

const IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/tiff',
  'image/bmp', 'image/avif', 'image/heic', 'image/heif',
]);
const isHeifName = (name: string): boolean => /\.(?:heic|heif|hif)$/i.test(name);
const RAW_EXTENSIONS = new Set([
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng', 'orf', 'raf',
  'rw2', 'rwl', 'pef', 'ptx', 'srw', 'x3f', 'erf', 'mef', 'mos', 'mrw',
  'kdc', 'dcr', 'raw', '3fr', 'fff', 'iiq', 'rwz',
]);
const isRawName = (name: string): boolean => RAW_EXTENSIONS.has(name.split('.').pop()?.toLowerCase() ?? '');

export class WebDAVSource implements SourceProvider {
  readonly type = 'webdav';
  private readonly rootUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly selectedPaths: string[];
  private readonly request: SourceFetch;
  private readonly transportMode: SourceTransportMode;
  private connectionError: SourceConnectionError | null = null;

  readonly id: string;
  readonly label: string;

  constructor(
    id: string,
    label: string,
    config: WebDAVConfig,
  ) {
    this.id = id;
    this.label = label;
    this.rootUrl = normalizeDavRootUrl(config.url, config.basePath);
    this.username = config.username;
    this.password = config.password;
    this.selectedPaths = Array.from(new Set(
      (config.selectedPaths ?? []).map(normalizeDavRelativePath).filter(Boolean),
    ));
    this.transportMode = resolveSourceTransportMode(config.transport, 'webdav');
    this.request = createSourceFetch(this.transportMode);
  }

  private authHeaders(): Record<string, string> {
    return {
      'Authorization': 'Basic ' + btoa(`${this.username}:${this.password}`),
    };
  }

  async connect(): Promise<boolean> {
    this.connectionError = null;
    try {
      const res = await this.request(this.rootUrl, {
        method: 'PROPFIND',
        headers: { ...this.authHeaders(), 'Depth': '0' },
      });
      if (res.ok || res.status === 207) return true;
      this.connectionError = await classifySourceConnectionResponse(
        res,
        this.transportMode,
        this.label || 'WebDAV',
      );
      return false;
    } catch (cause) {
      this.connectionError = classifySourceConnectionFailure(
        cause,
        this.transportMode,
        this.label || 'WebDAV',
      );
      return false;
    }
  }

  getConnectionError(): SourceConnectionError | null {
    return this.connectionError;
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(path?: string, signal?: AbortSignal): AsyncIterable<PhotoRef> {
    const roots = path !== undefined
      ? [normalizeDavRelativePath(path)]
      : this.selectedPaths.length > 0 ? this.selectedPaths : [''];
    const visitedDirectories = new Set<string>();
    const emittedPhotos = new Set<string>();
    const failures = new ListingFailures();

    for (const root of roots) {
      for await (const photo of this.propfindRecursive(root, visitedDirectories, failures.record, signal)) {
        if (emittedPhotos.has(photo.sourcePhotoId)) continue;
        emittedPhotos.add(photo.sourcePhotoId);
        yield photo;
      }
    }
    failures.finish(this.label || 'WebDAV', signal);
  }

  private async *propfindRecursive(
    currentPath: string,
    visitedDirectories: Set<string>,
    onFailure: (what: string) => void,
    signal?: AbortSignal,
  ): AsyncIterable<PhotoRef> {
    const normalizedPath = normalizeDavRelativePath(currentPath);
    if (visitedDirectories.has(normalizedPath)) return;
    visitedDirectories.add(normalizedPath);

    const requestUrl = buildDavResourceUrl(this.rootUrl, normalizedPath, true);
    const res = await this.request(requestUrl, {
      method: 'PROPFIND',
      headers: { ...this.authHeaders(), 'Depth': '1', 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0" encoding="utf-8"?>
        <propfind xmlns="DAV:">
          <prop>
            <resourcetype/><getcontenttype/><getcontentlength/><getlastmodified/>
          </prop>
        </propfind>`,
      signal,
    });

    if (!res.ok && res.status !== 207) {
      throw new Error(`WebDAV PROPFIND failed for ${normalizedPath || '/'}: ${res.status}`);
    }

    const text = await res.text();
    const doc = parseDavXml(text);
    const responses = doc.getElementsByTagNameNS('DAV:', 'response');
    const childPrefix = normalizedPath ? `${normalizedPath}/` : '';

    for (const response of Array.from(responses)) {
      const href = response.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
      if (!href) continue;

      let entry;
      try {
        entry = resolveDavHref(this.rootUrl, requestUrl, href);
      } catch {
        // Never follow malformed, cross-origin, or outside-root DAV responses.
        continue;
      }
      if (entry.relativePath === normalizedPath) continue;
      if (normalizedPath && !entry.relativePath.startsWith(childPrefix)) continue;

      const name = entry.name;
      if (!name || name.startsWith('.')) continue;

      const isCollection = response.getElementsByTagNameNS('DAV:', 'collection').length > 0;
      const contentType = response.getElementsByTagNameNS('DAV:', 'getcontenttype')[0]?.textContent ?? '';
      const contentLength = response.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent;
      const lastModified = response.getElementsByTagNameNS('DAV:', 'getlastmodified')[0]?.textContent;

      if (isCollection) {
        try {
          yield* this.propfindRecursive(entry.relativePath, visitedDirectories, onFailure, signal);
        } catch (error) {
          // Keep a partial scan useful when a nested directory denies access.
          onFailure(`${entry.relativePath} (${error instanceof Error ? error.message : String(error)})`);
          continue;
        }
      } else if (IMAGE_TYPES.has(contentType) || isHeifName(name) || isRawName(name)) {
        yield {
          sourcePhotoId: entry.relativePath,
          sourceId: this.id,
          name,
          mimeType: IMAGE_TYPES.has(contentType)
            ? contentType
            : isRawName(name) ? 'image/x-raw' : 'image/heif',
          sizeBytes: contentLength ? Number(contentLength) : undefined,
          dateModified: lastModified ? new Date(lastModified).getTime() : undefined,
        };
      }
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const res = await this.request(buildDavResourceUrl(this.rootUrl, ref.sourcePhotoId), {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    // Try Nextcloud/ownCloud preview endpoint (works regardless of URL naming)
    const remoteDavIdx = this.rootUrl.indexOf('/remote.php');
    if (remoteDavIdx !== -1) {
      const baseUrl = this.rootUrl.substring(0, remoteDavIdx);
      // Nextcloud core preview API
      try {
        const res = await this.request(
          `${baseUrl}/index.php/core/preview?file=${encodeURIComponent('/' + ref.sourcePhotoId)}&x=300&y=300&a=1`,
          { headers: this.authHeaders(), signal },
        );
        if (res.ok) {
          const blob = await res.blob();
          if (signal?.aborted) return null;
          if (blob.size > 0) return URL.createObjectURL(blob);
        }
      } catch { /* fallthrough */ }
      if (signal?.aborted) return null;
      // Nextcloud preview.php fallback (older versions)
      try {
        const res = await this.request(
          `${baseUrl}/index.php/apps/files/api/v1/thumbnail/300/300/${encodeURIComponent(ref.sourcePhotoId)}`,
          { headers: this.authHeaders(), signal },
        );
        if (res.ok) {
          const blob = await res.blob();
          if (signal?.aborted) return null;
          if (blob.size > 0) return URL.createObjectURL(blob);
        }
      } catch { /* fallthrough */ }
    }
    return null;
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    try {
      const res = await this.request(buildDavResourceUrl(this.rootUrl, ref.sourcePhotoId), {
        headers: this.authHeaders(),
        signal,
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (signal?.aborted) return null;
      return new File([blob], ref.name, { type: blob.type });
    } catch {
      return null;
    }
  }

  /** Server-DNS RAW fast path. Browser-DNS mode must keep the fetch local. */
  getRemoteFetchHint(ref: PhotoRef): { url: string; headers: Record<string, string> } | null {
    if (this.transportMode === 'browser-direct') return null;
    return {
      url: buildDavResourceUrl(this.rootUrl, ref.sourcePhotoId),
      headers: this.authHeaders(),
    };
  }

  // ─── Extended capabilities ───

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    try {
      const requestUrl = buildDavResourceUrl(this.rootUrl, '', true);
      const res = await this.request(requestUrl, {
        method: 'PROPFIND',
        headers: { ...this.authHeaders(), 'Depth': '1', 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><displayname/></prop></propfind>`,
      });
      if (!res.ok && res.status !== 207) return [];

      const text = await res.text();
      const doc = parseDavXml(text);
      const responses = doc.getElementsByTagNameNS('DAV:', 'response');
      const items: SourceBrowseItem[] = [];

      for (const response of Array.from(responses)) {
        const isCollection = response.getElementsByTagNameNS('DAV:', 'collection').length > 0;
        if (!isCollection) continue;
        const href = response.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
        let entry;
        try {
          entry = resolveDavHref(this.rootUrl, requestUrl, href);
        } catch {
          continue;
        }
        if (entry.isRoot || !entry.name || entry.name.startsWith('.')) continue;
        // A Depth: 1 response should contain only direct children.
        if (entry.relativePath.includes('/')) continue;
        items.push({ id: entry.relativePath, name: entry.name, type: 'folder' });
      }
      return items;
    } catch {
      return [];
    }
  }

  async writeSidecar(ref: PhotoRef, data: string): Promise<boolean> {
    try {
      const dir = photoDirOf(ref.sourcePhotoId);
      const sidecarDir = buildDavResourceUrl(this.rootUrl, joinDavPath(dir, SIDECAR_DIR), true);
      // Ensure the sidecar directory
      await this.request(sidecarDir, { method: 'MKCOL', headers: this.authHeaders() }).catch(() => {});
      const sidecarUrl = buildDavResourceUrl(this.rootUrl, sidecarPathFor(dir, safeDavName(ref.name)));
      const res = await this.request(sidecarUrl, {
        method: 'PUT',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: data,
      });
      return res.ok || res.status === 201 || res.status === 204;
    } catch {
      return false;
    }
  }

  async readSidecar(ref: PhotoRef): Promise<string | null> {
    try {
      const sidecarUrl = buildDavResourceUrl(
        this.rootUrl,
        sidecarPathFor(photoDirOf(ref.sourcePhotoId), safeDavName(ref.name)),
      );
      const res = await this.request(sidecarUrl, { headers: this.authHeaders() });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const dir = ref.sourcePhotoId.includes('/') ? ref.sourcePhotoId.substring(0, ref.sourcePhotoId.lastIndexOf('/')) : '';
      const name = safeDavName(ref.name);
      const editName = `${name.replace(/\.[^.]+$/, '')}_edit.${name.split('.').pop()}`;
      const uploadUrl = buildDavResourceUrl(this.rootUrl, joinDavPath(dir, editName));
      const res = await this.request(uploadUrl, {
        method: 'PUT',
        headers: { ...this.authHeaders(), 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
      return res.ok || res.status === 201 || res.status === 204;
    } catch {
      return false;
    }
  }

  async createAlbum(name: string): Promise<string | null> {
    try {
      const albumName = safeDavName(name);
      const res = await this.request(buildDavResourceUrl(this.rootUrl, albumName, true), {
        method: 'MKCOL',
        headers: this.authHeaders(),
      });
      return (res.ok || res.status === 201) ? albumName : null;
    } catch {
      return null;
    }
  }
}

function safeDavName(name: string): string {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name === '.' || name === '..') {
    throw new Error('Invalid WebDAV file name');
  }
  return name;
}

function joinDavPath(base: string, ...names: string[]): string {
  const normalizedBase = normalizeDavRelativePath(base);
  const safeNames = names.map(safeDavName);
  return [normalizedBase, ...safeNames].filter(Boolean).join('/');
}

function parseDavXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('WebDAV returned invalid XML');
  }
  return doc;
}
