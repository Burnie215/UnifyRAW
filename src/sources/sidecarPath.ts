/**
 * The one place that knows where a provider puts a photo's sidecar.
 *
 * Five providers used to spell `.photolib/<name>.json` out themselves, each
 * with its own way of cutting the directory off the photo id, and one of them
 * produced a double slash at the root.
 */

export const SIDECAR_DIR = '.photolib';

/** Directory part of a source photo id, without a trailing slash ('' at the root). */
export function photoDirOf(sourcePhotoId: string): string {
  const lastSlash = sourcePhotoId.lastIndexOf('/');
  return lastSlash < 0 ? '' : sourcePhotoId.substring(0, lastSlash);
}

/** Sidecar path for a photo, relative to the same root `dir` is relative to. */
export function sidecarPathFor(dir: string, name: string): string {
  return `${dir ? `${dir}/` : ''}${SIDECAR_DIR}/${name}.json`;
}
