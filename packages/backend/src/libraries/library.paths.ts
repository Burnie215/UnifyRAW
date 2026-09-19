import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AvailableLibraryRoot,
  LibraryRootSelection,
} from '@photolib/shared';
import { LibraryRequestError } from './library.errors.js';
import { isPathInside } from '../security/path-containment.js';

export { isPathInside };

export interface LibraryStorageConfig {
  allowedRoots: readonly string[];
  managedRoot?: string;
  thumbnailRoot?: string;
  databasePath?: string;
  maxImportBytes?: number;
}

export interface ResolvedLibraryRoot {
  path: string;
  canonicalPath: string;
  label: string;
  writable: boolean;
}

interface ConfiguredRoot {
  id: string;
  configuredPath: string;
  label: string;
}

export function getConfiguredRootId(configuredPath: string): string {
  return createHash('sha256')
    .update(path.resolve(configuredPath))
    .digest('hex')
    .slice(0, 24);
}

export async function listAvailableLibraryRoots(
  config: LibraryStorageConfig,
): Promise<AvailableLibraryRoot[]> {
  const roots = uniqueConfiguredRoots(config.allowedRoots);

  return Promise.all(roots.map(async (root) => {
    try {
      const canonicalPath = await fs.realpath(root.configuredPath);
      const stat = await fs.stat(canonicalPath);
      if (!stat.isDirectory()) {
        return { id: root.id, label: root.label, available: false, writable: false };
      }
      return {
        id: root.id,
        label: root.label,
        available: true,
        writable: await canWrite(canonicalPath),
      };
    } catch {
      return { id: root.id, label: root.label, available: false, writable: false };
    }
  }));
}

/** The answer of `POST /api/libraries/locate-root`. */
export interface LocatedLibraryRoot {
  root: AvailableLibraryRoot;
  /** Where the asked-for directory sits inside that root; '' means the root. */
  relativePath: string;
}

/**
 * Which configured root an absolute server path lies in.
 *
 * The migration assistant needs this and nothing else: a legacy
 * `server-path` source carries an absolute host path the client already
 * knows, and turning it into a library means naming the opaque root id plus
 * the relative path below it. The answer reveals no path the caller did not
 * send, so root opacity holds - the deepest configured root wins, which is
 * the narrowest library the same files can be indexed under.
 */
export async function locateConfiguredRoot(
  candidate: unknown,
  config: LibraryStorageConfig,
): Promise<LocatedLibraryRoot> {
  if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || candidate.length > 4096) {
    throw new LibraryRequestError('INVALID_PATH', 400, 'A path is required');
  }
  if (!path.isAbsolute(candidate)) {
    throw new LibraryRequestError('INVALID_PATH', 400, 'The path must be absolute');
  }

  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(candidate);
    if (!(await fs.stat(canonicalPath)).isDirectory()) {
      throw new LibraryRequestError('ROOT_NOT_DIRECTORY', 400, 'The path is not a directory');
    }
  } catch (error) {
    if (error instanceof LibraryRequestError) throw error;
    throw new LibraryRequestError('ROOT_UNAVAILABLE', 409, 'The path is not accessible', { cause: error });
  }

  let best: { root: ConfiguredRoot; canonicalRoot: string } | null = null;
  for (const root of uniqueConfiguredRoots(config.allowedRoots)) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await fs.realpath(root.configuredPath);
    } catch {
      continue;
    }
    if (canonicalRoot !== canonicalPath && !isPathInside(canonicalRoot, canonicalPath)) continue;
    if (!best || canonicalRoot.length > best.canonicalRoot.length) best = { root, canonicalRoot };
  }
  if (!best) {
    throw new LibraryRequestError('ROOT_NOT_ALLOWED', 403, 'The path is not inside a configured library root');
  }

  const protectedPaths = await resolveProtectedPaths(config);
  if (protectedPaths.some((protectedPath) => pathsOverlap(canonicalPath, protectedPath))) {
    throw new LibraryRequestError(
      'ROOT_OVERLAPS_PHOTOLIB_DATA',
      409,
      'The path overlaps PhotoLib application data',
    );
  }

  return {
    root: {
      id: best.root.id,
      label: best.root.label,
      available: true,
      writable: await canWrite(best.canonicalRoot),
    },
    relativePath: toPosix(path.relative(best.canonicalRoot, canonicalPath)),
  };
}

