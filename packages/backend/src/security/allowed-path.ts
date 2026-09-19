import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from './path-containment.js';

/**
 * Resolve an existing path and its configured roots through realpath before
 * checking containment. A lexical prefix check alone can escape through a
 * symlink located below an otherwise allowed directory.
 */
export async function resolveAllowedExistingPath(
  requestedPath: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  if (!path.isAbsolute(requestedPath) || allowedRoots.length === 0) return null;

  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(requestedPath);
  } catch {
    return null;
  }

  for (const configuredRoot of allowedRoots) {
    if (!path.isAbsolute(configuredRoot)) continue;
    try {
      const resolvedRoot = await fs.realpath(configuredRoot);
      if (isPathInside(resolvedRoot, resolvedPath)) return resolvedPath;
    } catch {
      // A missing or inaccessible configured root cannot authorize a path.
    }
  }
  return null;
}
