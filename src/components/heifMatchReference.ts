import type { PhotoView } from '../storage/repos';

export interface HeifMatchReference {
  name: string;
  resolveUrl(): Promise<string | null>;
}

interface HeifMatchReferencePorts {
  getFile(photo: PhotoView, signal?: AbortSignal): Promise<File | null>;
  decode(file: File): Promise<Blob>;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
}

export interface HeifMatchReferenceResource {
  reference: HeifMatchReference;
  dispose(): void;
}

/** Owns the lazy HEIF read, decode and blob URL for one editor/photo lifetime. */
export function createHeifMatchReferenceResource(
  partner: PhotoView,
  ports: HeifMatchReferencePorts,
): HeifMatchReferenceResource {
  const controller = new AbortController();
  let currentUrl: string | null = null;

  const dispose = () => {
    controller.abort();
    if (currentUrl) {
      ports.revokeObjectUrl(currentUrl);
      currentUrl = null;
    }
  };

  return {
    reference: {
      name: partner.name,
      resolveUrl: async () => {
        if (controller.signal.aborted) return null;
        let file: File | null;
        try {
          file = await ports.getFile(partner, controller.signal);
        } catch (error) {
          if (controller.signal.aborted) return null;
          throw error;
        }
        if (!file || controller.signal.aborted) return null;
        let blob: Blob;
        try {
          blob = await ports.decode(file);
        } catch (error) {
          if (controller.signal.aborted) return null;
          throw error;
        }
        if (controller.signal.aborted) return null;

        const url = ports.createObjectUrl(blob);
        if (controller.signal.aborted) {
          ports.revokeObjectUrl(url);
          return null;
        }
        if (currentUrl) ports.revokeObjectUrl(currentUrl);
        currentUrl = url;
        return url;
      },
    },
    dispose,
  };
}
