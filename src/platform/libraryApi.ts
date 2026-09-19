import type {
  AvailableLibraryRoot,
  CreatePhotoLibraryImportRequest,
  CreatePhotoLibraryRequest,
  LibraryAssetStatus,
  PhotoLibrary,
  PhotoLibraryAsset,
  PhotoLibraryAssetChanges,
  PhotoLibraryAssetPage,
  PhotoLibraryScan,
  PhotoLibraryStats,
  PhotoLibraryImport,
  PhotoLibraryImportCommit,
  PhotoLibraryIntegrityReport,
  UpdatePhotoLibraryRequest,
} from '@photolib/shared';
import { apiFetch } from './api';

export class LibraryApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(
    message: string,
    status: number,
    code: string | null = null,
  ) {
    super(message);
    this.name = 'LibraryApiError';
    this.status = status;
    this.code = code;
  }
}

export async function listPhotoLibraries(): Promise<PhotoLibrary[]> {
  const body = await requestJson<{ libraries: PhotoLibrary[] }>('/api/libraries');
  return body.libraries;
}

export async function listAvailableLibraryRoots(): Promise<AvailableLibraryRoot[]> {
  const body = await requestJson<{ roots: AvailableLibraryRoot[] }>('/api/libraries/available-roots');
  return body.roots;
}

/**
 * The answer of `POST /api/libraries/locate-root`. Mirrors
 * `LocatedLibraryRoot` in packages/backend/src/libraries/library.paths.ts;
 * only the root itself is a shared type.
 */
export interface LocatedLibraryRoot {
  root: AvailableLibraryRoot;
  /** Where the source's directory sits in that root; '' means the root. */
  relativePath: string;
}

/**
 * Which configured root holds an absolute server path, and where inside it.
 *
 * The Phase-8 migration assistant asks this for the root of a legacy
 * `server-path` source; a `ROOT_NOT_ALLOWED` answer means this backend does
 * not offer that directory as a library root.
 */
export function locateLibraryRoot(serverPath: string): Promise<LocatedLibraryRoot> {
  return requestJson<LocatedLibraryRoot>('/api/libraries/locate-root', {
    method: 'POST',
    body: JSON.stringify({ path: serverPath }),
  });
}

export async function createPhotoLibrary(request: CreatePhotoLibraryRequest): Promise<PhotoLibrary> {
  const body = await requestJson<{ library: PhotoLibrary }>('/api/libraries', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  return body.library;
}

export async function getPhotoLibrary(libraryId: string): Promise<PhotoLibrary> {
  const body = await requestJson<{ library: PhotoLibrary }>(libraryPath(libraryId));
  return body.library;
}

export async function updatePhotoLibrary(
  libraryId: string,
  request: UpdatePhotoLibraryRequest,
): Promise<PhotoLibrary> {
  const body = await requestJson<{ library: PhotoLibrary }>(libraryPath(libraryId), {
    method: 'PATCH',
    body: JSON.stringify(request),
  });
  return body.library;
}

export async function deletePhotoLibrary(libraryId: string): Promise<void> {
  const response = await apiFetch(`${libraryPath(libraryId)}?preserveOriginals=true`, {
    method: 'DELETE',
  });
  if (!response.ok) await throwResponseError(response);
}

export async function createPhotoLibraryImport(
  libraryId: string,
  request: CreatePhotoLibraryImportRequest,
  signal?: AbortSignal,
): Promise<PhotoLibraryImport> {
  const body = await requestJson<{ import: PhotoLibraryImport }>(
    `${libraryPath(libraryId)}/imports`,
    { method: 'POST', body: JSON.stringify(request), signal },
  );
  return body.import;
}

export async function uploadPhotoLibraryImport(
  libraryId: string,
  importId: string,
  content: Blob,
  signal?: AbortSignal,
): Promise<PhotoLibraryImport> {
  const response = await apiFetch(importPath(libraryId, importId) + '/content', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: content,
    signal,
  });
  if (!response.ok) await throwResponseError(response);
  const body = await response.json() as { import: PhotoLibraryImport };
  return body.import;
}

