/** True if `showDirectoryPicker` is available (Chrome/Edge + recent Brave/Opera). */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** True if OPFS is available. Chrome/Edge/Safari/Firefox (modern). */
export function isOPFSSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'storage' in navigator
    && typeof navigator.storage.getDirectory === 'function';
}

/** Prompt the user to pick a folder; returns the handle or null if cancelled. */
export async function pickCatalogFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API not supported in this browser');
  }
  try {
    // `id` + `startIn` are part of the live spec but missing from the TS lib;
    // cast through unknown to opt in. Cancel = AbortError → null.
    const opts = { id: 'photolib-catalog', mode: 'readwrite', startIn: 'documents' };
    return await window.showDirectoryPicker(opts as unknown as { mode?: 'read' | 'readwrite' });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null;
    throw e;
  }
}
