import type { SourceProvider, PhotoRef } from './types';

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif', 'hif',
  'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'dng',
  'orf', 'raf', 'rw2', 'rwl', 'pef', 'ptx', 'srw', 'x3f',
]);

function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Source that works with File objects from <input webkitdirectory>.
 * No FileSystemHandle needed — works on all browsers including Safari.
 * Files are referenced directly, no copies created.
 */
export class FileListSource implements SourceProvider {
  readonly type = 'local-files';
  private fileMap = new Map<string, File>();

  readonly id: string;
  readonly label: string;

  constructor(
    id: string,
    label: string,
    files: FileList,
  ) {
    this.id = id;
    this.label = label;
    for (const file of Array.from(files)) {
      if (isImageFile(file.name)) {
        // webkitRelativePath gives us "folder/subfolder/image.jpg"
        const path = file.webkitRelativePath || file.name;
        this.fileMap.set(path, file);
      }
    }
  }

  async connect(): Promise<boolean> {
    return true;
  }

  async disconnect(): Promise<void> {
    this.fileMap.clear();
  }

  async *listPhotos(): AsyncIterable<PhotoRef> {
    for (const [path, file] of this.fileMap) {
      yield {
        sourcePhotoId: path,
        sourceId: this.id,
        name: file.name,
        mimeType: file.type || 'image/jpeg',
        sizeBytes: file.size,
        dateModified: file.lastModified,
      };
    }
  }

  async getDisplayUrl(ref: PhotoRef): Promise<string> {
    const file = this.fileMap.get(ref.sourcePhotoId);
    if (!file) throw new Error(`File not found: ${ref.sourcePhotoId}`);
    return URL.createObjectURL(file);
  }

  async getThumbnailUrl(): Promise<string | null> {
    return null;
  }

  async getFile(ref: PhotoRef, signal?: AbortSignal): Promise<File | null> {
    if (signal?.aborted) return null;
    return this.fileMap.get(ref.sourcePhotoId) ?? null;
  }
}
