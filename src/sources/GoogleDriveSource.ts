import type { SourceProvider, PhotoRef, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';

export interface GoogleDriveConfig {
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  folderId?: string;
}

export class GoogleDriveSource implements SourceProvider {
  readonly type = 'google-drive';
  private token: string;
  private folderId: string;
  /** Cache thumbnailLink from listPhotos for getThumbnailUrl */
  private thumbLinks = new Map<string, string>();

  readonly id: string;
  readonly label: string;

  constructor(
    id: string,
    label: string,
    config: GoogleDriveConfig,
  ) {
    this.id = id;
    this.label = label;
    this.token = config.accessToken;
    this.folderId = config.folderId ?? 'root';
  }

  private headers(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.token}` };
  }

  async connect(): Promise<boolean> {
    try {
      const res = await proxyFetch('https://www.googleapis.com/drive/v3/about?fields=user', {
        headers: this.headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(): AsyncIterable<PhotoRef> {
    let pageToken: string | undefined;

    while (true) {
      const params = new URLSearchParams({
        q: `mimeType contains 'image/' and '${this.folderId}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,imageMediaMetadata,thumbnailLink)',
        pageSize: '500',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await proxyFetch(
        `https://www.googleapis.com/drive/v3/files?${params}`,
        { headers: this.headers() },
      );
      if (!res.ok) break;

      const data = await res.json();
      const files = data.files ?? [];

      for (const file of files) {
        const fileId = file.id as string;
        // Cache thumbnail link from API response
        if (file.thumbnailLink) {
          this.thumbLinks.set(fileId, file.thumbnailLink as string);
        }
        yield {
          sourcePhotoId: fileId,
          sourceId: this.id,
          name: file.name as string,
          mimeType: file.mimeType as string,
          sizeBytes: file.size ? Number(file.size) : undefined,
          dateTaken: file.createdTime ? new Date(file.createdTime as string).getTime() : undefined,
          dateModified: file.modifiedTime ? new Date(file.modifiedTime as string).getTime() : undefined,
        };
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const res = await proxyFetch(
      `https://www.googleapis.com/drive/v3/files/${ref.sourcePhotoId}?alt=media`,
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`Google Drive download failed: ${res.status}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    // Use cached thumbnailLink from listPhotos (higher res via =s300)
    const cached = this.thumbLinks.get(ref.sourcePhotoId);
    if (cached) {
      try {
        // Replace size param to get 300px thumbnail
        const thumbUrl = cached.replace(/=s\d+$/, '=s300');
        const res = await proxyFetch(thumbUrl, { headers: this.headers(), signal });
        if (res.ok) {
          const blob = await res.blob();
          if (signal?.aborted) return null;
          return URL.createObjectURL(blob);
        }
      } catch { /* fallthrough */ }
    }
    return null;
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    try {
      const res = await proxyFetch(
        `https://www.googleapis.com/drive/v3/files/${ref.sourcePhotoId}?alt=media`,
        { headers: this.headers(), signal },
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

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      const res = await proxyFetch(
        `https://www.googleapis.com/drive/v3/files/${ref.sourcePhotoId}?fields=imageMediaMetadata,name`,
        { headers: this.headers() },
      );
      if (!res.ok) return null;
      const file = await res.json();
      const m = file.imageMediaMetadata ?? {};

      return {
        camera: m.cameraMake && m.cameraModel ? `${m.cameraMake} ${m.cameraModel}` : m.cameraModel ?? null,
        lens: null,
        iso: m.isoSpeed ?? null,
        focalLength: m.focalLength ?? null,
        aperture: m.aperture ?? null,
        shutterSpeed: m.exposureTime ? String(m.exposureTime) : null,
        width: m.width ?? null,
        height: m.height ?? null,
        latitude: m.location?.latitude ?? null,
        longitude: m.location?.longitude ?? null,
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
      return await this.listSubFolders(this.folderId);
    } catch {
      return [];
    }
  }

  private async listSubFolders(parentId: string): Promise<SourceBrowseItem[]> {
    const items: SourceBrowseItem[] = [];
    let pageToken: string | undefined;

    while (true) {
      const params = new URLSearchParams({
        q: `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name)',
        pageSize: '500',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const res = await proxyFetch(
        `https://www.googleapis.com/drive/v3/files?${params}`,
        { headers: this.headers() },
      );
      if (!res.ok) break;
      const data = await res.json();

      for (const folder of data.files ?? []) {
        const children = await this.listSubFolders(folder.id);
        items.push({
          id: folder.id,
          name: folder.name,
          type: 'folder',
          children: children.length > 0 ? children : undefined,
        });
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }
    return items;
  }

  async setTitle(ref: PhotoRef, title: string): Promise<boolean> {
    try {
      const ext = ref.name.split('.').pop() ?? '';
      const newName = ext ? `${title}.${ext}` : title;
      const res = await proxyFetch(
        `https://www.googleapis.com/drive/v3/files/${ref.sourcePhotoId}`,
        {
          method: 'PATCH',
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      // Get parent folder
      const metaRes = await proxyFetch(
        `https://www.googleapis.com/drive/v3/files/${ref.sourcePhotoId}?fields=parents`,
        { headers: this.headers() },
      );
      if (!metaRes.ok) return false;
      const meta = await metaRes.json();
      const parentId = meta.parents?.[0] ?? this.folderId;

      const editName = `${ref.name.replace(/\.[^.]+$/, '')}_edit.${ref.name.split('.').pop()}`;
      const boundary = `photolib_${Date.now()}`;
      const metadata = JSON.stringify({ name: editName, parents: [parentId] });

      const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`;
      const parts = [body, blob, `\r\n--${boundary}--`];
      const multipartBlob = new Blob(parts);

      const res = await proxyFetch(
        `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`,
        {
          method: 'POST',
          headers: { ...this.headers(), 'Content-Type': `multipart/related; boundary=${boundary}` },
          body: multipartBlob,
        },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async createAlbum(name: string): Promise<string | null> {
    try {
      const res = await proxyFetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [this.folderId],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.id ?? null;
    } catch {
      return null;
    }
  }
}
