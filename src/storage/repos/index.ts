import type { CatalogStorage } from '../CatalogStorage';
import type { RevisionTable } from './types';
import { SourceRepository } from './SourceRepository';
import { PhotoRepository } from './PhotoRepository';
import { PhotoMetaRepository } from './PhotoMetaRepository';
import { EditRepository } from './EditRepository';
import { PresetRepository } from './PresetRepository';
import { DevelopProfileRepository } from './DevelopProfileRepository';
import { LensProfileRepository } from './LensProfileRepository';
import { CollectionRepository } from './CollectionRepository';
import { FaceRepository } from './FaceRepository';
import { ThumbnailRepository } from './ThumbnailRepository';
import { ExifScanRepository } from './ExifScanRepository';
import { ExportRepository } from './ExportRepository';

export type { SourceRow, PhotoRow, PhotoView, PhotoMetaRow, EditRow, ExportRow, PresetRow, CollectionRow, CollectionRule, FaceRow, PhotoFlag, PhotoColorLabel, RevisionTable } from './types';

export { SourceRepository, PhotoRepository, PhotoMetaRepository, EditRepository, ExportRepository, PresetRepository, DevelopProfileRepository, CollectionRepository, FaceRepository, ThumbnailRepository, ExifScanRepository };
export { LensProfileRepository };
export type { DevelopProfileRow } from './DevelopProfileRepository';
export type { LensProfileRow } from './LensProfileRepository';
export type { PhotoListOpts } from './PhotoRepository';

export interface Repositories {
  sources: SourceRepository;
  photos: PhotoRepository;
  photoMeta: PhotoMetaRepository;
  edits: EditRepository;
  exports: ExportRepository;
  presets: PresetRepository;
  developProfiles: DevelopProfileRepository;
  lensProfiles: LensProfileRepository;
  collections: CollectionRepository;
  faces: FaceRepository;
  thumbnails: ThumbnailRepository;
  exifScans: ExifScanRepository;
}

/**
 * `onWrite` is told which table the write landed in, so only the consumers of
 * that table reload. A repository that deliberately takes no `onWrite` (the
 * thumbnail store) bumps nothing at all.
 */
export function buildRepositories(storage: CatalogStorage, onWrite: (table: RevisionTable) => void): Repositories {
  return {
    sources: new SourceRepository(storage, onWrite),
    photos: new PhotoRepository(storage, onWrite),
    photoMeta: new PhotoMetaRepository(storage, onWrite),
    edits: new EditRepository(storage, onWrite),
    exports: new ExportRepository(storage, onWrite),
    presets: new PresetRepository(storage, onWrite),
    developProfiles: new DevelopProfileRepository(storage, onWrite),
    lensProfiles: new LensProfileRepository(storage, onWrite),
    collections: new CollectionRepository(storage, onWrite),
    faces: new FaceRepository(storage, onWrite),
    thumbnails: new ThumbnailRepository(storage),
    // Local-only, like thumbnails: a mark is not a change anyone displays, so
    // it must not bump the storage revision.
    exifScans: new ExifScanRepository(storage),
  };
}
