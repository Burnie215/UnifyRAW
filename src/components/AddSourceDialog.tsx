import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AvailableLibraryRoot, CreatePhotoLibraryRequest, LibraryMode } from '@photolib/shared';
import { isSensitiveSourceConfigKey } from '@photolib/shared';
import { startOAuthFlow, type OAuthProviderName } from '../platform/oauth';
import { listAvailableLibraryRoots } from '../platform/libraryApi';
import {
  directOriginHeaderLine,
  directConnectionOrigin,
  resolveSourceTransportMode,
  supportsBrowserDirectTransport,
  type SourceTransportMode,
} from '../platform/sourceTransport';
import { hasBackend } from '../platform/config';
import { CORS_SERVER_KINDS, corsSnippet, type CorsServerKind } from '../sources/corsSnippets';
import { sourceManager } from '../sources/SourceManager';
import { sourceAvailability, type SourceType } from '../sources/capabilities';
import type { SourceBrowseItem } from '../sources/types';
import { SourceConnectionError } from '../sources/connectionError';
import { useBrand } from '../brand';
import { flattenBrowseItems } from './browseItems';
import { sourceConnectionErrorMessage } from './sourceConnectionErrorMessage';
import './AddSourceDialog.css';

interface AddSourceDialogProps {
  open: boolean;
  onClose: () => void;
  onAddLocal: () => void;
  onAddImmich: (serverUrl: string, apiKey: string, label: string, albumIds?: string[], transport?: SourceTransportMode) => Promise<boolean>;
  onAddImmichV3: (serverUrl: string, apiKey: string, label: string, albumIds?: string[], transport?: SourceTransportMode) => Promise<boolean>;
  onAddServerPath?: (serverUrl: string, rootPath: string, label: string) => Promise<boolean>;
  onAddWebDAV?: (url: string, username: string, password: string, label: string, transport?: SourceTransportMode, selectedPaths?: string[]) => Promise<boolean>;
  onAddS3?: (endpoint: string, bucket: string, accessKeyId: string, secretAccessKey: string, region: string, prefix: string, label: string) => Promise<boolean>;
  onAddDropbox?: (accessToken: string, rootPath: string, label: string) => Promise<boolean>;
  onAddGoogleDrive?: (accessToken: string, folderId: string, label: string) => Promise<boolean>;
  onAddGeneric?: (type: string, config: Record<string, string>, label: string) => Promise<boolean>;
  onAddPhotoLibLibrary: (
    request: CreatePhotoLibraryRequest,
    files: File[],
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
  ) => Promise<boolean>;
}

interface SourceOption {
  type: SourceType;
  name: string;
  description: string;
  icon: 'folder' | 'server' | 'cloud' | 'protocol';
}

function buildSourceGroups(brandName: string, t: (k: string, opts?: Record<string, unknown>) => string): { title: string; sources: SourceOption[] }[] { return [
  {
    title: t('sources.groupLocal'),
    sources: [
      { type: 'local', name: t('sources.localFolder'), description: t('sources.localFolderDesc'), icon: 'folder' },
    ],
  },
  {
    title: t('sources.groupPhotoServer'),
    sources: [
      { type: 'photolib-library', name: t('sources.photoLibLibrary'), description: t('sources.photoLibLibraryDesc'), icon: 'folder' },
      { type: 'immich', name: 'Immich v2', description: t('sources.descImmich'), icon: 'server' },
      { type: 'immich-v3', name: 'Immich v3', description: t('sources.descImmichV3'), icon: 'server' },
      { type: 'photoprism', name: 'Photoprism', description: t('sources.descPhotoprism'), icon: 'server' },
      { type: 'piwigo', name: 'Piwigo', description: t('sources.descPiwigo'), icon: 'server' },
      { type: 'lychee', name: 'Lychee', description: t('sources.descLychee'), icon: 'server' },
      { type: 'synology', name: 'Synology Photos', description: t('sources.descSynology'), icon: 'server' },
      { type: 'librephotos', name: 'LibrePhotos', description: t('sources.descLibrePhotos'), icon: 'server' },
      { type: 'nextcloud-photos', name: 'Nextcloud Photos', description: t('sources.descNextcloud'), icon: 'server' },
      // Ente is disabled: the API returns encrypted blobs that require
      // client-side libsodium decryption (masterKey → collectionKey → fileKey
      // chain via XChaCha20-Poly1305). Not yet implemented — enabling the
      // source would show scrambled images. The client that never decrypted is
      // removed (tag attic/pre-deadcode-2026-09); re-enabling needs a new one
      // (see docs/source-api-reference.md#ente).
      // { type: 'ente', name: 'Ente', description: 'Encrypted, API-Token', icon: 'server' },
    ],
  },
  {
    title: t('sources.groupCloud'),
    sources: [
      { type: 'dropbox', name: 'Dropbox', description: t('sources.descDropbox'), icon: 'cloud' },
      { type: 'google-drive', name: 'Google Drive', description: t('sources.descGoogleDrive'), icon: 'cloud' },
      { type: 'onedrive', name: 'OneDrive', description: t('sources.descOneDrive'), icon: 'cloud' },
      { type: 'google-photos', name: 'Google Photos', description: t('sources.descGooglePhotos'), icon: 'cloud' },
      { type: 'flickr', name: 'Flickr', description: t('sources.descFlickr'), icon: 'cloud' },
      { type: 'smugmug', name: 'SmugMug', description: t('sources.descSmugmug'), icon: 'cloud' },
      { type: 's3', name: 'S3 / MinIO', description: t('sources.descS3'), icon: 'cloud' },
    ],
  },
  {
    title: t('sources.groupProtocol'),
    sources: [
      { type: 'webdav', name: 'WebDAV', description: t('sources.descWebDAV'), icon: 'protocol' },
      { type: 'server-path', name: t('sources.fields.serverUrl'), description: t('sources.descServerPath', { brand: brandName }), icon: 'protocol' },
      { type: 'ftp', name: 'FTP / SFTP', description: t('sources.descFtp'), icon: 'protocol' },
      { type: 'smb', name: t('sources.labelSmb'), description: t('sources.descSmb'), icon: 'protocol' },
      { type: 'ssh', name: 'SSH', description: t('sources.descSsh'), icon: 'protocol' },
      { type: 'nfs', name: 'NFS', description: t('sources.descNfs'), icon: 'protocol' },
    ],
  },
]; }

