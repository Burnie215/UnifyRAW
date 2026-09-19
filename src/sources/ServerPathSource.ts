import type { SourceProvider, PhotoRef, PhotoPage, SourceBrowseItem } from './types';
import { apiFetch } from '../platform/api';
import type { BackendBrowseResponse } from './backendBrowseTypes';

export interface ServerPathConfig {
  serverUrl: string;
  rootPath: string;
}

export class ServerPathSource implements SourceProvider {
  readonly type = 'server-path';
  private serverUrl: string;
  private rootPath: string;

  readonly id: string;
  readonly label: string;

  constructor(
    id: string,
    label: string,
    config: ServerPathConfig,
  ) {
    this.id = id;
    this.label = label;
    this.serverUrl = config.serverUrl.replace(/\/+$/, '');
    this.rootPath = config.rootPath;
  }

  async connect(): Promise<boolean> {
    try {
      const res = await apiFetch(`${this.serverUrl}/api/files/validate`, {
        method: 'POST',
        body: JSON.stringify({ path: this.rootPath }),
      });
      if (!res.ok) return false;
      const data = await res.json() as { valid?: boolean };
      return data.valid === true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(subPath?: string): AsyncIterable<PhotoRef> {
    let page = 1;
    const pageSize = 200;
    const browsePath = subPath ? `${this.rootPath}/${subPath}` : this.rootPath;

    while (true) {
      const result = await this.browsePage(page, pageSize, browsePath);
      if (!result || result.photos.length === 0) break;
      for (const photo of result.photos) yield photo;
      if (!result.hasMore) break;
      page++;
    }
  }

  async listPhotosPage(page: number, pageSize: number): Promise<PhotoPage | null> {
    return this.browsePage(page, pageSize, this.rootPath);
  }

  // Not part of listPhotosPage: its third parameter is the caller's AbortSignal.
  private async browsePage(page: number, pageSize: number, browsePath: string): Promise<PhotoPage | null> {
    try {
      const p = browsePath;
      const res = await apiFetch(
        `${this.serverUrl}/api/files/browse?path=${encodeURIComponent(p)}&page=${page}&pageSize=${pageSize}`,
      );
      if (!res.ok) return null;
      const data = await res.json();

      // Recurse into subdirectories
      const photos: PhotoRef[] = [];
      for (const file of data.files ?? []) {
        if (file.isDir) {
          // Recurse
          for await (const sub of this.listPhotos(file.path.replace(this.rootPath + '/', ''))) {
            photos.push(sub);
          }
        } else {
          const relPath = file.path.replace(this.rootPath + '/', '');
          photos.push({
            sourcePhotoId: relPath,
            sourceId: this.id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.size,
            dateModified: file.mtime,
          });
        }
      }

      return { photos, hasMore: data.hasMore ?? false, total: data.total };
    } catch {
      return null;
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const fullPath = `${this.rootPath}/${ref.sourcePhotoId}`;
    const res = await apiFetch(
      `${this.serverUrl}/api/files/download?path=${encodeURIComponent(fullPath)}`,
    );
    if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      const fullPath = `${this.rootPath}/${ref.sourcePhotoId}`;
      const res = await apiFetch(
        `${this.serverUrl}/api/files/thumb?path=${encodeURIComponent(fullPath)}&size=300`,
        { signal },
      );
      if (!res.ok) return null;
      const blob = await res.blob();
      if (signal?.aborted) return null;
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    try {
      const fullPath = `${this.rootPath}/${ref.sourcePhotoId}`;
      const res = await apiFetch(
        `${this.serverUrl}/api/files/download?path=${encodeURIComponent(fullPath)}`,
        { signal },
      );
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
      const res = await apiFetch(
        `${this.serverUrl}/api/files/browse?path=${encodeURIComponent(this.rootPath)}&page=1&pageSize=500`,
      );
      if (!res.ok) return [];
      const data = await res.json() as BackendBrowseResponse;
      return (data.files ?? [])
        .filter((file) => file.isDir)
        .map((file) => ({
          id: file.path.replace(this.rootPath + '/', ''),
          name: file.name,
          type: 'folder' as const,
        }));
    } catch {
      return [];
    }
  }

}
