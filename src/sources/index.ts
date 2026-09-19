export type { SourceProvider, PhotoRef, WriteCapabilities, SourceMetadata, SourceBrowseItem } from './types';
export { writeCapabilitiesOf } from './writeCapabilities';
export { LocalSource } from './LocalSource';
export { FileListSource } from './FileListSource';
export { ImmichSource } from './ImmichSource';
export type { ImmichConfig } from './ImmichSource';
export { ImmichV3Source } from './ImmichV3Source';
export type { ImmichV3Config } from './ImmichV3Source';
export { ServerPathSource } from './ServerPathSource';
export type { ServerPathConfig } from './ServerPathSource';
export { WebDAVSource } from './WebDAVSource';
export type { WebDAVConfig } from './WebDAVSource';
export { S3Source } from './S3Source';
export type { S3Config } from './S3Source';
export { DropboxSource } from './DropboxSource';
export type { DropboxConfig } from './DropboxSource';
export { GoogleDriveSource } from './GoogleDriveSource';
export type { GoogleDriveConfig } from './GoogleDriveSource';
// API sources
export { PhotoprismSource } from './PhotoprismSource';
export type { PhotoprismConfig } from './PhotoprismSource';
export { PiwigoSource } from './PiwigoSource';
export type { PiwigoConfig } from './PiwigoSource';
export { LycheeSource } from './LycheeSource';
export type { LycheeConfig } from './LycheeSource';
export { SynologySource } from './SynologySource';
export type { SynologyConfig } from './SynologySource';
export { LibrePhotosSource } from './LibrePhotosSource';
export type { LibrePhotosConfig } from './LibrePhotosSource';
export { NextcloudPhotosSource } from './NextcloudPhotosSource';
export type { NextcloudPhotosConfig } from './NextcloudPhotosSource';
// Cloud sources
export { OneDriveSource } from './OneDriveSource';
export type { OneDriveConfig } from './OneDriveSource';
export { GooglePhotosSource } from './GooglePhotosSource';
export type { GooglePhotosConfig } from './GooglePhotosSource';
export { FlickrSource } from './FlickrSource';
export type { FlickrConfig } from './FlickrSource';
export { SmugMugSource } from './SmugMugSource';
export type { SmugMugConfig } from './SmugMugSource';
// Backend sources
export { PhotoLibLibrarySource } from './PhotoLibLibrarySource';
export type { PhotoLibLibraryConfig } from './PhotoLibLibrarySource';
// Manager & stores
export { sourceManager } from './SourceManager';
export { SidecarStoreV2 } from './SidecarStoreV2';
export type { PhotoMeta, SidecarIndex } from './SidecarStoreV2';