export async function commitPhotoLibraryImport(
  libraryId: string,
  importId: string,
  signal?: AbortSignal,
): Promise<PhotoLibraryImportCommit> {
  return requestJson<PhotoLibraryImportCommit>(importPath(libraryId, importId) + '/commit', {
    method: 'POST',
    signal,
  });
}

export async function cancelPhotoLibraryImport(
  libraryId: string,
  importId: string,
): Promise<void> {
  const response = await apiFetch(importPath(libraryId, importId), { method: 'DELETE' });
  if (!response.ok) await throwResponseError(response);
}

export async function importFileIntoPhotoLibrary(
  libraryId: string,
  file: File,
  signal?: AbortSignal,
): Promise<PhotoLibraryImportCommit> {
  const record = await createPhotoLibraryImport(libraryId, {
    fileName: file.name,
    sizeBytes: file.size,
    dateModified: file.lastModified,
  }, signal);
  try {
    await uploadPhotoLibraryImport(libraryId, record.id, file, signal);
    return await commitPhotoLibraryImport(libraryId, record.id, signal);
  } catch (error) {
    await cancelPhotoLibraryImport(libraryId, record.id).catch(() => undefined);
    throw error;
  }
}

export async function startPhotoLibraryScan(libraryId: string): Promise<PhotoLibraryScan> {
  const body = await requestJson<{ scan: PhotoLibraryScan }>(`${libraryPath(libraryId)}/scans`, {
    method: 'POST',
  });
  return body.scan;
}

export async function getPhotoLibraryScan(
  libraryId: string,
  scanId: string,
): Promise<PhotoLibraryScan> {
  const body = await requestJson<{ scan: PhotoLibraryScan }>(
    `${libraryPath(libraryId)}/scans/${encodeURIComponent(scanId)}`,
  );
  return body.scan;
}

export function getPhotoLibraryStats(libraryId: string): Promise<PhotoLibraryStats> {
  return requestJson<PhotoLibraryStats>(`${libraryPath(libraryId)}/stats`);
}

export async function runPhotoLibraryIntegrityCheck(
  libraryId: string,
): Promise<PhotoLibraryIntegrityReport> {
  const body = await requestJson<{ report: PhotoLibraryIntegrityReport }>(
    `${libraryPath(libraryId)}/integrity-check`,
    { method: 'POST' },
  );
  return body.report;
}

export async function cancelPhotoLibraryScan(
  libraryId: string,
  scanId: string,
): Promise<PhotoLibraryScan> {
  const body = await requestJson<{ scan: PhotoLibraryScan }>(
    `${libraryPath(libraryId)}/scans/${encodeURIComponent(scanId)}/cancel`,
    { method: 'POST' },
  );
  return body.scan;
}

export async function waitForPhotoLibraryScan(
  libraryId: string,
  scanId: string,
  onProgress?: (scan: PhotoLibraryScan) => void,
): Promise<PhotoLibraryScan> {
  for (;;) {
    const scan = await getPhotoLibraryScan(libraryId, scanId);
    onProgress?.(scan);
    if (scan.status === 'completed') return scan;
    if (scan.status === 'failed' || scan.status === 'cancelled' || scan.status === 'interrupted') {
      throw new LibraryApiError(
        scan.errorSummary || `Library scan ended with status ${scan.status}`,
        409,
        `SCAN_${scan.status.toUpperCase()}`,
      );
    }
    await delay(250);
  }
}

export async function scanPhotoLibrary(
  libraryId: string,
  onProgress?: (scan: PhotoLibraryScan) => void,
): Promise<PhotoLibraryScan> {
  try {
    const scan = await startPhotoLibraryScan(libraryId);
    onProgress?.(scan);
    return await waitForPhotoLibraryScan(libraryId, scan.id, onProgress);
  } catch (error) {
    if (error instanceof LibraryApiError && error.code === 'SCAN_ALREADY_RUNNING') {
      throw error;
    }
    throw error;
  }
}