export async function resolveExternalRootSelections(
  selections: readonly LibraryRootSelection[],
  config: LibraryStorageConfig,
): Promise<ResolvedLibraryRoot[]> {
  if (selections.length === 0) {
    throw new LibraryRequestError(
      'ROOT_REQUIRED',
      400,
      'An external library requires at least one root',
    );
  }
  if (selections.length > 16) {
    throw new LibraryRequestError('TOO_MANY_ROOTS', 400, 'Too many library roots');
  }

  const configured = new Map(
    uniqueConfiguredRoots(config.allowedRoots).map((root) => [root.id, root]),
  );
  const protectedPaths = await resolveProtectedPaths(config);
  const resolved: ResolvedLibraryRoot[] = [];
  const seen = new Set<string>();

  for (const selection of selections) {
    const root = configured.get(selection.rootId);
    if (!root) {
      throw new LibraryRequestError('ROOT_NOT_ALLOWED', 403, 'Selected root is not allowed');
    }

    const relativePath = validateRelativePath(selection.relativePath);

    try {
      const configuredCanonical = await fs.realpath(root.configuredPath);
      const configuredStat = await fs.stat(configuredCanonical);
      if (!configuredStat.isDirectory()) throw new Error('Configured root is not a directory');

      const lexicalTarget = path.resolve(root.configuredPath, relativePath);
      if (!isPathInside(configuredCanonical, await resolveExistingPath(lexicalTarget))) {
        throw new LibraryRequestError('ROOT_NOT_ALLOWED', 403, 'Selected root is not allowed');
      }

      const canonicalPath = await fs.realpath(lexicalTarget);
      const stat = await fs.stat(canonicalPath);
      if (!stat.isDirectory()) {
        throw new LibraryRequestError('ROOT_NOT_DIRECTORY', 400, 'Selected root is not a directory');
      }
      if (!isPathInside(configuredCanonical, canonicalPath)) {
        throw new LibraryRequestError('ROOT_NOT_ALLOWED', 403, 'Selected root is not allowed');
      }
      if (protectedPaths.some((protectedPath) => pathsOverlap(canonicalPath, protectedPath))) {
        throw new LibraryRequestError(
          'ROOT_OVERLAPS_PHOTOLIB_DATA',
          409,
          'Selected root overlaps PhotoLib application data',
        );
      }
      if (seen.has(canonicalPath)) {
        throw new LibraryRequestError('DUPLICATE_ROOT', 409, 'Library roots must be unique');
      }

      seen.add(canonicalPath);
      resolved.push({
        path: canonicalPath,
        canonicalPath,
        label: relativePath ? `${root.label}/${toPosix(relativePath)}` : root.label,
        // External libraries are deliberately read-only for the first release.
        writable: false,
      });
    } catch (error) {
      if (error instanceof LibraryRequestError) throw error;
      throw new LibraryRequestError(
        'ROOT_UNAVAILABLE',
        409,
        'Selected root is not accessible',
        { cause: error },
      );
    }
  }

  return resolved;
}

export async function createManagedLibraryRoot(
  libraryId: string,
  label: string,
  config: LibraryStorageConfig,
): Promise<ResolvedLibraryRoot> {
  if (!config.managedRoot) {
    throw new LibraryRequestError(
      'MANAGED_STORAGE_DISABLED',
      503,
      'Managed library storage is not configured',
    );
  }

  try {
    const basePath = path.resolve(config.managedRoot);
    await fs.mkdir(basePath, { recursive: true, mode: 0o750 });
    const baseCanonical = await fs.realpath(basePath);
    if (!await canWrite(baseCanonical)) throw new Error('Managed root is not writable');

    const libraryPath = path.join(baseCanonical, libraryId);
    if (!isPathInside(baseCanonical, libraryPath) || libraryPath === baseCanonical) {
      throw new Error('Invalid managed library path');
    }
    await fs.mkdir(libraryPath, { mode: 0o750 });
    const canonicalPath = await fs.realpath(libraryPath);
    if (!isPathInside(baseCanonical, canonicalPath)) {
      throw new Error('Managed library escaped configured root');
    }

    return {
      path: canonicalPath,
      canonicalPath,
      label,
      writable: true,
    };
  } catch (error) {
    if (error instanceof LibraryRequestError) throw error;
    throw new LibraryRequestError(
      'MANAGED_STORAGE_UNAVAILABLE',
      503,
      'Managed library storage is not accessible',
      { cause: error },
    );
  }
}

function pathsOverlap(first: string, second: string): boolean {
  return isPathInside(first, second) || isPathInside(second, first);
}

function uniqueConfiguredRoots(paths: readonly string[]): ConfiguredRoot[] {
  const roots = new Map<string, ConfiguredRoot>();
  for (const configuredPath of paths) {
    const trimmed = configuredPath.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    if (roots.has(resolved)) continue;
    roots.set(resolved, {
      id: getConfiguredRootId(resolved),
      configuredPath: resolved,
      label: path.basename(resolved) || 'root',
    });
  }
  return [...roots.values()];
}

function validateRelativePath(value: string | undefined): string {
  if (value === undefined || value === '' || value === '.') return '';
  if (typeof value !== 'string' || value.length > 1024 || value.includes('\0')) {
    throw new LibraryRequestError('INVALID_RELATIVE_PATH', 400, 'Invalid relative root path');
  }
  if (path.isAbsolute(value)) {
    throw new LibraryRequestError('INVALID_RELATIVE_PATH', 400, 'Root path must be relative');
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new LibraryRequestError('ROOT_NOT_ALLOWED', 403, 'Selected root is not allowed');
  }
  return normalized === '.' ? '' : normalized;
}

async function resolveExistingPath(candidate: string): Promise<string> {
  return fs.realpath(candidate);
}

async function resolveProtectedPaths(config: LibraryStorageConfig): Promise<string[]> {
  const paths = [config.managedRoot, config.thumbnailRoot, config.databasePath]
    .filter((value): value is string => Boolean(value))
    .map((value) => path.resolve(value));

  return Promise.all(paths.map(async (value) => {
    try {
      return await fs.realpath(value);
    } catch {
      return value;
    }
  }));
}

async function canWrite(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function toPosix(candidate: string): string {
  return candidate.split(path.sep).join('/');
}
