/**
 * The one way a finished file leaves the app.
 *
 * The route is decided by ./nativeShell, which imports nothing and is tested
 * on its own. This module only executes the chosen route, and it is the only
 * place in `src/` that mentions `@capacitor/*` - through `await import()`, the
 * same deferral the repo uses for the AI models, exifr and the RAW decoders.
 * A browser therefore never fetches the plugin chunks: it takes the first
 * branch and returns before any import is reached.
 */

import { planFileDelivery, type DeliveryRoute, type ShellGlobal } from './nativeShell';

/**
 * The browser route: hand the blob to the page as a download. Unchanged from
 * the `downloadBlob` that used to sit in engine/Exporter.ts - it moved here so
 * that the alternative to it lives next to it.
 */
export function downloadBlobViaAnchor(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export interface DeliveredFile {
  /** The route that actually ran, which is not always the one planned. */
  route: DeliveryRoute;
  /** Where the file landed, on the native routes. */
  uri?: string;
  /**
   * Set when a native route was planned but failed and the browser route ran
   * instead, so a caller can say so rather than claim a share that never
   * happened.
   */
  fellBackFrom?: DeliveryRoute;
}

export interface DeliverFileOptions {
  /** Title for the share sheet; the file name is a serviceable default. */
  title?: string;
  /** The window to route by. Injected by tests; production uses the real one. */
  win?: ShellGlobal | null;
  /** The browser sink. Injected by tests; production uses the anchor click. */
  download?: (blob: Blob, fileName: string) => void;
}

/**
 * Capacitor's Filesystem takes binary content as a base64 string, so a native
 * write costs roughly 3x the blob in peak memory. That is the plugin's
 * contract, not a choice here; it is the reason a 60 MB TIFF export is worth
 * watching on a phone (docs/CAPACITOR.md).
 *
 * Chunked because `String.fromCharCode(...bytes)` over a whole export
 * overflows the argument stack.
 */
const BASE64_CHUNK = 0x8000;

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
}

function currentWindow(): ShellGlobal | null {
  return typeof window === 'undefined' ? null : (window as unknown as ShellGlobal);
}

/**
 * Deliver `blob` under `fileName` by whichever route this shell supports.
 *
 * Native failures fall back to the browser route on purpose: a share sheet the
 * user cancelled, a sandbox that refused the write or a plugin that is not
 * really there must not be the difference between having the export and losing
 * it.
 */
export async function deliverFile(
  blob: Blob,
  fileName: string,
  options: DeliverFileOptions = {},
): Promise<DeliveredFile> {
  const download = options.download ?? downloadBlobViaAnchor;
  const plan = planFileDelivery(options.win === undefined ? currentWindow() : options.win);

  if (plan.route === 'web-download' || !plan.directory) {
    download(blob, fileName);
    return { route: 'web-download' };
  }

  try {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const written = await Filesystem.writeFile({
      path: fileName,
      data: await blobToBase64(blob),
      directory: plan.directory === 'DOCUMENTS' ? Directory.Documents : Directory.Cache,
      recursive: true,
    });

    if (plan.route === 'native-share') {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: options.title ?? fileName, files: [written.uri] });
    }
    return { route: plan.route, uri: written.uri };
  } catch {
    download(blob, fileName);
    return { route: 'web-download', fellBackFrom: plan.route };
  }
}
