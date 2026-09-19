import type { SourceProvider, WriteCapabilities } from './types';

/**
 * What a source can write, read off the methods it actually implements.
 *
 * Eighteen providers used to declare this by hand and the declaration drifted:
 * ServerPath claimed sidecar, upload and replace while owning none of those
 * methods, GoogleDrive claimed sidecar without `writeSidecar`. A derived
 * capability cannot lie.
 *
 * `writeRestrictions()` may only take a flag away - a provider that does not
 * implement the method never gets it back.
 */
export function writeCapabilitiesOf(source: SourceProvider): WriteCapabilities {
  const restrictions = source.writeRestrictions?.() ?? {};
  const derive = (method: unknown, flag: keyof WriteCapabilities): boolean =>
    typeof method === 'function' && (restrictions[flag] ?? true);

  return {
    canWriteSidecar: derive(source.writeSidecar, 'canWriteSidecar'),
    canSetFavorite: derive(source.setFavorite, 'canSetFavorite'),
    canSetRating: derive(source.setRating, 'canSetRating'),
    canSetTags: derive(source.setTags, 'canSetTags'),
    canSetTitle: derive(source.setTitle, 'canSetTitle'),
    canUpload: derive(source.uploadEdit, 'canUpload'),
    canCreateAlbum: derive(source.createAlbum, 'canCreateAlbum'),
    canAddToAlbum: derive(source.addToAlbum, 'canAddToAlbum'),
    canDelete: derive(source.deletePhotos, 'canDelete'),
  };
}
