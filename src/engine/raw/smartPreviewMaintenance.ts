import { isCurrentSmartPreviewSlot, parseSmartPreviewFileName } from '@photolib/shared';
import { SMART_PREVIEW_MAX_BYTES, getDefaultRawPixelsCache } from './RawPixelsOpfsCache';
import { isStalePreviewVariant } from './previewSlots';

export const SMART_PREVIEW_DIR_NAME = 'smart-previews';
const EVICT_DELAY_MS = 2000;

interface SlotFile {
  name: string;
  size: number;
  lastModified: number;
}

function iterate(dir: FileSystemDirectoryHandle): AsyncIterable<[string, FileSystemHandle]> {
  return dir as unknown as AsyncIterable<[string, FileSystemHandle]>;
}

async function listFiles(dir: FileSystemDirectoryHandle): Promise<SlotFile[]> {
  const files: SlotFile[] = [];
  for await (const [name, handle] of iterate(dir)) {
    if (handle.kind !== 'file') continue;
    try {
      const file = await (handle as FileSystemFileHandle).getFile();
      files.push({ name, size: file.size, lastModified: file.lastModified });
    } catch { /* vanished meanwhile */ }
  }
  return files;
}

/** Deletes slots named with another version than the current one for their size (F038). */
export async function sweepStalePreviewVersions(dir: FileSystemDirectoryHandle): Promise<number> {
  const stale: string[] = [];
  for await (const [name] of iterate(dir)) {
    const slot = parseSmartPreviewFileName(name);
    if (slot && !isCurrentSmartPreviewSlot(slot)) stale.push(name);
  }
  let removed = 0;
  for (const name of stale) {
    try {
      await dir.removeEntry(name);
      removed++;
    } catch { /* another tab was faster */ }
  }
  return removed;
}

/**
 * Deletes the oldest-written slots until the store fits (F087). OPFS keeps no
 * access time; a TIFF that is opened twice moves to the pixel cache and leaves
 * this store, so what ages here is mostly prefetched and never opened.
 */
export async function evictSmartPreviews(dir: FileSystemDirectoryHandle, maxBytes: number): Promise<number> {
  const files = await listFiles(dir);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= maxBytes) return 0;
  files.sort((a, b) => a.lastModified - b.lastModified);
  let removed = 0;
  for (const f of files) {
    if (total <= maxBytes) break;
    try {
      await dir.removeEntry(f.name);
      total -= f.size;
      removed++;
    } catch { /* held open by a writer */ }
  }
  return removed;
}

let evictTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Armed by the first write, fires once 2 s later. Not reset by later writes:
 * a bulk prefetch writes more often than that and would otherwise never evict.
 */
export function scheduleSmartPreviewEviction(dir: FileSystemDirectoryHandle, maxBytes = SMART_PREVIEW_MAX_BYTES): void {
  if (evictTimer) return;
  evictTimer = setTimeout(() => {
    evictTimer = null;
    evictSmartPreviews(dir, maxBytes).catch((e: unknown) => {
      console.warn('[smart-previews] eviction failed:', e);
    });
  }, EVICT_DELAY_MS);
}

let maintenance: Promise<void> | null = null;

async function dropOlderVersions(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    const files = await sweepStalePreviewVersions(dir);
    const pixels = await getDefaultRawPixelsCache().evictWhere((_key, variant) => isStalePreviewVariant(variant));
    if (files + pixels > 0) {
      console.info(`[smart-previews] dropped ${files} slot files and ${pixels} pixel entries of older preview versions`);
    }
  } catch (e) {
    console.warn('[smart-previews] version sweep failed:', e);
  }
}

/** The store; its first open in a session sweeps older versions from both stores, best-effort. */
export async function openSmartPreviewDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(SMART_PREVIEW_DIR_NAME, { create: true });
  maintenance ??= dropOlderVersions(dir);
  return dir;
}
