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

/**
 * Well-known folders Chrome refuses to hand out themselves - only folders
 * inside them (chrome_file_system_access_permission_context.cc, kDontBlockChildren
 * for DIR_HOME, DIR_USER_DESKTOP, DIR_USER_DOCUMENTS, DIR_DEFAULT_DOWNLOADS).
 */
export const CHROME_BLOCKED_PICKER_ROOTS = ['desktop', 'documents', 'downloads'] as const;

/**
 * No `startIn`: it used to be 'documents', so the dialog opened in a folder
 * Chrome will not accept. Confirming the suggested location ended in Chrome's
 * "contains system files" and a second pick, and the app never heard of it.
 * The `id` still lets Chrome reopen the folder picked last time.
 */
export const CATALOG_PICKER_OPTIONS = { id: 'photolib-catalog', mode: 'readwrite' } as const;

/** Prompt the user to pick a folder; returns the handle or null if cancelled. */
export async function pickCatalogFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API not supported in this browser');
  }
  try {
    // `id` is part of the live spec but missing from the TS lib; cast through
    // unknown to opt in. Cancel = AbortError → null.
    return await window.showDirectoryPicker(CATALOG_PICKER_OPTIONS as unknown as { mode?: 'read' | 'readwrite' });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null;
    throw e;
  }
}
