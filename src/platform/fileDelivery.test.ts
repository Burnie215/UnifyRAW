import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverFile } from './fileDelivery';
import type { ShellGlobal } from './nativeShell';

/**
 * The plugins are replaced and every call into them is counted. The count is
 * what proves the promise this module exists for: a browser reaches neither of
 * them, because it returns before the `await import()` that would pull the
 * chunk. That the imports really are deferred - and that no other file in
 * `src/` undoes it with a static one - is pinned separately, at the bottom of
 * this file.
 */
const plugins = vi.hoisted(() => ({
  calls: [] as string[],
  written: [] as Array<{ path: string; data: string; directory: string; recursive?: boolean }>,
  shared: [] as Array<{ title?: string; files?: string[] }>,
  writeFails: false,
  shareFails: false,
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Documents: 'DOCUMENTS', Cache: 'CACHE' },
  Filesystem: {
    writeFile: async (options: { path: string; data: string; directory: string; recursive?: boolean }) => {
      plugins.calls.push('writeFile');
      if (plugins.writeFails) throw new Error('sandbox refused the write');
      plugins.written.push(options);
      return { uri: `file:///${options.directory}/${options.path}` };
    },
  },
}));

vi.mock('@capacitor/share', () => ({
  Share: {
    share: async (options: { title?: string; files?: string[] }) => {
      plugins.calls.push('share');
      if (plugins.shareFails) throw new Error('user dismissed the sheet');
      plugins.shared.push(options);
      return {};
    },
  },
}));

function runtime(platform: string, available: readonly string[]): ShellGlobal {
  return {
    Capacitor: {
      getPlatform: () => platform,
      isPluginAvailable: (name) => available.includes(name),
    },
  };
}

const BOTH = ['Filesystem', 'Share'];

beforeEach(() => {
  plugins.calls.length = 0;
  plugins.written.length = 0;
  plugins.shared.length = 0;
  plugins.writeFails = false;
  plugins.shareFails = false;
});

describe('deliverFile in a browser', () => {
  it('hands the blob to the download sink and never loads a plugin', async () => {
    const download = vi.fn();
    const blob = new Blob(['edit'], { type: 'image/jpeg' });

    const result = await deliverFile(blob, 'shot_edited.jpg', { win: {}, download });

    expect(result).toEqual({ route: 'web-download' });
    expect(download).toHaveBeenCalledWith(blob, 'shot_edited.jpg');
    expect(plugins.calls).toEqual([]);
  });

  it('treats a missing window the same way', async () => {
    const download = vi.fn();
    const result = await deliverFile(new Blob(['x']), 'x.xmp', { win: null, download });

    expect(result.route).toBe('web-download');
    expect(download).toHaveBeenCalledOnce();
    expect(plugins.calls).toEqual([]);
  });
});

describe('deliverFile in a native shell', () => {
  it('writes to the cache and offers the written file to the share sheet', async () => {
    const download = vi.fn();
    const result = await deliverFile(new Blob(['jpeg-bytes']), 'shot_edited.jpg', {
      win: runtime('ios', BOTH),
      title: 'Export',
      download,
    });

    expect(plugins.written).toEqual([
      { path: 'shot_edited.jpg', data: btoa('jpeg-bytes'), directory: 'CACHE', recursive: true },
    ]);
    expect(plugins.shared).toEqual([
      { title: 'Export', files: ['file:///CACHE/shot_edited.jpg'] },
    ]);
    expect(result).toEqual({ route: 'native-share', uri: 'file:///CACHE/shot_edited.jpg' });
    expect(download).not.toHaveBeenCalled();
  });

  it('saves to documents and skips the sheet when only the filesystem plugin answered', async () => {
    const result = await deliverFile(new Blob(['xmp']), 'shot.xmp', {
      win: runtime('android', ['Filesystem']),
      download: vi.fn(),
    });

    expect(plugins.written[0].directory).toBe('DOCUMENTS');
    expect(plugins.calls).toEqual(['writeFile']);
    expect(plugins.shared).toEqual([]);
    expect(result.route).toBe('native-save');
  });

  it('falls back to the download rather than losing the export when the write fails', async () => {
    plugins.writeFails = true;
    const download = vi.fn();

    const result = await deliverFile(new Blob(['jpeg']), 'shot.jpg', {
      win: runtime('android', BOTH),
      download,
    });

    expect(download).toHaveBeenCalledOnce();
    expect(result).toEqual({ route: 'web-download', fellBackFrom: 'native-share' });
  });

  it('falls back the same way when the share sheet refuses', async () => {
    plugins.shareFails = true;
    const download = vi.fn();

    const result = await deliverFile(new Blob(['jpeg']), 'shot.jpg', {
      win: runtime('ios', BOTH),
      download,
    });

    expect(download).toHaveBeenCalledOnce();
    expect(result.fellBackFrom).toBe('native-share');
  });

  // The plugin needs base64, and an export is not a short string.
  it('encodes a blob larger than one conversion chunk without losing bytes', async () => {
    const bytes = new Uint8Array(0x8000 * 2 + 17);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;

    await deliverFile(new Blob([bytes]), 'big.tif', { win: runtime('ios', BOTH), download: vi.fn() });

    const decoded = Uint8Array.from(atob(plugins.written[0].data), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});

/**
 * The bundling promise, checked on the sources rather than on a build: a
 * static `import ... from '@capacitor/...'` anywhere in `src/` would put the
 * plugin runtime into the main chunk of every browser user, which is exactly
 * what the seven installed packages did NOT cost so far. Only `await import()`
 * keeps them in a chunk a browser never fetches.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Same shape as src/test/layering.test.ts: static and dynamic specifiers. */
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function capacitorImports(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(SPECIFIER)]
    .map((match) => match[1])
    .filter((spec) => spec.startsWith('@capacitor/'));
}

describe('the Capacitor plugins stay off the web path', () => {
  const files = sourceFiles(SRC);

  it('imports a @capacitor package in one production file only', () => {
    const importers = files
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .filter((file) => capacitorImports(file).length > 0)
      .map((file) => relative(SRC, file));

    expect(importers).toEqual(['platform/fileDelivery.ts']);
  });

  it('has no static import of a @capacitor package anywhere in src', () => {
    const statics = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return [...text.matchAll(/(?:^\s*import[^;]*?\bfrom\s*|^\s*import\s*)['"](@capacitor\/[^'"]+)['"]/gm)]
        .map((match) => `${relative(SRC, file)} -> ${match[1]}`);
    });

    expect(statics).toEqual([]);
  });
});
