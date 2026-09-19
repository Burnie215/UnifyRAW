import type { SourceProvider, PhotoRef, PhotoPage, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';
import { sidecarPathFor } from './sidecarPath';

export interface OneDriveConfig {
  accessToken: string;
  refreshToken?: string;
  folderId?: string;
}

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff', 'image/heic', 'image/heif', 'image/avif']);
const isHeifName = (name: string): boolean => /\.(?:heic|heif|hif)$/i.test(name);

export class OneDriveSource implements SourceProvider {
  readonly type = 'onedrive';
  readonly id: string;
  readonly label: string;

  private accessToken: string;
  private folderId: string;

  constructor(id: string, label: string, config: OneDriveConfig) {
    this.id = id;
    this.label = label;
    this.accessToken = config.accessToken;
    this.folderId = config.folderId ?? 'root';
  }

  private headers(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.accessToken}` };
  }

  async connect(): Promise<boolean> {
    try {
      const res = await proxyFetch(`${GRAPH_BASE}/me`, { headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(): AsyncIterable<PhotoRef> {
    yield* this.listFolder(this.folderId, '');
  }

  private async *listFolder(folderId: string, path: string): AsyncIterable<PhotoRef> {
    let url: string | null = `${GRAPH_BASE}/me/drive/items/${folderId}/children?$select=id,name,size,file,folder,photo,image,lastModifiedDateTime&$expand=thumbnails&$top=200`;

    while (url) {
      try {
        const res = await proxyFetch(url, { headers: this.headers() });
        if (!res.ok) break;
        const data = await res.json();

        for (const item of data.value ?? []) {
          if (item.folder) {
            const subPath = path ? `${path}/${item.name}` : item.name;
            yield* this.listFolder(item.id, subPath);
          } else if (item.file && (IMAGE_TYPES.has(item.file.mimeType) || isHeifName(item.name))) {
            yield {
              sourcePhotoId: item.id,
              sourceId: this.id,
              name: item.name,
              mimeType: IMAGE_TYPES.has(item.file.mimeType) ? item.file.mimeType : 'image/heif',
              sizeBytes: item.size,
              dateTaken: item.photo?.takenDateTime ? new Date(item.photo.takenDateTime).getTime() : undefined,
              dateModified: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime).getTime() : undefined,
            };
          }
        }

        url = data['@odata.nextLink'] ?? null;
      } catch {
        break;
      }
    }
  }

  async listPhotosPage(): Promise<PhotoPage | null> {
    // OneDrive uses cursor-based pagination, not page numbers
    return null;
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const res = await proxyFetch(`${GRAPH_BASE}/me/drive/items/${ref.sourcePhotoId}/content`, {
      headers: this.headers(),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`OneDrive download failed: ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      const res = await proxyFetch(
        `${GRAPH_BASE}/me/drive/items/${ref.sourcePhotoId}/thumbnails/0/medium/content`,
        { headers: this.headers(), redirect: 'follow', signal },
      );
      if (!res.ok) return null;
      const blob = await res.blob();
      return signal?.aborted ? null : URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    try {
      const res = await proxyFetch(`${GRAPH_BASE}/me/drive/items/${ref.sourcePhotoId}/content`, {
        headers: this.headers(),
        redirect: 'follow',
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

  async writeSidecar(ref: PhotoRef, data: string): Promise<boolean> {
    try {
      const parentRes = await proxyFetch(`${GRAPH_BASE}/me/drive/items/${ref.sourcePhotoId}?$select=parentReference`, {
        headers: this.headers(),
      });
      if (!parentRes.ok) return false;
      const parent = await parentRes.json();
      const parentId = parent.parentReference?.id;
      if (!parentId) return false;

      const res = await proxyFetch(
        `${GRAPH_BASE}/me/drive/items/${parentId}:/${sidecarPathFor('', ref.name)}:/content`,
        {
          method: 'PUT',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: data,
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async readSidecar(ref: PhotoRef): Promise<string | null> {
    try {
      const parentRes = await proxyFetch(`${GRAPH_BASE}/me/drive/items/${ref.sourcePhotoId}?$select=parentReference`, {
        headers: this.headers(),
      });
      if (!parentRes.ok) return null;
      const parent = await parentRes.json();
      const parentId = parent.parentReference?.id;
      if (!parentId) return null;

      const res = await proxyFetch(
        `${GRAPH_BASE}/me/drive/items/${parentId}:/${sidecarPathFor('', ref.name)}:/content`,
        { headers: this.headers() },
      );
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  // ─── Extended capabilities ───

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      const res = await proxyFetch(
        `${GRAPH_BASE}/me/drive/items/${ref.sourcePhotoId}?$select=photo,image,location,name`,
        { headers: this.headers() },
      );
      if (!res.ok) return null;
      const item = await res.json();
      const photo = item.photo ?? {};
      const image = item.image ?? {};
      const loc = item.location ?? {};

      return {
        camera: photo.cameraMake && photo.cameraModel ? `${photo.cameraMake} ${photo.cameraModel}` : photo.cameraModel ?? null,
        lens: null, // OneDrive photo facet doesn't include lens
        iso: photo.iso ?? null,
        focalLength: photo.focalLength ?? null,
        aperture: photo.fNumber ?? null,
        shutterSpeed: photo.exposureNumerator && photo.exposureDenominator
          ? `${photo.exposureNumerator}/${photo.exposureDenominator}` : null,
        width: image.width ?? null,
        height: image.height ?? null,
        latitude: loc.latitude ?? null,
        longitude: loc.longitude ?? null,
        keywords: [],
        rating: null,
        favorite: false,
        title: null,
        description: null,
      };
    } catch {
      return null;
    }
  }

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    try {
      return await this.browseFolders(this.folderId);
    } catch {
      return [];
    }
  }

  private async browseFolders(parentId: string): Promise<SourceBrowseItem[]> {
    const items: SourceBrowseItem[] = [];
    let url: string | null = `${GRAPH_BASE}/me/drive/items/${parentId}/children?$select=id,name,folder&$filter=folder ne null&$top=200`;

    while (url) {
      const res = await proxyFetch(url, { headers: this.headers() });
      if (!res.ok) break;
      const data = await res.json();

      for (const item of data.value ?? []) {
        if (!item.folder) continue;
        const children = await this.browseFolders(item.id);
        items.push({
          id: item.id,
          name: item.name,
          type: 'folder',
          photoCount: item.folder.childCount,
          children: children.length > 0 ? children : undefined,
        });
      }
      url = data['@odata.nextLink'] ?? null;
    }
    return items;
  }

  async setTitle(ref: PhotoRef, title: string): Promise<boolean> {
    try {
      // OneDrive: rename file
      const ext = ref.name.split('.').pop() ?? '';
      const newName = ext ? `${title}.${ext}` : title;
      const res = await proxyFetch(`${GRAPH_BASE}/me/drive/items/${ref.sourcePhotoId}`, {
        method: 'PATCH',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      // Get parent folder of original
      const parentRes = await proxyFetch(`${GRAPH_BASE}/me/drive/items/${ref.sourcePhotoId}?$select=parentReference`, {
        headers: this.headers(),
      });
      if (!parentRes.ok) return false;
      const parent = await parentRes.json();
      const parentId = parent.parentReference?.id;
      if (!parentId) return false;

      const editName = `${ref.name.replace(/\.[^.]+$/, '')}_edit.${ref.name.split('.').pop()}`;
      const res = await proxyFetch(
        `${GRAPH_BASE}/me/drive/items/${parentId}:/${editName}:/content`,
        {
          method: 'PUT',
          headers: { ...this.headers(), 'Content-Type': blob.type || 'application/octet-stream' },
          body: blob,
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async createAlbum(name: string): Promise<string | null> {
    try {
      const res = await proxyFetch(`${GRAPH_BASE}/me/drive/items/${this.folderId}/children`, {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, folder: {} }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.id ?? null;
    } catch {
      return null;
    }
  }
}
