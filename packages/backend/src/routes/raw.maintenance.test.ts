import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A separate file from raw.test.ts: the spies must be in place before the
// module is imported, and raw.test.ts imports it once in its beforeAll.
let tmpRoot: string;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function freshRaw() {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'unifyraw-raw-maint-'));
  vi.stubEnv('SMART_PREVIEW_DIR', path.join(tmpRoot, 'smart-previews'));
  vi.resetModules();
  const readdir = vi.spyOn(fs, 'readdir');
  const mkdir = vi.spyOn(fs, 'mkdir');
  const raw = await import('./raw.js');
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { raw, readdir, mkdir };
}

describe('RAW housekeeping', () => {
  it('touches no directory when the module is only imported', async () => {
    const { readdir, mkdir } = await freshRaw();
    expect(readdir).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
  });

  it('sweeps orphaned decode files of the directory it is started on', async () => {
    const { raw } = await freshRaw();
    const decodeDir = path.join(tmpRoot, 'decode');
    await fs.mkdir(decodeDir);
    await fs.writeFile(path.join(decodeDir, 'photolib-raw-orphan.raf'), 'x');
    await fs.writeFile(path.join(decodeDir, 'unrelated.txt'), 'x');

    const stop = raw.startRawMaintenance({ tmpDir: decodeDir });
    await vi.waitFor(async () => {
      expect(await fs.readdir(decodeDir)).toEqual(['unrelated.txt']);
    });
    stop();
    await vi.waitFor(async () => {
      expect(await fs.stat(path.join(tmpRoot, 'smart-previews'))).toBeTruthy();
    });
  });
});
