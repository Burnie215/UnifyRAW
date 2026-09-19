import type { SourceProvider, PhotoRef, SourceMetadata, SourceBrowseItem } from './types';
import { proxyFetch } from '../platform/api';
import { SIDECAR_DIR, photoDirOf, sidecarPathFor } from './sidecarPath';

const isHeifName = (name: string): boolean => /\.(?:heic|heif|hif)$/i.test(name);

export interface NextcloudPhotosConfig {
  serverUrl: string;
  username: string;
  password: string;
}

export class NextcloudPhotosSource implements SourceProvider {
  readonly type = 'nextcloud-photos';
  readonly id: string;
  readonly label: string;

  private baseUrl: string;
  private username: string;
  private authHeader: string;

  constructor(id: string, label: string, config: NextcloudPhotosConfig) {
    this.id = id;
    this.label = label;
    this.baseUrl = config.serverUrl.replace(/\/+$/, '');
    this.username = config.username;
    this.authHeader = 'Basic ' + btoa(`${config.username}:${config.password}`);
  }

  private headers(): Record<string, string> {
    return { 'Authorization': this.authHeader, 'OCS-APIRequest': 'true' };
  }

  async connect(): Promise<boolean> {
    try {
      const res = await proxyFetch(
        `${this.baseUrl}/ocs/v1.php/cloud/capabilities?format=json`,
        { headers: this.headers() },
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {}

  async *listPhotos(): AsyncIterable<PhotoRef> {
    // Use WebDAV PROPFIND on photos folder with image filter
    const davUrl = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos`;
    yield* this.propfindRecursive(davUrl, '');
  }

  private async *propfindRecursive(url: string, path: string): AsyncIterable<PhotoRef> {
    try {
      const res = await proxyFetch(url, {
        method: 'PROPFIND',
        headers: {
          ...this.headers(),
          'Depth': '1',
          'Content-Type': 'application/xml',
        },
        body: `<?xml version="1.0"?>
          <d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
            <d:prop>
              <d:displayname/><d:getcontenttype/><d:getcontentlength/>
              <d:getlastmodified/><d:resourcetype/>
            </d:prop>
          </d:propfind>`,
      });
      if (!res.ok) return;
      const text = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/xml');
      const responses = doc.getElementsByTagNameNS('DAV:', 'response');

      for (let i = 1; i < responses.length; i++) { // skip first (self)
        const href = responses[i].getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
        const resourceType = responses[i].getElementsByTagNameNS('DAV:', 'collection');
        const contentType = responses[i].getElementsByTagNameNS('DAV:', 'getcontenttype')[0]?.textContent ?? '';
        const name = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '');

        if (resourceType.length > 0) {
          // Directory — recurse
          const subPath = path ? `${path}/${name}` : name;
          yield* this.propfindRecursive(`${this.baseUrl}${href}`, subPath);
        } else if (contentType.startsWith('image/') || isHeifName(name)) {
          yield {
            sourcePhotoId: path ? `${path}/${name}` : name,
            sourceId: this.id,
            name,
            mimeType: contentType.startsWith('image/') ? contentType : 'image/heif',
          };
        }
      }
    } catch { /* */ }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const url = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${ref.sourcePhotoId}`;
    const res = await proxyFetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Failed: ${res.status}`);
    return URL.createObjectURL(await res.blob());
  }

  async getThumbnailUrl(ref: PhotoRef, signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) return null;
    try {
      // Nextcloud preview API
      const encoded = encodeURIComponent(`/Photos/${ref.sourcePhotoId}`);
      const url = `${this.baseUrl}/index.php/core/preview?file=${encoded}&x=300&y=300&a=1`;
      const res = await proxyFetch(url, { headers: this.headers(), signal });
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
      const url = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${ref.sourcePhotoId}`;
      const res = await proxyFetch(url, { headers: this.headers(), signal });
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
      const dir = photoDirOf(ref.sourcePhotoId);
      const sidecarPath = sidecarPathFor(dir, ref.name);
      // Ensure the sidecar directory
      const mkcolUrl = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${dir ? dir + '/' : ''}${SIDECAR_DIR}`;
      await proxyFetch(mkcolUrl, { method: 'MKCOL', headers: this.headers() }).catch(() => {});
      // Write sidecar
      const url = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${sidecarPath}`;
      const res = await proxyFetch(url, {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: data,
      });
      return res.ok || res.status === 201 || res.status === 204;
    } catch {
      return false;
    }
  }

  async readSidecar(ref: PhotoRef): Promise<string | null> {
    try {
      const sidecarPath = sidecarPathFor(photoDirOf(ref.sourcePhotoId), ref.name);
      const url = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${sidecarPath}`;
      const res = await proxyFetch(url, { headers: this.headers() });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }

  // ─── Extended capabilities ───

  async getMetadata(ref: PhotoRef): Promise<SourceMetadata | null> {
    try {
      // PROPFIND with NC 28+ EXIF metadata properties
      const url = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${ref.sourcePhotoId}`;
      const res = await proxyFetch(url, {
        method: 'PROPFIND',
        headers: { ...this.headers(), 'Depth': '0', 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0"?>
          <d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
            <d:prop>
              <oc:fileid/><oc:favorite/>
              <nc:metadata-photos-size/><nc:metadata-photos-gps/>
              <nc:metadata-photos-exif/><nc:metadata-photos-original_date_time/>
            </d:prop>
          </d:propfind>`,
      });
      if (!res.ok && res.status !== 207) return null;

      const text = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'text/xml');

      const favorite = doc.getElementsByTagNameNS('http://owncloud.org/ns', 'favorite')[0]?.textContent === '1';
      const sizeStr = doc.getElementsByTagNameNS('http://nextcloud.org/ns', 'metadata-photos-size')[0]?.textContent;
      const gpsStr = doc.getElementsByTagNameNS('http://nextcloud.org/ns', 'metadata-photos-gps')[0]?.textContent;
      const exifStr = doc.getElementsByTagNameNS('http://nextcloud.org/ns', 'metadata-photos-exif')[0]?.textContent;

      let width: number | null = null, height: number | null = null;
      if (sizeStr) { try { const s = JSON.parse(sizeStr); width = s.width; height = s.height; } catch { /* malformed server metadata */ } }

      let lat: number | null = null, lng: number | null = null;
      if (gpsStr) { try { const g = JSON.parse(gpsStr); lat = g.latitude; lng = g.longitude; } catch { /* malformed server metadata */ } }

      let camera: string | null = null, lens: string | null = null;
      let iso: number | null = null, focalLength: number | null = null;
      let aperture: number | null = null, shutterSpeed: string | null = null;
      if (exifStr) {
        try {
          const e = JSON.parse(exifStr);
          camera = e.Make && e.Model ? `${e.Make} ${e.Model}` : e.Model ?? null;
          lens = e.LensModel ?? null;
          iso = e.ISOSpeedRatings ?? null;
          focalLength = e.FocalLength ?? null;
          aperture = e.FNumber ?? null;
          shutterSpeed = e.ExposureTime ?? null;
        } catch { /* malformed server metadata */ }
      }

      return {
        camera, lens, iso, focalLength, aperture, shutterSpeed,
        width, height, latitude: lat, longitude: lng,
        keywords: [], rating: null, favorite,
        title: null, description: null,
      };
    } catch {
      return null;
    }
  }

  /** Get fileId from PROPFIND for tag/favorite operations */
  private async getFileId(photoPath: string): Promise<string | null> {
    try {
      const url = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${photoPath}`;
      const res = await proxyFetch(url, {
        method: 'PROPFIND',
        headers: { ...this.headers(), 'Depth': '0', 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>`,
      });
      if (!res.ok && res.status !== 207) return null;
      const text = await res.text();
      const match = text.match(/<oc:fileid>(\d+)<\/oc:fileid>/);
      return match?.[1] ?? null;
    } catch {
      return null;
    }
  }

  async listAlbumsOrFolders(): Promise<SourceBrowseItem[]> {
    const items: SourceBrowseItem[] = [];

    // Try Photos app WebDAV albums (NC 25+)
    try {
      const url = `${this.baseUrl}/remote.php/dav/photos/${this.username}/albums`;
      const res = await proxyFetch(url, {
        method: 'PROPFIND',
        headers: { ...this.headers(), 'Depth': '1', 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:displayname/><nc:nbItems/></d:prop></d:propfind>`,
      });
      if (res.ok || res.status === 207) {
        const text = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');
        const responses = doc.getElementsByTagNameNS('DAV:', 'response');
        for (let i = 1; i < responses.length; i++) {
          const href = responses[i].getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
          const name = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '');
          const nbItems = responses[i].getElementsByTagNameNS('http://nextcloud.org/ns', 'nbItems')[0]?.textContent;
          items.push({
            id: `album:${name}`,
            name: `📸 ${name}`,
            type: 'album',
            photoCount: nbItems ? Number(nbItems) : undefined,
          });
        }
      }
    } catch { /* Photos app may not be installed */ }

    // Also list top-level folders in Photos/
    try {
      const url = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos`;
      const res = await proxyFetch(url, {
        method: 'PROPFIND',
        headers: { ...this.headers(), 'Depth': '1', 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`,
      });
      if (res.ok || res.status === 207) {
        const text = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, 'text/xml');
        const responses = doc.getElementsByTagNameNS('DAV:', 'response');
        for (let i = 1; i < responses.length; i++) {
          const isCollection = responses[i].getElementsByTagNameNS('DAV:', 'collection').length > 0;
          if (!isCollection) continue;
          const href = responses[i].getElementsByTagNameNS('DAV:', 'href')[0]?.textContent ?? '';
          const name = decodeURIComponent(href.split('/').filter(Boolean).pop() ?? '');
          if (name.startsWith('.')) continue;
          items.push({ id: `folder:${name}`, name: `📁 ${name}`, type: 'folder' });
        }
      }
    } catch { /* */ }

    return items;
  }

  async setFavorite(ref: PhotoRef, favorite: boolean): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${ref.sourcePhotoId}`;
      const res = await proxyFetch(url, {
        method: 'PROPPATCH',
        headers: { ...this.headers(), 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0"?>
          <d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
            <d:set><d:prop><oc:favorite>${favorite ? 1 : 0}</oc:favorite></d:prop></d:set>
          </d:propertyupdate>`,
      });
      return res.ok || res.status === 207;
    } catch {
      return false;
    }
  }

  async setTags(ref: PhotoRef, tags: string[]): Promise<boolean> {
    try {
      const fileId = await this.getFileId(ref.sourcePhotoId);
      if (!fileId) return false;

      // 1. Get all system tags (name → id mapping)
      const allTagsMap = new Map<string, string>(); // name.lower → id
      const tagsRes = await proxyFetch(`${this.baseUrl}/remote.php/dav/systemtags`, {
        method: 'PROPFIND',
        headers: { ...this.headers(), 'Depth': '1', 'Content-Type': 'application/xml' },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:id/><oc:display-name/></d:prop></d:propfind>`,
      });
      if (tagsRes.ok || tagsRes.status === 207) {
        const text = await tagsRes.text();
        const matches = text.matchAll(/<oc:id>(\d+)<\/oc:id>[\s\S]*?<oc:display-name>([^<]+)<\/oc:display-name>/g);
        for (const m of matches) allTagsMap.set(m[2].toLowerCase(), m[1]);
      }

      // 2. Get currently assigned tags for this file
      const currentTagIds = new Set<string>();
      const fileTagsRes = await proxyFetch(
        `${this.baseUrl}/remote.php/dav/systemtags-relations/files/${fileId}`,
        {
          method: 'PROPFIND',
          headers: { ...this.headers(), 'Depth': '1', 'Content-Type': 'application/xml' },
          body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:id/><oc:display-name/></d:prop></d:propfind>`,
        },
      );
      if (fileTagsRes.ok || fileTagsRes.status === 207) {
        const text = await fileTagsRes.text();
        const matches = text.matchAll(/<oc:id>(\d+)<\/oc:id>/g);
        for (const m of matches) currentTagIds.add(m[1]);
      }

      // 3. Resolve desired tags → IDs (create if needed)
      const desiredTagIds = new Set<string>();
      for (const tag of tags) {
        let tagId = allTagsMap.get(tag.toLowerCase());
        if (!tagId) {
          const createRes = await proxyFetch(`${this.baseUrl}/remote.php/dav/systemtags`, {
            method: 'POST',
            headers: { ...this.headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: tag, userVisible: true, userAssignable: true }),
          });
          if (createRes.status === 201) {
            const loc = createRes.headers.get('Content-Location') ?? '';
            tagId = loc.split('/').pop();
          }
          if (!tagId) continue;
        }
        desiredTagIds.add(tagId);
      }

      // 4. Add new tags
      for (const tagId of desiredTagIds) {
        if (!currentTagIds.has(tagId)) {
          await proxyFetch(
            `${this.baseUrl}/remote.php/dav/systemtags-relations/files/${fileId}/${tagId}`,
            { method: 'PUT', headers: this.headers() },
          );
        }
      }

      // 5. Remove old tags that are no longer desired
      for (const tagId of currentTagIds) {
        if (!desiredTagIds.has(tagId)) {
          await proxyFetch(
            `${this.baseUrl}/remote.php/dav/systemtags-relations/files/${fileId}/${tagId}`,
            { method: 'DELETE', headers: this.headers() },
          );
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  async uploadEdit(ref: PhotoRef, blob: Blob): Promise<boolean> {
    try {
      const dir = ref.sourcePhotoId.includes('/') ? ref.sourcePhotoId.substring(0, ref.sourcePhotoId.lastIndexOf('/')) : '';
      const editName = `${ref.name.replace(/\.[^.]+$/, '')}_edit.${ref.name.split('.').pop()}`;
      const uploadPath = dir ? `${dir}/${editName}` : editName;
      const url = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${uploadPath}`;
      const res = await proxyFetch(url, {
        method: 'PUT',
        headers: { ...this.headers(), 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
      return res.ok || res.status === 201 || res.status === 204;
    } catch {
      return false;
    }
  }

  async createAlbum(name: string): Promise<string | null> {
    try {
      // Try Photos app album (NC 25+)
      const url = `${this.baseUrl}/remote.php/dav/photos/${this.username}/albums/${encodeURIComponent(name)}`;
      const res = await proxyFetch(url, { method: 'MKCOL', headers: this.headers() });
      if (res.ok || res.status === 201) return `album:${name}`;

      // Fallback: create folder
      const folderUrl = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${encodeURIComponent(name)}`;
      const folderRes = await proxyFetch(folderUrl, { method: 'MKCOL', headers: this.headers() });
      if (folderRes.ok || folderRes.status === 201) return `folder:${name}`;
      return null;
    } catch {
      return null;
    }
  }

  async addToAlbum(albumId: string, refs: PhotoRef[]): Promise<boolean> {
    try {
      const [type, name] = albumId.split(':');
      if (type === 'album') {
        // Photos app: COPY file to album
        for (const ref of refs) {
          const src = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${ref.sourcePhotoId}`;
          const dest = `${this.baseUrl}/remote.php/dav/photos/${this.username}/albums/${encodeURIComponent(name)}/${encodeURIComponent(ref.name)}`;
          await proxyFetch(src, {
            method: 'COPY',
            headers: { ...this.headers(), 'Destination': dest },
          });
        }
        return true;
      }
      // Folder: MOVE file
      for (const ref of refs) {
        const src = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${ref.sourcePhotoId}`;
        const dest = `${this.baseUrl}/remote.php/dav/files/${this.username}/Photos/${encodeURIComponent(name)}/${encodeURIComponent(ref.name)}`;
        await proxyFetch(src, {
          method: 'MOVE',
          headers: { ...this.headers(), 'Destination': dest, 'Overwrite': 'F' },
        });
      }
      return true;
    } catch {
      return false;
    }
  }
}
