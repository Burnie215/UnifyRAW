import path from 'node:path';

/**
 * True when `candidate` is `root` or lies below it. The only implementation:
 * two copies with mirrored argument order used to coexist, and importing the
 * wrong one inverted the containment check without a type error.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}
