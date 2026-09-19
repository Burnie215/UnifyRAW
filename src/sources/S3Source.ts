import type { SourceProvider, PhotoRef, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';
import { photoDirOf, sidecarPathFor } from './sidecarPath';

export interface S3Config {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  prefix?: string;
}

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'hif',
  'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'raf', 'rw2',
]);

export class S3Source implements SourceProvider {
  readonly type = 's3';
  private endpoint: string;
  private bucket: string;
  private prefix: string;

  readonly id: string;
  readonly label: string;

  constructor(
    id: string,
    label: string,
    config: S3Config,
  ) {
    this.id = id;
    this.label = label;
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.bucket = config.bucket;
    this.prefix = config.prefix ?? '';
  }

  private authHeaders(): Record<string, string> {
    throw new Error('S3: AWS Signature V4 request signing is not implemented');
  }

  async connect(): Promise<boolean> {
    try {
      const url = `${this.endpoint}/${this.bucket}?list-type=2&max-keys=1&prefix=${encodeURIComponent(this.prefix)}`;
      const res = await proxyFetch(url, { headers: this.authHeaders() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(): AsyncIterable<PhotoRef> {
    let continuationToken: string | undefined;

    while (true) {
      const params = new URLSearchParams({
        'list-type': '2',
        'max-keys': '500',
        'prefix': this.prefix,
      });
      if (continuationToken) params.set('continuation-token', continuationToken);

      const url = `${this.endpoint}/${this.bucket}?${params}`;
      const res = await proxyFetch(url, { headers: this.authHeaders() });
      if (!res.ok) break;

      const text = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'application/xml');

      const contents = doc.getElementsByTagName('Contents');
      if (contents.length === 0) break;

      for (const item of Array.from(contents)) {
        const key = item.getElementsByTagName('Key')[0]?.textContent ?? '';
        const size = item.getElementsByTagName('Size')[0]?.textContent;
        const lastModified = item.getElementsByTagName('LastModified')[0]?.textContent;
        const name = key.split('/').pop() ?? '';
        const ext = name.split('.').pop()?.toLowerCase() ?? '';

        if (name.startsWith('.') || !IMAGE_EXTENSIONS.has(ext)) continue;

        const relPath = this.prefix ? key.replace(this.prefix, '') : key;

        yield {
          sourcePhotoId: relPath,
          sourceId: this.id,
          name,
          sizeBytes: size ? Number(size) : undefined,
          dateModified: lastModified ? new Date(lastModified).getTime() : undefined,
        };
      }

      const isTruncated = doc.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
      if (!isTruncated) break;
      continuationToken = doc.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? undefined;
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const key = this.prefix + ref.sourcePhotoId;
    const url = `${this.endpoint}/${this.bucket}/${encodeURIComponent(key)}`;
    const res = await proxyFetch(url, { headers: this.authHeaders() });
    if (!res.ok) throw new Error(`S3 GET failed: ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  async getThumbnailUrl(): Promise<string | null> {
    return null; // Generate locally
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    try {
      const key = this.prefix + ref.sourcePhotoId;
      const url = `${this.endpoint}/${this.bucket}/${encodeURIComponent(key)}`;
      const res = await proxyFetch(url, { headers: this.authHeaders(), signal });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (signal?.aborted) return null;
      return new File([blob], ref.name, { type: blob.type });
    } catch {
      return null;
    }
  }

  // ─── Extended capabilities ───

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    try {
      // Use delimiter to get "folder" prefixes
      const params = new URLSearchParams({
        'list-type': '2',
        'delimiter': '/',
        'prefix': this.prefix,
      });
      const url = `${this.endpoint}/${this.bucket}?${params}`;
      const res = await proxyFetch(url, { headers: this.authHeaders() });
      if (!res.ok) return [];

      const text = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'application/xml');
      const prefixes = doc.getElementsByTagName('CommonPrefixes');
      const items: SourceBrowseItem[] = [];

      for (const p of Array.from(prefixes)) {
        const prefixText = p.getElementsByTagName('Prefix')[0]?.textContent ?? '';
        const name = prefixText.replace(this.prefix, '').replace(/\/$/, '');
        if (!name || name.startsWith('.')) continue;
        items.push({ id: prefixText, name, type: 'folder' });
      }
      return items;
    } catch {
      return [];
    }
  }

  async writeSidecar(ref: PhotoRef, data: string): Promise<boolean> {
    try {
      const key = `${this.prefix}${sidecarPathFor(photoDirOf(ref.sourcePhotoId), ref.name)}`;
      const url = `${this.endpoint}/${this.bucket}/${encodeURIComponent(key)}`;
      const res = await proxyFetch(url, {
        method: 'PUT',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: data,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async readSidecar(ref: PhotoRef): Promise<string | null> {
    try {
      const key = `${this.prefix}${sidecarPathFor(photoDirOf(ref.sourcePhotoId), ref.name)}`;
      const url = `${this.endpoint}/${this.bucket}/${encodeURIComponent(key)}`;
      const res = await proxyFetch(url, { headers: this.authHeaders() });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const dir = ref.sourcePhotoId.includes('/') ? ref.sourcePhotoId.substring(0, ref.sourcePhotoId.lastIndexOf('/') + 1) : '';
      const editName = `${ref.name.replace(/\.[^.]+$/, '')}_edit.${ref.name.split('.').pop()}`;
      const key = `${this.prefix}${dir}${editName}`;
      const url = `${this.endpoint}/${this.bucket}/${encodeURIComponent(key)}`;
      const res = await proxyFetch(url, {
        method: 'PUT',
        headers: { ...this.authHeaders(), 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
