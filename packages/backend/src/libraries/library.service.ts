import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AvailableLibraryRoot,
  CreatePhotoLibraryRequest,
  LibraryMode,
  LibraryRootSelection,
  PhotoLibrary,
  PhotoLibraryCapabilities,
  UpdatePhotoLibraryRequest,
} from '@photolib/shared';
import { LibraryRequestError } from './library.errors.js';
import {
  createManagedLibraryRoot,
  listAvailableLibraryRoots,
  locateConfiguredRoot,
  resolveExternalRootSelections,
  type LibraryStorageConfig,
  type LocatedLibraryRoot,
  type ResolvedLibraryRoot,
} from './library.paths.js';
import {
  LibraryRepository,
  type StoredPhotoLibrary,
} from './library.repository.js';

export class LibraryService {
  constructor(
    private readonly repository: LibraryRepository,
    private readonly storageConfig: LibraryStorageConfig,
  ) {}

  availableRoots(): Promise<AvailableLibraryRoot[]> {
    return listAvailableLibraryRoots(this.storageConfig);
  }

  list(ownerId: string): PhotoLibrary[] {
    return this.repository.list(ownerId).map(toPhotoLibrary);
  }

  get(ownerId: string, libraryId: string): PhotoLibrary {
    const library = this.repository.get(ownerId, libraryId);
    if (!library) throw notFound();
    return toPhotoLibrary(library);
  }

  /** Which configured root an absolute server path belongs to, for Phase-8 migration. */
  locateRoot(candidate: unknown): Promise<LocatedLibraryRoot> {
    return locateConfiguredRoot(candidate, this.storageConfig);
  }

  async validateRoot(selection: unknown): Promise<{ label: string; writable: boolean }> {
    const parsed = parseRootSelection(selection);
    const [root] = await resolveExternalRootSelections([parsed], this.storageConfig);
    return { label: root.label, writable: root.writable };
  }

  async create(ownerId: string, body: unknown): Promise<PhotoLibrary> {
    const request = parseCreateRequest(body);
    const id = randomUUID();
    let roots: ResolvedLibraryRoot[];

    if (request.mode === 'external') {
      roots = await resolveExternalRootSelections(request.roots ?? [], this.storageConfig);
    } else {
      roots = [await createManagedLibraryRoot(id, request.name, this.storageConfig)];
    }

    const now = Date.now();
    try {
      const stored = this.repository.create(
        {
          id,
          ownerId,
          name: request.name,
          mode: request.mode,
          readOnly: request.mode === 'external',
          exclusionPatterns: request.exclusionPatterns ?? [],
          includeHidden: request.includeHidden ?? false,
          createdAt: now,
          updatedAt: now,
        },
        roots.map((root) => ({
          id: randomUUID(),
          path: root.path,
          canonicalPath: root.canonicalPath,
          label: root.label,
          writable: request.mode === 'managed' && root.writable,
        })),
      );
      return toPhotoLibrary(stored);
    } catch (error) {
      if (request.mode === 'managed') {
        await removeEmptyManagedRoot(roots[0].canonicalPath);
      }
      if (String(error).includes('UNIQUE constraint failed')) {
        throw new LibraryRequestError(
          'ROOT_ALREADY_REGISTERED',
          409,
          'A selected root is already registered',
          { cause: error },
        );
      }
      throw error;
    }
  }

  update(ownerId: string, libraryId: string, body: unknown): PhotoLibrary {
    const existing = this.repository.get(ownerId, libraryId);
    if (!existing) throw notFound();
    const request = parseUpdateRequest(body);
    const updated = this.repository.update(ownerId, libraryId, {
      name: request.name ?? existing.name,
      exclusionPatterns: request.exclusionPatterns ?? existing.exclusionPatterns,
      includeHidden: request.includeHidden ?? existing.includeHidden,
      scanIntervalMinutes: request.scanIntervalMinutes ?? existing.scanIntervalMinutes,
      updatedAt: Date.now(),
    });
    if (!updated) throw notFound();
    return toPhotoLibrary(updated);
  }

  delete(ownerId: string, libraryId: string, preserveManagedOriginals = false): void {
    const library = this.repository.get(ownerId, libraryId);
    if (!library) throw notFound();
    if (this.repository.hasActiveOperations(ownerId, libraryId)) {
      throw new LibraryRequestError(
        'LIBRARY_BUSY',
        409,
        'The library cannot be removed while a scan or import is active',
      );
    }
    if (library.mode === 'managed' && !preserveManagedOriginals) {
      throw new LibraryRequestError(
        'MANAGED_LIBRARY_DELETE_REQUIRES_CONFIRMATION',
        409,
        'Confirm that managed originals must be preserved before removing the library registry',
      );
    }
    if (!this.repository.delete(ownerId, libraryId)) throw notFound();
    // Deliberately do not remove filesystem content here. This is critical for
    // external roots and remains the safe default for managed roots too.
  }
}

function toPhotoLibrary(library: StoredPhotoLibrary): PhotoLibrary {
  return {
    id: library.id,
    name: library.name,
    mode: library.mode,
    readOnly: library.readOnly,
    exclusionPatterns: library.exclusionPatterns,
    includeHidden: library.includeHidden,
    watchEnabled: library.watchEnabled,
    scanIntervalMinutes: library.scanIntervalMinutes,
    revision: library.revision,
    status: library.status,
    lastScanAt: library.lastScanAt,
    lastError: library.lastError,
    createdAt: library.createdAt,
    updatedAt: library.updatedAt,
    roots: library.roots.map((root) => ({
      id: root.id,
      label: root.label,
      writable: root.writable,
    })),
    capabilities: capabilitiesFor(library),
  };
}

