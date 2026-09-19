/**
 * File System Access API helpers.
 * Chrome/Edge/Opera support showDirectoryPicker; Safari and Firefox do not.
 */

interface NativeFSWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}

export async function pickDirectory(mode: 'read' | 'readwrite' = 'readwrite'): Promise<FileSystemDirectoryHandle | null> {
  const w = window as unknown as NativeFSWindow;
  if (typeof w.showDirectoryPicker !== 'function') return null;
  try {
    return await w.showDirectoryPicker({ mode });
  } catch {
    // User cancelled or permission denied.
    return null;
  }
}

interface PermissionHandle {
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

export async function queryPermission(
  handle: FileSystemDirectoryHandle | FileSystemFileHandle,
  mode: 'read' | 'readwrite' = 'read',
): Promise<PermissionState | 'unsupported'> {
  const h = handle as PermissionHandle;
  if (typeof h.queryPermission !== 'function') return 'unsupported';
  try {
    return await h.queryPermission({ mode });
  } catch {
    return 'denied';
  }
}

export async function requestPermission(
  handle: FileSystemDirectoryHandle | FileSystemFileHandle,
  mode: 'read' | 'readwrite' = 'readwrite',
): Promise<PermissionState | 'unsupported'> {
  const h = handle as PermissionHandle;
  if (typeof h.requestPermission !== 'function') return 'unsupported';
  try {
    return await h.requestPermission({ mode });
  } catch {
    return 'denied';
  }
}
