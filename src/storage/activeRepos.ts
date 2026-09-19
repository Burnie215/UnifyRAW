/**
 * Singleton accessor for the currently-active Repositories instance.
 *
 * React components should always use `useRepos()` from
 * src/contexts/StorageContext.tsx. This module exists for **non-React**
 * call sites (cache modules, background workers, dynamic imports inside
 * the engine layer, the SourceManager singleton) that don't have a hook
 * context. StorageContext.tsx wires `setActiveRepos(repos)` whenever the
 * active storage changes, including back to `null` on close.
 */

import type { Repositories } from './repos';

let active: Repositories | null = null;

export function setActiveRepos(repos: Repositories | null): void {
  active = repos;
}

export function getActiveRepos(): Repositories | null {
  return active;
}

export function requireActiveRepos(): Repositories {
  if (!active) throw new Error('storage repositories not initialized yet');
  return active;
}