export function AddSourceDialog({
  open, onClose, onAddLocal, onAddImmich, onAddImmichV3,
  onAddServerPath, onAddWebDAV, onAddS3, onAddDropbox, onAddGoogleDrive, onAddGeneric,
  onAddPhotoLibLibrary,
}: AddSourceDialogProps) {
  const { t } = useTranslation();
  const brand = useBrand();
  const SOURCE_GROUPS = buildSourceGroups(brand.name, t);
  const [sourceType, setSourceType] = useState<SourceType | null>(null);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [libraryImportProgress, setLibraryImportProgress] = useState<{ completed: number; total: number } | null>(null);
  const libraryImportAbort = useRef<AbortController | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const setField = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));

  if (!open) return null;

  const handleBack = () => {
    setSourceType(null);
    setError('');
    setFields({});
    setLibraryImportProgress(null);
  };
  const handleClose = () => {
    libraryImportAbort.current?.abort();
    libraryImportAbort.current = null;
    handleBack();
    onClose();
  };

  const handleSubmit = async (fn: () => Promise<boolean>) => {
    setError('');
    setConnecting(true);
    try {
      const ok = await fn();
      if (ok) handleClose();
      else setError(t('sources.connectionFailed'));
    } catch (cause) {
      if (cause instanceof SourceConnectionError) {
        setError(sourceConnectionErrorMessage(cause, t));
      } else {
        setError(cause instanceof Error ? cause.message : t('sources.connectionFailed'));
      }
    } finally {
      setConnecting(false);
    }
  };

  const handleGeneric = (type: string, configKeys: string[], label: string) => {
    const config: Record<string, string> = {};
    for (const k of configKeys) config[k] = fields[k] ?? '';
    return handleSubmit(() => onAddGeneric?.(type, config, label) ?? Promise.resolve(false));
  };

  return (
    <div className="dialog-overlay" onClick={handleClose}>
      <div className={`dialog ${!sourceType ? 'dialog-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>{sourceType ? t('sources.dialogTitleConfigure') : t('sources.dialogTitleAdd')}</h3>
          <button className="dialog-close" onClick={handleClose}>&times;</button>
        </div>

        {/* ─── Source type picker ─── */}
        {!sourceType && (
          <div className="dialog-body source-picker">
            <div className="source-picker-local">
              <button
                className="source-type-btn"
                onClick={() => { onAddLocal(); handleClose(); }}
              >
                <FolderIcon />
                <div><strong>{t('sources.localFolder')}</strong><span>{t('sources.localFolderDesc')}</span></div>
              </button>
            </div>
            <div className="source-picker-columns">
              {SOURCE_GROUPS.filter((g) => g.title !== t('sources.groupLocal')).map((group) => (
                <div key={group.title} className="source-group">
                  <div className="source-group-title">{group.title}</div>
                  {group.sources.map((s) => {
                    const availability = sourceAvailability(s.type);
                    const enabled = availability === 'available';
                    const selfhostOnly = availability === 'selfhost-only';
                    return (
                      <button key={s.type}
                        className={`source-type-btn ${enabled ? '' : 'disabled'}`}
                        disabled={!enabled}
                        aria-disabled={!enabled}
                        title={selfhostOnly ? t('sources.badgeSelfhostOnlyHint') : undefined}
                        onClick={enabled ? () => setSourceType(s.type) : undefined}>
                        {s.icon === 'server' && <ServerIcon />}
                        {s.icon === 'folder' && <FolderIcon />}
                        {s.icon === 'cloud' && <CloudIcon />}
                        {s.icon === 'protocol' && <ProtocolIcon />}
                        <div><strong>{s.name}</strong><span>{s.description}</span></div>
                        {selfhostOnly && (
                          <span className="selfhost-only-badge">{t('sources.badgeSelfhostOnly')}</span>
                        )}
                        {availability === 'coming-soon' && (
                          <span className="coming-soon-badge">{t('sources.badgeComingSoon')}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── Existing forms ─── */}
        {sourceType === 'photolib-library' && (
          <PhotoLibLibraryForm
            onBack={handleBack}
            error={error}
            connecting={connecting}
            importProgress={libraryImportProgress}
            onSubmit={(request, files) => {
              const controller = new AbortController();
              libraryImportAbort.current = controller;
              return handleSubmit(async () => {
                try {
                  return await onAddPhotoLibLibrary(
                    request,
                    files,
                    (completed, total) => setLibraryImportProgress({ completed, total }),
                    controller.signal,
                  );
                } finally {
                  if (libraryImportAbort.current === controller) libraryImportAbort.current = null;
                }
              });
            }}
          />
        )}

        {sourceType === 'immich' && (
          <SourceFormWithAlbums sourceType="immich" title="Immich" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['serverUrl', 'apiKey']}
            onSubmit={(config, label, albumIds) => handleSubmit(() => onAddImmich(
              config.serverUrl,
              config.apiKey,
              label,
              albumIds,
              config.transport as SourceTransportMode,
            ))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.serverUrl')} placeholder="https://immich.example.com" value={f.serverUrl} onChange={(v) => set('serverUrl', v)} />
              <Field label={t('sources.fields.apiKey')} placeholder={t('sources.fields.apiKeyImmichPlaceholder')} value={f.apiKey} onChange={(v) => set('apiKey', v)} type="password" />
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 'immich-v3' && (
          <SourceFormWithAlbums sourceType="immich-v3" title="Immich v3" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['serverUrl', 'apiKey']}
            onSubmit={(config, label, albumIds) => handleSubmit(() => onAddImmichV3(
              config.serverUrl,
              config.apiKey,
              label,
              albumIds,
              config.transport as SourceTransportMode,
            ))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.serverUrl')} placeholder="https://immich.example.com" value={f.serverUrl} onChange={(v) => set('serverUrl', v)} />
              <Field label={t('sources.fields.apiKey')} placeholder={t('sources.fields.apiKeyImmichPlaceholder')} value={f.apiKey} onChange={(v) => set('apiKey', v)} type="password" />
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 'server-path' && onAddServerPath && (
          <SourceFormWithAlbums sourceType="server-path" title={t('sources.fields.serverUrl')} onBack={handleBack} error={error} connecting={connecting}
            configKeys={['serverUrl', 'rootPath']}
            onSubmit={(config, label) => handleSubmit(() => onAddServerPath(config.serverUrl, config.rootPath, label))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.backendUrl')} placeholder="http://localhost:3000" value={f.serverUrl} onChange={(v) => set('serverUrl', v)} />
              <Field label={t('sources.fields.path')} placeholder="/mnt/photos" value={f.rootPath} onChange={(v) => set('rootPath', v)} />
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 'webdav' && (
          <SourceFormWithAlbums sourceType="webdav" title="WebDAV" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['url', 'username', 'password']}
            onSubmit={(config, label, selectedPaths) => handleSubmit(() => onAddWebDAV?.(
              config.url,
              config.username,
              config.password,
              label,
              config.transport as SourceTransportMode,
              selectedPaths,
            ) ?? Promise.resolve(false))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.webdavUrl')} placeholder="https://cloud.example.com/remote.php/dav/files/user/" value={f.url} onChange={(v) => set('url', v)} />
              <Field label={t('sources.fields.username')} value={f.username} onChange={(v) => set('username', v)} />
              <Field label={t('sources.fields.password')} value={f.password} onChange={(v) => set('password', v)} type="password" />
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 's3' && (
          <SourceFormWithAlbums sourceType="s3" title="S3 / MinIO" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey', 'region', 'prefix']}
            onSubmit={(config, label) => handleSubmit(() => onAddS3?.(config.endpoint, config.bucket, config.accessKeyId, config.secretAccessKey, config.region || 'us-east-1', config.prefix, label) ?? Promise.resolve(false))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.endpoint')} placeholder="https://s3.amazonaws.com" value={f.endpoint} onChange={(v) => set('endpoint', v)} />
              <Field label={t('sources.fields.bucket')} value={f.bucket} onChange={(v) => set('bucket', v)} />
              <Field label={t('sources.fields.accessKeyId')} value={f.accessKeyId} onChange={(v) => set('accessKeyId', v)} />
              <Field label={t('sources.fields.secretAccessKey')} value={f.secretAccessKey} onChange={(v) => set('secretAccessKey', v)} type="password" />
              <Field label={t('sources.fields.region')} placeholder="eu-central-1" value={f.region} onChange={(v) => set('region', v)} />
              <Field label={t('sources.fields.prefixOptional')} placeholder="photos/" value={f.prefix} onChange={(v) => set('prefix', v)} />
            </>)}
          </SourceFormWithAlbums>
        )}

        {/* ─── API source forms ─── */}
        {sourceType === 'photoprism' && (
          <SourceFormWithAlbums sourceType="photoprism" title="Photoprism" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['serverUrl', 'username', 'password']}
            onSubmit={(config, label, albumIds) => handleSubmit(() => onAddGeneric?.('photoprism', { ...config, ...(albumIds ? { albumIds: albumIds.join(',') } : {}) }, label) ?? Promise.resolve(false))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.serverUrl')} placeholder="https://photos.example.com" value={f.serverUrl} onChange={(v) => set('serverUrl', v)} />
              <Field label={t('sources.fields.username')} placeholder="admin" value={f.username} onChange={(v) => set('username', v)} />
              <Field label={t('sources.fields.password')} value={f.password} onChange={(v) => set('password', v)} type="password" />
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 'piwigo' && (
          <SourceFormWithAlbums sourceType="piwigo" title="Piwigo" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['serverUrl', 'apiKey']}
            onSubmit={(config, label, albumIds) => handleSubmit(() => onAddGeneric?.('piwigo', { ...config, ...(albumIds ? { albumIds: albumIds.join(',') } : {}) }, label) ?? Promise.resolve(false))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.serverUrl')} placeholder="https://piwigo.example.com" value={f.serverUrl} onChange={(v) => set('serverUrl', v)} />
              <Field label={t('sources.fields.apiKey')} placeholder="pkid-xxx:secret" value={f.apiKey} onChange={(v) => set('apiKey', v)} type="password" />
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 'lychee' && (
          <SourceFormWithAlbums sourceType="lychee" title="Lychee" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['serverUrl', 'apiToken']}
            onSubmit={(config, label, albumIds) => handleSubmit(() => onAddGeneric?.('lychee', { ...config, ...(albumIds ? { albumIds: albumIds.join(',') } : {}) }, label) ?? Promise.resolve(false))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.serverUrl')} placeholder="https://lychee.example.com" value={f.serverUrl} onChange={(v) => set('serverUrl', v)} />
              <Field label={t('sources.fields.apiToken')} value={f.apiToken} onChange={(v) => set('apiToken', v)} type="password" />
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 'synology' && (
          <SourceFormWithAlbums sourceType="synology" title="Synology Photos" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['serverUrl', 'username', 'password', 'otpCode', 'space']}
            onSubmit={(config, label, albumIds) => handleSubmit(() => onAddGeneric?.('synology', { ...config, space: config.space || 'both', ...(albumIds ? { albumIds: albumIds.join(',') } : {}) }, label) ?? Promise.resolve(false))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.nasUrl')} placeholder="https://nas.local:5001" value={f.serverUrl} onChange={(v) => set('serverUrl', v)} />
              <Field label={t('sources.fields.username')} value={f.username} onChange={(v) => set('username', v)} />
              <Field label={t('sources.fields.password')} value={f.password} onChange={(v) => set('password', v)} type="password" />
              <Field label={t('sources.fields.otpCode')} placeholder="123456" value={f.otpCode} onChange={(v) => set('otpCode', v)} />
              <div className="form-field">
                <label>{t('sources.fields.space')}</label>
                <select value={f.space ?? 'both'} onChange={(e) => set('space', e.target.value)}>
                  <option value="both">{t('sources.fields.spaceBoth')}</option>
                  <option value="personal">{t('sources.fields.spacePersonal')}</option>
                  <option value="shared">{t('sources.fields.spaceShared')}</option>
                </select>
              </div>
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 'librephotos' && (
          <SourceFormWithAlbums sourceType="librephotos" title="LibrePhotos" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['serverUrl', 'username', 'password']}
            onSubmit={(config, label, albumIds) => handleSubmit(() => onAddGeneric?.('librephotos', { ...config, ...(albumIds ? { albumIds: albumIds.join(',') } : {}) }, label) ?? Promise.resolve(false))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.serverUrl')} placeholder="https://librephotos.example.com" value={f.serverUrl} onChange={(v) => set('serverUrl', v)} />
              <Field label={t('sources.fields.username')} value={f.username} onChange={(v) => set('username', v)} />
              <Field label={t('sources.fields.password')} value={f.password} onChange={(v) => set('password', v)} type="password" />
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 'nextcloud-photos' && (
          <SourceFormWithAlbums sourceType="nextcloud-photos" title="Nextcloud Photos" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['serverUrl', 'username', 'password']}
            onSubmit={(config, label, albumIds) => handleSubmit(() => onAddGeneric?.('nextcloud-photos', { ...config, ...(albumIds ? { albumIds: albumIds.join(',') } : {}) }, label) ?? Promise.resolve(false))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.nextcloudUrl')} placeholder="https://cloud.example.com" value={f.serverUrl} onChange={(v) => set('serverUrl', v)} />
              <Field label={t('sources.fields.username')} value={f.username} onChange={(v) => set('username', v)} />
              <Field label={t('sources.fields.appPassword')} value={f.password} onChange={(v) => set('password', v)} type="password" />
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 'ente' && (
          <FormBody title="Ente" onBack={handleBack} error={error} connecting={connecting}
            onSubmit={() => handleGeneric('ente', ['serverUrl', 'apiToken'], fields.label || 'Ente')}>
            <Field label={t('sources.fields.serverUrl')} placeholder="https://api.ente.io" value={fields.serverUrl} onChange={(v) => setField('serverUrl', v)} />
            <Field label={t('sources.fields.apiToken')} value={fields.apiToken} onChange={(v) => setField('apiToken', v)} type="password" />
            <Field label={t('sources.label')} placeholder="Ente" value={fields.label} onChange={(v) => setField('label', v)} />
          </FormBody>
        )}

        {/* ─── Cloud OAuth forms ─── */}
        {sourceType === 'dropbox' && (
          <OAuthSourceForm provider="dropbox" title="Dropbox" onBack={handleBack} error={error} connecting={connecting}
            onSubmit={(token) => handleSubmit(() => onAddDropbox?.(token, fields.rootPath ?? '', fields.label ?? 'Dropbox') ?? Promise.resolve(false))}>
            <Field label={t('sources.fields.pathOptional')} placeholder="/Photos" value={fields.rootPath} onChange={(v) => setField('rootPath', v)} />
            <Field label={t('sources.label')} placeholder="Dropbox" value={fields.label} onChange={(v) => setField('label', v)} />
          </OAuthSourceForm>
        )}

        {sourceType === 'google-drive' && (
          <OAuthSourceForm provider="google" title="Google Drive" onBack={handleBack} error={error} connecting={connecting}
            onSubmit={(token) => handleSubmit(() => onAddGoogleDrive?.(token, fields.folderId ?? 'root', fields.label ?? 'Google Drive') ?? Promise.resolve(false))}>
            <Field label={t('sources.fields.folderIdOptional')} placeholder="root" value={fields.folderId} onChange={(v) => setField('folderId', v)} />
            <Field label={t('sources.label')} placeholder="Google Drive" value={fields.label} onChange={(v) => setField('label', v)} />
          </OAuthSourceForm>
        )}

        {sourceType === 'onedrive' && (
          <OAuthSourceForm provider="microsoft" title="OneDrive" onBack={handleBack} error={error} connecting={connecting}
            onSubmit={() => handleGeneric('onedrive', ['folderId'], fields.label || 'OneDrive')}>
            <Field label={t('sources.fields.folderIdOptional')} placeholder="root" value={fields.folderId} onChange={(v) => setField('folderId', v)} />
            <Field label={t('sources.label')} placeholder="OneDrive" value={fields.label} onChange={(v) => setField('label', v)} />
          </OAuthSourceForm>
        )}

        {sourceType === 'google-photos' && (
          <OAuthSourceForm provider="google" title="Google Photos" onBack={handleBack} error={error} connecting={connecting}
            onSubmit={() => handleGeneric('google-photos', [], fields.label || 'Google Photos')}>
            <Field label={t('sources.label')} placeholder="Google Photos" value={fields.label} onChange={(v) => setField('label', v)} />
          </OAuthSourceForm>
        )}

        {sourceType === 'flickr' && (
          <SourceFormWithAlbums sourceType="flickr" title="Flickr" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['apiKey', 'userId']}
            onSubmit={(config, label, albumIds) => handleSubmit(() => onAddGeneric?.('flickr', { ...config, ...(albumIds ? { albumIds: albumIds.join(',') } : {}) }, label) ?? Promise.resolve(false))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.apiKey')} placeholder="Flickr API Key" value={f.apiKey} onChange={(v) => set('apiKey', v)} />
              <Field label={t('sources.fields.userId')} placeholder="12345678@N00" value={f.userId} onChange={(v) => set('userId', v)} />
            </>)}
          </SourceFormWithAlbums>
        )}

        {sourceType === 'smugmug' && (
          <SourceFormWithAlbums sourceType="smugmug" title="SmugMug" onBack={handleBack} error={error} connecting={connecting}
            configKeys={['apiKey', 'accessToken', 'username']}
            onSubmit={(config, label, albumIds) => handleSubmit(() => onAddGeneric?.('smugmug', { ...config, ...(albumIds ? { albumIds: albumIds.join(',') } : {}) }, label) ?? Promise.resolve(false))}>
            {(f: Record<string, string>, set: (k: string, v: string) => void) => (<>
              <Field label={t('sources.fields.apiKey')} value={f.apiKey} onChange={(v) => set('apiKey', v)} />
              <Field label={t('sources.accessTokenLabel')} value={f.accessToken} onChange={(v) => set('accessToken', v)} type="password" />
              <Field label={t('sources.fields.username')} value={f.username} onChange={(v) => set('username', v)} />
            </>)}
          </SourceFormWithAlbums>
        )}

        {/* ─── Protocol source forms (require backend) ─── */}
        {sourceType === 'ftp' && (
          <FormBody title="FTP / SFTP" onBack={handleBack} error={error} connecting={connecting}
            onSubmit={() => handleGeneric('ftp', ['serverUrl', 'host', 'port', 'username', 'password', 'basePath', 'protocol'], fields.label || 'FTP')}>
            <Field label={t('sources.fields.backendUrl')} placeholder="http://localhost:3000" value={fields.serverUrl} onChange={(v) => setField('serverUrl', v)} />
            <div className="form-field">
              <label>{t('sources.fields.protocol')}</label>
              <select value={fields.protocol ?? 'sftp'} onChange={(e) => setField('protocol', e.target.value)}>
                <option value="sftp">SFTP</option>
                <option value="ftp">FTP</option>
              </select>
            </div>
            <Field label={t('sources.fields.host')} placeholder="192.168.1.100" value={fields.host} onChange={(v) => setField('host', v)} />
            <Field label={t('sources.fields.port')} placeholder={fields.protocol === 'ftp' ? '21' : '22'} value={fields.port} onChange={(v) => setField('port', v)} />
            <Field label={t('sources.fields.username')} value={fields.username} onChange={(v) => setField('username', v)} />
            <Field label={t('sources.fields.password')} value={fields.password} onChange={(v) => setField('password', v)} type="password" />
            <Field label={t('sources.fields.path')} placeholder="/photos" value={fields.basePath} onChange={(v) => setField('basePath', v)} />
            <Field label={t('sources.label')} placeholder={t('sources.placeholders.ftpServer')} value={fields.label} onChange={(v) => setField('label', v)} />
          </FormBody>
        )}

        {sourceType === 'smb' && (
          <FormBody title={t('sources.labelSmb')} onBack={handleBack} error={error} connecting={connecting}
            onSubmit={() => handleGeneric('smb', ['serverUrl', 'share', 'username', 'password', 'domain', 'basePath'], fields.label || t('sources.labelSmb'))}>
            <Field label={t('sources.fields.backendUrl')} placeholder="http://localhost:3000" value={fields.serverUrl} onChange={(v) => setField('serverUrl', v)} />
            <Field label={t('sources.fields.share')} placeholder="//192.168.1.100/fotos" value={fields.share} onChange={(v) => setField('share', v)} />
            <Field label={t('sources.fields.username')} value={fields.username} onChange={(v) => setField('username', v)} />
            <Field label={t('sources.fields.password')} value={fields.password} onChange={(v) => setField('password', v)} type="password" />
            <Field label={t('sources.fields.domainOptional')} placeholder="WORKGROUP" value={fields.domain} onChange={(v) => setField('domain', v)} />
            <Field label={t('sources.fields.subPathOptional')} placeholder={t('sources.placeholders.smbFolder')} value={fields.basePath} onChange={(v) => setField('basePath', v)} />
            <Field label={t('sources.label')} placeholder={t('sources.placeholders.nasFolder')} value={fields.label} onChange={(v) => setField('label', v)} />
          </FormBody>
        )}

        {sourceType === 'ssh' && (
          <FormBody title="SSH" onBack={handleBack} error={error} connecting={connecting}
            onSubmit={() => handleGeneric('ssh', ['serverUrl', 'host', 'port', 'username', 'password', 'basePath'], fields.label || 'SSH')}>
            <Field label={t('sources.fields.backendUrl')} placeholder="http://localhost:3000" value={fields.serverUrl} onChange={(v) => setField('serverUrl', v)} />
            <Field label={t('sources.fields.host')} placeholder="192.168.1.100" value={fields.host} onChange={(v) => setField('host', v)} />
            <Field label={t('sources.fields.port')} placeholder="22" value={fields.port} onChange={(v) => setField('port', v)} />
            <Field label={t('sources.fields.username')} value={fields.username} onChange={(v) => setField('username', v)} />
            <Field label={t('sources.fields.password')} value={fields.password} onChange={(v) => setField('password', v)} type="password" />
            <Field label={t('sources.fields.path')} placeholder="/volume1/photos" value={fields.basePath} onChange={(v) => setField('basePath', v)} />
            <Field label={t('sources.label')} placeholder={t('sources.placeholders.serverFolder')} value={fields.label} onChange={(v) => setField('label', v)} />
          </FormBody>
        )}

        {sourceType === 'nfs' && (
          <FormBody title="NFS" onBack={handleBack} error={error} connecting={connecting}
            onSubmit={() => handleGeneric('nfs', ['serverUrl', 'host', 'exportPath', 'basePath'], fields.label || 'NFS')}>
            <Field label={t('sources.fields.backendUrl')} placeholder="http://localhost:3000" value={fields.serverUrl} onChange={(v) => setField('serverUrl', v)} />
            <Field label={t('sources.fields.host')} placeholder="192.168.1.100" value={fields.host} onChange={(v) => setField('host', v)} />
            <Field label={t('sources.fields.exportPath')} placeholder="/volume1/photos" value={fields.exportPath} onChange={(v) => setField('exportPath', v)} />
            <Field label={t('sources.fields.subPathOptional')} value={fields.basePath} onChange={(v) => setField('basePath', v)} />
            <Field label={t('sources.label')} placeholder={t('sources.placeholders.nfsFolder')} value={fields.label} onChange={(v) => setField('label', v)} />
          </FormBody>
        )}
      </div>
    </div>
  );
}

/* ─── Helper Components ─── */

function PhotoLibLibraryForm({ onBack, error, connecting, importProgress, onSubmit }: {
  onBack: () => void;
  error: string;
  connecting: boolean;
  importProgress: { completed: number; total: number } | null;
  onSubmit: (request: CreatePhotoLibraryRequest, files: File[]) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<LibraryMode>('external');
  const [name, setName] = useState('');
  const [roots, setRoots] = useState<AvailableLibraryRoot[]>([]);
  const [selectedRoots, setSelectedRoots] = useState<Set<string>>(new Set());
  const [patterns, setPatterns] = useState('');
  const [includeHidden, setIncludeHidden] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [rootError, setRootError] = useState('');

  useEffect(() => {
    let cancelled = false;
    listAvailableLibraryRoots()
      .then((available) => {
        if (!cancelled) setRoots(available);
      })
      .catch((cause) => {
        if (!cancelled) setRootError(cause instanceof Error ? cause.message : t('sources.libraryRootsFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoadingRoots(false);
      });
    return () => { cancelled = true; };
  }, [t]);

  const toggleRoot = (rootId: string) => {
    setSelectedRoots((previous) => {
      const next = new Set(previous);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  };

  const submit = () => {
    const exclusionPatterns = patterns
      .split(/\r?\n|,/)
      .map((pattern) => pattern.trim())
      .filter(Boolean);
    onSubmit({
      name: name.trim(),
      mode,
      roots: mode === 'external'
        ? [...selectedRoots].map((rootId) => ({ rootId }))
        : undefined,
      exclusionPatterns,
      includeHidden,
    }, mode === 'managed' ? files : []);
  };

  const canSubmit = name.trim().length > 0
    && (mode === 'managed' || selectedRoots.size > 0)
    && !connecting;

  return (
    <div className="dialog-body photolib-library-form">
      <button className="dialog-back" onClick={onBack}>{t('sources.backLabel')}</button>
      <h3>{t('sources.photoLibLibrary')}</h3>
      <p className="form-hint-block">{t('sources.libraryNoServerUrl')}</p>

      <div className="library-mode-grid">
        <button
          type="button"
          className={`library-mode-card ${mode === 'external' ? 'active' : ''}`}
          onClick={() => setMode('external')}
        >
          <FolderIcon />
          <strong>{t('sources.libraryExternal')}</strong>
          <span>{t('sources.libraryExternalDesc')}</span>
        </button>
        <button
          type="button"
          className={`library-mode-card ${mode === 'managed' ? 'active' : ''}`}
          onClick={() => setMode('managed')}
        >
          <ServerIcon />
          <strong>{t('sources.libraryManaged')}</strong>
          <span>{t('sources.libraryManagedDesc')}</span>
        </button>
      </div>

      <Field
        label={t('sources.libraryName')}
        placeholder={mode === 'external' ? t('sources.libraryExternalPlaceholder') : t('sources.libraryManagedPlaceholder')}
        value={name}
        onChange={setName}
      />

      {mode === 'external' ? (
        <div className="form-field">
          <label>{t('sources.libraryRoots')}</label>
          {loadingRoots && <div className="library-root-empty">{t('sources.libraryRootsLoading')}</div>}
          {!loadingRoots && roots.length === 0 && (
            <div className="library-root-empty">{t('sources.libraryRootsEmpty')}</div>
          )}
          <div className="library-root-list">
            {roots.map((root) => (
              <label key={root.id} className={`library-root-item ${!root.available ? 'disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={selectedRoots.has(root.id)}
                  disabled={!root.available}
                  onChange={() => toggleRoot(root.id)}
                />
                <span>{root.label}</span>
                <small>{root.available ? t('sources.libraryRootReadOnly') : t('sources.libraryRootUnavailable')}</small>
              </label>
            ))}
          </div>
          {rootError && <div className="form-error">{rootError}</div>}
        </div>
      ) : (
        <div className="form-field">
          <label>{t('sources.libraryInitialFiles')}</label>
          <input
            type="file"
            accept="image/*,.heic,.heif,.hif,.dng,.cr2,.cr3,.nef,.nrw,.arw,.raf,.rw2,.orf,.pef,.srw,.x3f"
            multiple
            onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
          />
          <small className="library-field-help">
            {files.length > 0
              ? t('sources.libraryFilesSelected', { count: files.length })
              : t('sources.libraryFilesOptional')}
          </small>
        </div>
      )}

      <div className="form-field">
        <label>{t('sources.libraryExclusions')}</label>
        <textarea
          rows={3}
          value={patterns}
          placeholder="**/.thumbnails/**, **/cache/**"
          onChange={(event) => setPatterns(event.target.value)}
        />
      </div>
      <label className="album-filter-toggle">
        <input type="checkbox" checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} />
        <span>{t('sources.libraryIncludeHidden')}</span>
      </label>
      {error && <div className="form-error">{error}</div>}
      {connecting && importProgress && importProgress.total > 0 && (
        <div className="library-import-progress" role="status">
          <span>{t('sources.libraryImportProgress', importProgress)}</span>
          <progress value={importProgress.completed} max={importProgress.total} />
        </div>
      )}
      <button className="dialog-submit" onClick={submit} disabled={!canSubmit}>
        {connecting && importProgress && importProgress.total > 0
          ? t('sources.libraryImporting')
          : connecting
            ? t('sources.libraryCreating')
            : t('sources.libraryCreate')}
      </button>
    </div>
  );
}