function capabilitiesFor(library: StoredPhotoLibrary): PhotoLibraryCapabilities {
  return {
    canScan: true,
    canWatch: false,
    canImport: library.mode === 'managed' && !library.readOnly,
    canWriteSidecars: false,
    canTrash: library.mode === 'managed' && !library.readOnly,
  };
}

function parseCreateRequest(value: unknown): CreatePhotoLibraryRequest {
  const body = objectValue(value);
  const name = parseName(body.name);
  const mode = parseMode(body.mode);
  const roots = body.roots === undefined ? undefined : parseRootSelections(body.roots);
  if (mode === 'external' && (!roots || roots.length === 0)) {
    throw new LibraryRequestError(
      'ROOT_REQUIRED',
      400,
      'An external library requires at least one root',
    );
  }
  if (mode === 'managed' && roots && roots.length > 0) {
    throw new LibraryRequestError(
      'MANAGED_ROOT_IS_SERVER_CONTROLLED',
      400,
      'Managed library roots are controlled by the server',
    );
  }

  return {
    name,
    mode,
    roots,
    exclusionPatterns: parsePatterns(body.exclusionPatterns),
    includeHidden: parseOptionalBoolean(body.includeHidden, 'includeHidden'),
  };
}

function parseUpdateRequest(value: unknown): UpdatePhotoLibraryRequest {
  const body = objectValue(value);
  const request: UpdatePhotoLibraryRequest = {};
  if (body.name !== undefined) request.name = parseName(body.name);
  if (body.exclusionPatterns !== undefined) {
    request.exclusionPatterns = parsePatterns(body.exclusionPatterns) ?? [];
  }
  if (body.includeHidden !== undefined) {
    request.includeHidden = parseOptionalBoolean(body.includeHidden, 'includeHidden');
  }
  if (body.scanIntervalMinutes !== undefined) {
    const interval = body.scanIntervalMinutes;
    if (!Number.isSafeInteger(interval) || (interval as number) < 0 || (interval as number) > 10_080) {
      throw new LibraryRequestError(
        'INVALID_SCAN_INTERVAL',
        400,
        'scanIntervalMinutes must be an integer between 0 and 10080',
      );
    }
    request.scanIntervalMinutes = interval as number;
  }
  if (Object.keys(request).length === 0) {
    throw new LibraryRequestError('EMPTY_UPDATE', 400, 'No supported update fields provided');
  }
  return request;
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new LibraryRequestError('INVALID_NAME', 400, 'Library name is required');
  }
  const name = value.trim();
  if (name.length === 0 || name.length > 128 || hasControlCharacter(name)) {
    throw new LibraryRequestError('INVALID_NAME', 400, 'Invalid library name');
  }
  return name;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) < 32) return true;
  }
  return false;
}

function parseMode(value: unknown): LibraryMode {
  if (value !== 'external' && value !== 'managed') {
    throw new LibraryRequestError('INVALID_MODE', 400, 'Invalid library mode');
  }
  return value;
}

function parseRootSelections(value: unknown): LibraryRootSelection[] {
  if (!Array.isArray(value)) {
    throw new LibraryRequestError('INVALID_ROOTS', 400, 'roots must be an array');
  }
  return value.map(parseRootSelection);
}

function parseRootSelection(value: unknown): LibraryRootSelection {
  const selection = objectValue(value);
  if (typeof selection.rootId !== 'string' || !/^[a-f0-9]{24}$/.test(selection.rootId)) {
    throw new LibraryRequestError('INVALID_ROOT', 400, 'Invalid root selection');
  }
  if (selection.relativePath !== undefined && typeof selection.relativePath !== 'string') {
    throw new LibraryRequestError('INVALID_ROOT', 400, 'Invalid root selection');
  }
  return {
    rootId: selection.rootId,
    relativePath: selection.relativePath as string | undefined,
  };
}

function parsePatterns(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) {
    throw new LibraryRequestError(
      'INVALID_EXCLUSION_PATTERNS',
      400,
      'exclusionPatterns must be an array of at most 100 strings',
    );
  }
  const result = value.map((pattern) => {
    if (typeof pattern !== 'string') {
      throw new LibraryRequestError(
        'INVALID_EXCLUSION_PATTERNS',
        400,
        'Invalid exclusion pattern',
      );
    }
    const trimmed = pattern.trim();
    if (
      trimmed.length === 0
      || trimmed.length > 512
      || trimmed.includes('\0')
      || path.isAbsolute(trimmed)
    ) {
      throw new LibraryRequestError(
        'INVALID_EXCLUSION_PATTERNS',
        400,
        'Invalid exclusion pattern',
      );
    }
    return trimmed;
  });
  return [...new Set(result)];
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new LibraryRequestError('INVALID_REQUEST', 400, `${field} must be a boolean`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LibraryRequestError('INVALID_REQUEST', 400, 'Request body must be an object');
  }
  return value as Record<string, unknown>;
}

function notFound(): LibraryRequestError {
  return new LibraryRequestError('LIBRARY_NOT_FOUND', 404, 'Library not found');
}

async function removeEmptyManagedRoot(rootPath: string): Promise<void> {
  try {
    await fs.rmdir(rootPath);
  } catch {
    // The directory is retained if it is no longer empty or cannot be removed.
  }
}
