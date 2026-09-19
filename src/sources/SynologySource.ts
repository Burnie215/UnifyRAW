import type { SourceProvider, PhotoRef, PhotoPage, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';

export interface SynologyConfig {
  serverUrl: string;
  username: string;
  password: string;
  otpCode?: string;
  space: 'personal' | 'shared' | 'both';
}

interface SynologyListEntry {
  id: number;
  name: string;
  type?: string;
  filename?: string;
  time?: number;
  item_count?: number;
  camera?: string;
  lens?: string;
  iso?: number;
  focal_length?: number;
  aperture?: number;
  exposure_time?: string;
  resolution?: { width?: number; height?: number };
  gps?: { latitude?: number; longitude?: number };
}

interface SynologyRpcResult {
  list?: SynologyListEntry[];
  album?: { id?: number };
}

export class SynologySource implements SourceProvider {
  readonly type = 'synology';
  readonly id: string;
  readonly label: string;

  private baseUrl: string;
  private username: string;
  private password: string;
  private otpCode?: string;
  private space: string;
  private sid: string | null = null;

  constructor(id: string, label: string, config: SynologyConfig) {
    this.id = id;
    this.label = label;
    this.baseUrl = config.serverUrl.replace(/\/+$/, '');
    this.username = config.username;
    this.password = config.password;
    this.otpCode = config.otpCode;
    this.space = config.space;
  }

  /** API namespace prefix — SYNO.Foto (personal) or SYNO.FotoTeam (shared) */
  private ns(personal: boolean): string {
    return personal ? 'SYNO.Foto' : 'SYNO.FotoTeam';
  }

  private async rpc(api: string, method: string, params: Record<string, string> = {}): Promise<SynologyRpcResult> {
    const body = new URLSearchParams({
      api, method, version: '1',
      ...params,
      ...(this.sid ? { _sid: this.sid } : {}),
    });
    const res = await proxyFetch(`${this.baseUrl}/photo/webapi/entry.cgi`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(`Synology ${api}.${method} failed: ${res.status}`);
    const data = await res.json() as {
      success?: boolean;
      error?: { code?: number };
      data?: SynologyRpcResult;
    };
    if (!data.success) throw new Error(`Synology ${api}.${method}: error ${data.error?.code}`);
    return data.data ?? {};
  }

  async connect(): Promise<boolean> {
    try {
      const params: Record<string, string> = {
        account: this.username,
        passwd: this.password,
      };
      if (this.otpCode) params.otp_code = this.otpCode;

      const body = new URLSearchParams({
        api: 'SYNO.API.Auth', method: 'login', version: '1', ...params,
      });
      const res = await proxyFetch(`${this.baseUrl}/photo/webapi/auth.cgi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.success) return false;
      this.sid = data.data.sid;
      return true;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.sid = null;
  }

  async *listPhotos(): AsyncIterable<PhotoRef> {
    const spaces = this.space === 'both' ? [true, false] : [this.space === 'personal'];
    for (const personal of spaces) {
      yield* this.listFromSpace(personal);
    }
  }

  private async *listFromSpace(personal: boolean): AsyncIterable<PhotoRef> {
    // Browse root folder, then recurse
    yield* this.listFolder(0, personal, '');
  }

  private async *listFolder(folderId: number, personal: boolean, path: string): AsyncIterable<PhotoRef> {
    // List subfolders
    try {
      const folders = await this.rpc(`${this.ns(personal)}.Browse.Folder`, 'list', {
        id: String(folderId), offset: '0', limit: '1000',
      });
      for (const folder of folders.list ?? []) {
        const subPath = path ? `${path}/${folder.name}` : folder.name;
        yield* this.listFolder(folder.id, personal, subPath);
      }
    } catch { /* leaf folder */ }

    // List items in this folder
    let offset = 0;
    const limit = 200;
    while (true) {
      try {
        const result = await this.rpc(`${this.ns(personal)}.Browse.Item`, 'list', {
          folder_id: String(folderId), offset: String(offset), limit: String(limit),
          additional: '["thumbnail","resolution"]',
        });
        const items = result.list ?? [];
        if (items.length === 0) break;

        for (const item of items) {
          if (item.type !== 'photo') continue;
          yield {
            sourcePhotoId: `${personal ? 'p' : 's'}:${item.id}`,
            sourceId: this.id,
            name: item.filename ?? item.name,
            mimeType: 'image/jpeg',
            dateTaken: item.time ? item.time * 1000 : undefined,
          };
        }

        if (items.length < limit) break;
        offset += limit;
      } catch {
        break;
      }
    }
  }

  async listPhotosPage(_page: number, _pageSize: number): Promise<PhotoPage | null> {
    // Synology doesn't have a global paginated endpoint — use listPhotos
    return null;
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const { personal, itemId } = this.parseId(ref.sourcePhotoId);
    const url = await this.getThumbnailBlob(personal, itemId, 'xl');
    if (!url) throw new Error('No display URL');
    return url;
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    const { personal, itemId } = this.parseId(ref.sourcePhotoId);
    return this.getThumbnailBlob(personal, itemId, 'm', signal);
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    const { personal, itemId } = this.parseId(ref.sourcePhotoId);
    try {
      const body = new URLSearchParams({
        api: `${this.ns(personal)}.Download`, method: 'download', version: '1',
        unit_id: `[${itemId}]`,
        ...(this.sid ? { _sid: this.sid } : {}),
      });
      const res = await proxyFetch(`${this.baseUrl}/photo/webapi/entry.cgi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
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

  private async getThumbnailBlob(
    personal: boolean,
    itemId: number,
    size: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      const body = new URLSearchParams({
        api: `${this.ns(personal)}.Thumbnail`, method: 'get', version: '1',
        id: String(itemId), size,
        ...(this.sid ? { _sid: this.sid } : {}),
      });
      const res = await proxyFetch(`${this.baseUrl}/photo/webapi/entry.cgi`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal,
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      return signal?.aborted ? null : URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  private parseId(sourcePhotoId: string): { personal: boolean; itemId: number } {
    const [prefix, id] = sourcePhotoId.split(':');
    return { personal: prefix === 'p', itemId: Number(id) };
  }

  // ─── Extended capabilities ───

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      const { personal, itemId } = this.parseId(ref.sourcePhotoId);
      const result = await this.rpc(`${this.ns(personal)}.Browse.Item`, 'get_exif', {
        id: `[${itemId}]`,
      });
      const exifList = result.list ?? [];
      if (exifList.length === 0) return null;
      const exif = exifList[0];
      return {
        camera: exif.camera ?? null,
        lens: exif.lens ?? null,
        iso: exif.iso ?? null,
        focalLength: exif.focal_length ?? null,
        aperture: exif.aperture ?? null,
        shutterSpeed: exif.exposure_time ?? null,
        width: exif.resolution?.width ?? null,
        height: exif.resolution?.height ?? null,
        latitude: exif.gps?.latitude ?? null,
        longitude: exif.gps?.longitude ?? null,
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
    const items: SourceBrowseItem[] = [];
    const spaces = this.space === 'both' ? [true, false] : [this.space === 'personal'];

    for (const personal of spaces) {
      try {
        // Albums
        const albumResult = await this.rpc(`${this.ns(personal)}.Browse.Album`, 'list', {
          offset: '0', limit: '1000',
        });
        for (const album of albumResult.list ?? []) {
          items.push({
            id: `${personal ? 'p' : 's'}:album:${album.id}`,
            name: `${personal ? '📱 ' : '👥 '}${album.name}`,
            type: 'album',
            photoCount: album.item_count,
          });
        }

        // Folders
        const folderResult = await this.rpc(`${this.ns(personal)}.Browse.Folder`, 'list', {
          id: '0', offset: '0', limit: '1000',
        });
        for (const folder of folderResult.list ?? []) {
          items.push({
            id: `${personal ? 'p' : 's'}:folder:${folder.id}`,
            name: `${personal ? '📱 ' : '👥 '}📁 ${folder.name}`,
            type: 'folder',
          });
        }
      } catch { continue; }
    }
    return items;
  }

  async setTags(ref: PhotoRef, tags: string[]): Promise<boolean> {
    // NOTE: Synology Photos API is append-only for tags and cannot create new tags.
    // Only pre-existing tags can be assigned. There is no API to remove tags from items
    // or to create new tags programmatically. Existing tags are preserved.
    try {
      const { personal, itemId } = this.parseId(ref.sourcePhotoId);
      const tagResult = await this.rpc(`${this.ns(personal)}.Browse.GeneralTag`, 'list', {});
      const existingTags: { id: number; name: string }[] = tagResult.list ?? [];
      const tagMap = new Map(existingTags.map((t) => [t.name.toLowerCase(), t.id]));

      const tagIds: number[] = [];
      for (const tag of tags) {
        const tagId = tagMap.get(tag.toLowerCase());
        if (tagId !== undefined) tagIds.push(tagId);
      }

      if (tagIds.length > 0) {
        await this.rpc(`${this.ns(personal)}.Browse.Item`, 'add_tag', {
          id: `[${itemId}]`,
          tag: `[${tagIds.join(',')}]`,
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const { personal } = this.parseId(ref.sourcePhotoId);
      const formData = new FormData();
      formData.append('api', `${this.ns(personal)}.Upload`);
      formData.append('method', 'upload');
      formData.append('version', '1');
      formData.append('file', blob, ref.name);
      if (this.sid) formData.append('_sid', this.sid);

      const res = await proxyFetch(`${this.baseUrl}/photo/webapi/entry.cgi`, {
        method: 'POST',
        body: formData,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async createAlbum(name: string): Promise<string | null> {
    try {
      // Create in personal space by default
      const result = await this.rpc(`${this.ns(true)}.Browse.Album`, 'create', {
        name,
      });
      return result.album?.id ? `p:album:${result.album.id}` : null;
    } catch {
      return null;
    }
  }

  async addToAlbum(albumId: string, refs: PhotoRef[]): Promise<boolean> {
    try {
      // Parse album ID: "p:album:123" → personal, id=123
      const parts = albumId.split(':');
      const personal = parts[0] === 'p';
      const id = parts[2];
      const itemIds = refs.map((r) => this.parseId(r.sourcePhotoId).itemId);

      await this.rpc(`${this.ns(personal)}.Browse.Album`, 'add_item', {
        id,
        item_id: `[${itemIds.join(',')}]`,
      });
      return true;
    } catch {
      return false;
    }
  }
}