export async function listPhotoLibraryAssets(
  libraryId: string,
  options: { cursor?: string | null; limit?: number; status?: LibraryAssetStatus; signal?: AbortSignal } = {},
): Promise<PhotoLibraryAssetPage> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  query.set('limit', String(options.limit ?? 500));
  if (options.status) query.set('status', options.status);
  return requestJson<PhotoLibraryAssetPage>(`${libraryPath(libraryId)}/assets?${query}`, {
    signal: options.signal,
  });
}

export async function listPhotoLibraryAssetChanges(
  libraryId: string,
  afterRevision: number,
  limit = 500,
  signal?: AbortSignal,
): Promise<PhotoLibraryAssetChanges> {
  const query = new URLSearchParams({
    afterRevision: String(afterRevision),
    limit: String(limit),
  });
  return requestJson<PhotoLibraryAssetChanges>(`${libraryPath(libraryId)}/assets/changes?${query}`, { signal });
}

export async function getPhotoLibraryAsset(
  libraryId: string,
  assetId: string,
): Promise<PhotoLibraryAsset> {
  const body = await requestJson<{ asset: PhotoLibraryAsset }>(assetPath(libraryId, assetId));
  return body.asset;
}

export async function trashPhotoLibraryAsset(
  libraryId: string,
  assetId: string,
): Promise<PhotoLibraryAsset> {
  const body = await requestJson<{ asset: PhotoLibraryAsset }>(
    `${assetPath(libraryId, assetId)}/trash`,
    { method: 'POST' },
  );
  return body.asset;
}

export async function restorePhotoLibraryAsset(
  libraryId: string,
  assetId: string,
): Promise<PhotoLibraryAsset> {
  const body = await requestJson<{ asset: PhotoLibraryAsset }>(
    `${assetPath(libraryId, assetId)}/restore`,
    { method: 'POST' },
  );
  return body.asset;
}

export async function purgePhotoLibraryAsset(
  libraryId: string,
  assetId: string,
): Promise<void> {
  const response = await apiFetch(`${assetPath(libraryId, assetId)}/trash`, { method: 'DELETE' });
  if (!response.ok) await throwResponseError(response);
}

export async function fetchPhotoLibraryAssetOriginal(
  libraryId: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await apiFetch(`${assetPath(libraryId, assetId)}/original`, { signal });
  if (!response.ok) await throwResponseError(response);
  return response;
}

export async function fetchPhotoLibraryAssetThumbnail(
  libraryId: string,
  assetId: string,
  size: 'small' | 'large' = 'small',
  signal?: AbortSignal,
): Promise<Response> {
  const response = await apiFetch(`${assetPath(libraryId, assetId)}/thumbnail?size=${size}`, { signal });
  if (!response.ok) await throwResponseError(response);
  return response;
}

function libraryPath(libraryId: string): string {
  return `/api/libraries/${encodeURIComponent(libraryId)}`;
}

function assetPath(libraryId: string, assetId: string): string {
  return `${libraryPath(libraryId)}/assets/${encodeURIComponent(assetId)}`;
}

function importPath(libraryId: string, importId: string): string {
  return `${libraryPath(libraryId)}/imports/${encodeURIComponent(importId)}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) await throwResponseError(response);
  return response.json() as Promise<T>;
}

async function throwResponseError(response: Response): Promise<never> {
  let message = `Library request failed (${response.status})`;
  let code: string | null = null;
  try {
    const body = await response.json() as { error?: unknown; code?: unknown };
    if (typeof body.error === 'string' && body.error) message = body.error;
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // Preserve the status-based fallback for non-JSON responses.
  }
  throw new LibraryApiError(message, response.status, code);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