function FormBody({ title, onBack, error, connecting, onSubmit, children }: {
  title: string; onBack: () => void; error: string; connecting: boolean;
  onSubmit: () => void; children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="dialog-body">
      <button className="dialog-back" onClick={onBack}>{t('sources.backLabel')}</button>
      <h3>{title}</h3>
      {children}
      {error && <div className="form-error">{error}</div>}
      <button className="dialog-submit" onClick={onSubmit} disabled={connecting}>
        {connecting ? t('sources.connecting') : t('sources.connect')}
      </button>
    </div>
  );
}

function Field({ label, placeholder, value, onChange, type }: {
  label: string; placeholder?: string; value?: string; onChange: (v: string) => void; type?: string;
}) {
  return (
    <div className="form-field">
      <label>{label}</label>
      <input type={type ?? 'text'} placeholder={placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/* ─── Generic source form with optional album/folder selection ─── */

/** Sources that support album/folder selection */
const SOURCES_WITH_ALBUMS = new Set<SourceType>([
  'immich', 'immich-v3', 'photoprism', 'piwigo', 'lychee', 'synology', 'librephotos',
  'nextcloud-photos', 'flickr', 'smugmug', 'google-photos',
  'dropbox', 'google-drive', 'onedrive', 'webdav', 's3', 'server-path',
]);

type SourceFormChildren =
  | React.ReactNode
  | ((fields: Record<string, string>, setField: (k: string, v: string) => void) => React.ReactNode);

function SourceFormWithAlbums({ sourceType, title, onBack, error, connecting, configKeys, onSubmit, children }: {
  sourceType: SourceType; title: string; onBack: () => void; error: string; connecting: boolean;
  configKeys: string[];
  onSubmit: (config: Record<string, string>, label: string, albumIds?: string[]) => void;
  children: SourceFormChildren;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<'credentials' | 'albums'>('credentials');
  const [fields, setFields] = useState<Record<string, string>>({});
  const setField = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }));
  const [filterByAlbum, setFilterByAlbum] = useState(false);
  const [albums, setAlbums] = useState<SourceBrowseItem[]>([]);
  const [selectedAlbums, setSelectedAlbums] = useState<Set<string>>(new Set());
  const [loadingAlbums, setLoadingAlbums] = useState(false);
  const [albumError, setAlbumError] = useState('');
  // Not a hard-coded 'server-proxy': in a build without a backend the proxy
  // does not exist, and writing it into the config would pin every new source
  // to a transport that cannot work (§P4).
  const [transport, setTransport] = useState<SourceTransportMode>(
    () => resolveSourceTransportMode(undefined, sourceType),
  );

  const supportsAlbums = SOURCES_WITH_ALBUMS.has(sourceType);
  const supportsBrowserDirect = supportsBrowserDirectTransport(sourceType);

  const buildConfig = (): Record<string, string> => {
    const config: Record<string, string> = {};
    for (const k of configKeys) config[k] = fields[k] ?? '';
    if (supportsBrowserDirect) config.transport = transport;
    return config;
  };

  const handleNext = async () => {
    if (!filterByAlbum) {
      onSubmit(buildConfig(), fields.label || title);
      return;
    }
    setLoadingAlbums(true);
    setAlbumError('');
    try {
      const config = buildConfig();
      const sourceName = fields.label || title;
      const items = await sourceManager.tryListAlbums(
        sourceType,
        config as Record<string, unknown>,
        sourceName,
      );
      if (items.length === 0) { setAlbumError(t('sources.noAlbumsFound')); return; }
      setAlbums(items);
      setStep('albums');
    } catch (cause) {
      setAlbumError(cause instanceof SourceConnectionError
        ? sourceConnectionErrorMessage(cause, t)
        : t('sources.connectionFailedShort'));
    }
    finally { setLoadingAlbums(false); }
  };

  const flatItems = flattenBrowseItems(albums, t('sources.browseItemWithoutName'));
  const toggleAlbum = (id: string) => setSelectedAlbums((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelectedAlbums(selectedAlbums.size === flatItems.length ? new Set() : new Set(flatItems.map((a) => a.id)));

  if (step === 'albums') {
    return (
      <div className="dialog-body">
        <button className="dialog-back" onClick={() => setStep('credentials')}>{t('sources.backLabel')}</button>
        <div className="album-list-header">
          <span>{flatItems.length} {flatItems.some((i) => i.type === 'folder') ? t('sources.albumListEntries') : t('sources.albumListAlbums')}</span>
          <button className="album-select-all" onClick={toggleAll}>{selectedAlbums.size === flatItems.length ? t('sources.selectNone') : t('sources.selectAll')}</button>
        </div>
        <div className="album-list">
          {flatItems.map((a) => (
            <label key={a.id} className={`album-item ${selectedAlbums.has(a.id) ? 'selected' : ''}`}>
              <input type="checkbox" checked={selectedAlbums.has(a.id)} onChange={() => toggleAlbum(a.id)} />
              <span className="album-name">{a.name}</span>
              {a.photoCount !== undefined && <span className="album-count">{a.photoCount}</span>}
            </label>
          ))}
        </div>
        {error && <div className="form-error">{error}</div>}
        <button className="dialog-submit"
          onClick={() => onSubmit(buildConfig(), fields.label || title, Array.from(selectedAlbums))}
          disabled={connecting || selectedAlbums.size === 0}>
          {connecting ? t('sources.connecting') : t('sources.importSelected', { count: selectedAlbums.size })}
        </button>
      </div>
    );
  }

  return (
    <div className="dialog-body">
      <button className="dialog-back" onClick={onBack}>{t('sources.backLabel')}</button>
      {/* Render children with field setter injected via context-like pattern */}
      {typeof children === 'function'
        ? (children as (fields: Record<string, string>, setField: (k: string, v: string) => void) => React.ReactNode)(fields, setField)
        : children}
      {/* Same predicate the sync redaction uses, so the note appears exactly on
          the fields that sync strips before sending - and nowhere else. */}
      {configKeys.some(isSensitiveSourceConfigKey) && (
        <p className="source-credentials-note">{t('sources.credentialsNote')}</p>
      )}
      {supportsBrowserDirect && (
        <SourceTransportSelector value={transport} onChange={setTransport} sourceType={sourceType} />
      )}
      <Field label={t('sources.label')} placeholder={title} value={fields.label} onChange={(v) => setField('label', v)} />
      {supportsAlbums && (
        <label className="album-filter-toggle">
          <input type="checkbox" checked={filterByAlbum} onChange={(e) => setFilterByAlbum(e.target.checked)} />
          <span>{t('sources.filterAlbumsToggle')}</span>
        </label>
      )}
      {albumError && <div className="form-error">{albumError}</div>}
      {error && <div className="form-error">{error}</div>}
      <button className="dialog-submit" onClick={handleNext} disabled={connecting || loadingAlbums}>
        {loadingAlbums ? t('sources.loadingAlbums') : filterByAlbum ? t('sources.loadAlbums') : connecting ? t('sources.connecting') : t('sources.connect')}
      </button>
    </div>
  );
}

function SourceTransportSelector({ value, onChange, sourceType }: {
  value: SourceTransportMode;
  onChange: (value: SourceTransportMode) => void;
  sourceType: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [serverKind, setServerKind] = useState<CorsServerKind>('nginx');
  const [snippetCopied, setSnippetCopied] = useState(false);
  // Both ways are always shown, so that "through the browser" reads as a
  // choice rather than as the absence of one. Without a backend the server
  // route cannot work at all, so it is offered but not selectable — picking
  // it would have written a transport into the config that never connects.
  const serverAvailable = hasBackend();

  const copySnippet = () => {
    void navigator.clipboard?.writeText(corsSnippet(serverKind, sourceType, directConnectionOrigin()))
      .then(() => {
        setSnippetCopied(true);
        setTimeout(() => setSnippetCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  const copyHeaderLine = () => {
    // The clipboard API needs a secure context; on a plain-HTTP deploy it is
    // simply absent. The line stays selectable either way.
    void navigator.clipboard?.writeText(directOriginHeaderLine())
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  return (
    <fieldset className="source-transport-selector">
      <legend>{t('sources.transportLabel')}</legend>
      <label className={[
        value === 'server-proxy' ? 'active' : '',
        serverAvailable ? '' : 'unavailable',
      ].filter(Boolean).join(' ')}>
        <input
          type="radio"
          name="source-transport"
          value="server-proxy"
          checked={value === 'server-proxy'}
          disabled={!serverAvailable}
          onChange={() => onChange('server-proxy')}
        />
        <span>
          <strong>{t('sources.transportServer')}</strong>
          <small>{t('sources.transportServerDesc')}</small>
          {!serverAvailable && (
            <small className="transport-unavailable">{t('sources.transportServerNeedsBackend')}</small>
          )}
        </span>
      </label>
      <label className={value === 'browser-direct' ? 'active' : ''}>
        <input
          type="radio"
          name="source-transport"
          value="browser-direct"
          checked={value === 'browser-direct'}
          onChange={() => onChange('browser-direct')}
        />
        <span>
          <strong>{t('sources.transportBrowser')}</strong>
          <small>{t('sources.transportBrowserDesc')}</small>
        </span>
      </label>
      {value === 'browser-direct' && (
        <>
          <p>{t('sources.transportBrowserHint')}</p>
          <div className="source-transport-cors">
            <span>{t('sources.transportCorsHeaderLabel')}</span>
            <code>{directOriginHeaderLine()}</code>
            <button type="button" onClick={copyHeaderLine}>
              {copied ? t('sources.transportCorsCopied') : t('sources.transportCorsCopy')}
            </button>
          </div>
          <button
            type="button"
            className="cors-snippets-toggle"
            aria-expanded={snippetsOpen}
            onClick={() => setSnippetsOpen((v) => !v)}
          >
            {snippetsOpen ? t('sources.corsSnippetsHide') : t('sources.corsSnippetsShow')}
          </button>
          {snippetsOpen && (
            <div className="cors-snippets">
              {/* Plain toggle buttons, not role="tab": there is no tabpanel to
                  point at, and a tab role without one reads worse than the
                  native button role it would replace. */}
              <div className="cors-snippet-kinds">
                {CORS_SERVER_KINDS.map(({ kind, label }) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={serverKind === kind}
                    className={serverKind === kind ? 'active' : ''}
                    onClick={() => setServerKind(kind)}
                  >{label}</button>
                ))}
              </div>
              <pre><code>{corsSnippet(serverKind, sourceType, directConnectionOrigin())}</code></pre>
              <div className="cors-snippet-actions">
                <button type="button" onClick={copySnippet}>
                  {snippetCopied ? t('sources.transportCorsCopied') : t('sources.transportCorsCopy')}
                </button>
                <small>{t('sources.corsSnippetsNote')}</small>
              </div>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}

/* ─── OAuth Source Form ─── */
function OAuthSourceForm({ provider, title, onBack, error, connecting, onSubmit, children }: {
  provider: OAuthProviderName; title: string; onBack: () => void; error: string; connecting: boolean;
  onSubmit: (token: string) => void; children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'oauth' | 'manual'>('oauth');
  const [clientId, setClientId] = useState('');
  const [token, setToken] = useState('');
  const [oauthError, setOauthError] = useState('');
  const [authenticating, setAuthenticating] = useState(false);

  const handleOAuth = async () => {
    setOauthError('');
    setAuthenticating(true);
    try { const result = await startOAuthFlow(provider, clientId); setToken(result.accessToken); }
    catch (e) { setOauthError((e as Error).message); }
    finally { setAuthenticating(false); }
  };

  return (
    <div className="dialog-body">
      <button className="dialog-back" onClick={onBack}>{t('sources.backLabel')}</button>
      <div className="form-mode-toggle">
        <button className={mode === 'oauth' ? 'active' : ''} onClick={() => setMode('oauth')}>{t('sources.modeOauth')}</button>
        <button className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>{t('sources.modeManual')}</button>
      </div>
      {mode === 'oauth' ? (
        <>
          <Field label={t('sources.oauthClientId')} placeholder={t('sources.oauthClientIdPlaceholder', { name: title })} value={clientId} onChange={setClientId} />
          {!token ? (
            <button className="dialog-submit" onClick={handleOAuth} disabled={!clientId || authenticating} style={{ marginBottom: 12 }}>
              {authenticating ? t('sources.oauthAuthenticating') : t('sources.oauthSignIn', { name: title })}
            </button>
          ) : (
            <div className="form-success" style={{ marginBottom: 8, color: 'var(--color-success, #2ecc71)' }}>{t('sources.oauthAuthenticated')}</div>
          )}
          {oauthError && <div className="form-error">{oauthError}</div>}
        </>
      ) : (
        <Field label={t('sources.accessTokenLabel')} placeholder={t('sources.accessTokenPlaceholder', { name: title })} value={token} onChange={setToken} type="password" />
      )}
      {children}
      {error && <div className="form-error">{error}</div>}
      <button className="dialog-submit" onClick={() => onSubmit(token)} disabled={connecting || !token}>
        {connecting ? t('sources.connecting') : t('sources.connect')}
      </button>
    </div>
  );
}

/* ─── Icons ─── */
function FolderIcon() { return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 6V18a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2h-7l-2-3H4a2 2 0 00-2 2z" /></svg>; }
function ServerIcon() { return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="2" y="3" width="20" height="7" rx="2" /><rect x="2" y="14" width="20" height="7" rx="2" /><circle cx="6" cy="6.5" r="1" fill="currentColor" /><circle cx="6" cy="17.5" r="1" fill="currentColor" /></svg>; }
function CloudIcon() { return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6 19a4 4 0 01-.88-7.9A6 6 0 0117.73 10 4 4 0 1118 19H6z" /></svg>; }
function ProtocolIcon() { return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 12h16M4 6h16M4 18h16" /><circle cx="8" cy="6" r="1.5" fill="currentColor" /><circle cx="16" cy="12" r="1.5" fill="currentColor" /><circle cx="10" cy="18" r="1.5" fill="currentColor" /></svg>; }
