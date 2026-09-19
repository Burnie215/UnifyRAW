/**
 * OPFS cache management for RAW decode artifacts.
 *
 * Two stores are covered:
 *   - `smart-previews/<key>_<size>_<version>.<tiff|jpg>` — decoded previews
 *     (packages/shared/src/smart-preview.ts owns the name)
 *   - `pixels/` — 16-bit raw pixel buffers (RawPixelsOpfsCache, up to 2 GB)
 *
 * The "Cache leeren" button in Settings clears BOTH; the stats include
 * both, so the reported size matches what clearing actually frees.
 */

import { getDefaultRawPixelsCache } from './RawPixelsOpfsCache';

export async function getCacheStats(): Promise<{ files: number; bytes: number }> {
  const previews = await statDir(() => getCacheDir());
  const pixels = await statDir(() => getPixelsDir());
  return { files: previews.files + pixels.files, bytes: previews.bytes + pixels.bytes };
}

async function statDir(
  open: () => Promise<FileSystemDirectoryHandle>,
): Promise<{ files: number; bytes: number }> {
  try {
    const dir = await open();
    let files = 0;
    let bytes = 0;
    // OPFS doesn't expose direct enumeration in all engines; use the async
    // iterator (Chrome/Firefox/Safari 17+).
    for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      if (handle.kind !== 'file') continue;
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        files++;
        bytes += file.size;
      } catch { /* skip */ }
      void name;
    }
    return { files, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

export async function clearAllSmartPreviews(): Promise<{ removed: number; bytes: number }> {
  const previews = await clearDir(() => getCacheDir());
  const pixels = await clearDir(() => getPixelsDir());
  getDefaultRawPixelsCache().forgetIndex();
  return { removed: previews.removed + pixels.removed, bytes: previews.bytes + pixels.bytes };
}

async function clearDir(
  open: () => Promise<FileSystemDirectoryHandle>,
): Promise<{ removed: number; bytes: number }> {
  let removed = 0;
  let bytes = 0;
  try {
    const dir = await open();
    const names: string[] = [];
    for await (const [name] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      names.push(name);
    }
    for (const name of names) {
      try {
        const handle = await dir.getFileHandle(name);
        const file = await handle.getFile();
        bytes += file.size;
        await dir.removeEntry(name);
        removed++;
      } catch { /* skip */ }
    }
  } catch { /* dir missing — nothing to clear */ }
  return { removed, bytes };
}

async function getCacheDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('smart-previews', { create: true });
}

/** RawPixelsOpfsCache store — kept in lockstep with its `rootDir` default. */
async function getPixelsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('pixels', { create: false });
}
