const SOURCE_TYPE_LABELS: Record<string, string> = {
  local: 'Lokal',
  'local-files': 'Lokale Dateien',
  immich: 'Immich v2',
  'immich-v3': 'Immich v3',
  lychee: 'Lychee',
  photoprism: 'PhotoPrism',
  piwigo: 'Piwigo',
  synology: 'Synology Photos',
  librephotos: 'LibrePhotos',
  'nextcloud-photos': 'Nextcloud Photos',
  ente: 'Ente',
  dropbox: 'Dropbox',
  'google-drive': 'Google Drive',
  onedrive: 'OneDrive',
  'google-photos': 'Google Photos',
  flickr: 'Flickr',
  smugmug: 'SmugMug',
  s3: 'S3 / MinIO',
  webdav: 'WebDAV',
  'server-path': 'Server',
  ftp: 'FTP / SFTP',
  smb: 'SMB',
  ssh: 'SSH',
  nfs: 'NFS',
  'photolib-library': 'PhotoLib-Bibliothek',
};

/** Stable, user-facing provider name for persisted source type ids. */
export function sourceTypeLabel(type: string): string {
  return SOURCE_TYPE_LABELS[type] ?? type;
}
