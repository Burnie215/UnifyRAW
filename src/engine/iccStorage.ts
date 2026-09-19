/**
 * ICC profile management — upload, list, parse metadata, delete.
 *
 * Phase 3.5 scope: storage + metadata display only. Actual color conversion
 * (linear-sRGB → ICC space via parsed matrix or 3D-LUT) is deferred to a
 * follow-up phase. Profiles selected here surface as an additional output
 * color space option but the pipeline still applies the standard matrix
 * fallback.
 */

// `icc` is a small Node-oriented parser; we feed it a Uint8Array which works
// at runtime but the types only declare `Buffer`. Cast at the call site.
import { parse as iccParse } from 'icc';

export interface IccProfileInfo {
  id: string;          // sanitized filename, used as OPFS key
  fileName: string;    // display name (preserved from upload)
  byteSize: number;
  description?: string;
  version?: string;
  deviceClass?: string;
  colorSpace?: string;
  connectionSpace?: string;
}

const MAX_PROFILES = 5;
const ICC_DIR = 'icc-profiles';

function sanitize(name: string): string {
  return name
    .replace(/\.[iI][cC][cCmM]$/, '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 100);
}

async function getDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(ICC_DIR, { create: true });
}

export async function listIccProfiles(): Promise<IccProfileInfo[]> {
  const result: IccProfileInfo[] = [];
  try {
    const dir = await getDir();
    for await (const [name, handle] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
      if (handle.kind !== 'file') continue;
      try {
        const fh = await (handle as FileSystemFileHandle).getFile();
        const buf = await fh.arrayBuffer();
        const info = parseIccMeta(buf, name, fh.size);
        result.push(info);
      } catch { /* skip unreadable */ }
    }
  } catch { /* dir missing */ }
  return result.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export async function addIccProfile(file: File): Promise<IccProfileInfo> {
  const buf = await file.arrayBuffer();
  // Validate that it actually parses before we store it
  const info = parseIccMeta(buf, file.name, file.size);
  // Enforce max-count
  const existing = await listIccProfiles();
  if (existing.length >= MAX_PROFILES && !existing.some((p) => p.id === info.id)) {
    throw new Error(`Maximal ${MAX_PROFILES} ICC-Profile pro User. Lösche zuerst eines.`);
  }
  const dir = await getDir();
  const fh = await dir.getFileHandle(info.id, { create: true });
  const w = await fh.createWritable();
  await w.write(buf);
  await w.close();
  return info;
}

export async function deleteIccProfile(id: string): Promise<void> {
  try {
    const dir = await getDir();
    await dir.removeEntry(id);
  } catch { /* */ }
}

export async function readIccProfile(id: string): Promise<ArrayBuffer | null> {
  try {
    const dir = await getDir();
    const fh = await dir.getFileHandle(id);
    const file = await fh.getFile();
    return file.arrayBuffer();
  } catch {
    return null;
  }
}

function parseIccMeta(buf: ArrayBuffer, originalName: string, byteSize: number): IccProfileInfo {
  const id = sanitize(originalName);
  let parsed: {
    description?: string;
    version?: string;
    deviceClass?: string;
    colorSpace?: string;
    connectionSpace?: string;
  } = {};
  try {
    // icc package wants Buffer in node but accepts Uint8Array
    parsed = iccParse(new Uint8Array(buf) as unknown as Buffer) as typeof parsed;
  } catch (e) {
    throw new Error(`Datei ist kein gültiges ICC-Profil: ${e instanceof Error ? e.message : 'parse error'}`);
  }
  return {
    id,
    fileName: originalName,
    byteSize,
    description: parsed.description,
    version: parsed.version,
    deviceClass: parsed.deviceClass,
    colorSpace: parsed.colorSpace,
    connectionSpace: parsed.connectionSpace,
  };
}
