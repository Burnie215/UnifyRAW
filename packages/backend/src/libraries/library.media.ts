import path from 'node:path';

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.hif': 'image/heif',
  '.cr2': 'image/x-canon-cr2',
  '.cr3': 'image/x-canon-cr3',
  '.nef': 'image/x-nikon-nef',
  '.nrw': 'image/x-nikon-nrw',
  '.arw': 'image/x-sony-arw',
  '.srf': 'image/x-sony-srf',
  '.sr2': 'image/x-sony-sr2',
  '.dng': 'image/x-adobe-dng',
  '.orf': 'image/x-olympus-orf',
  '.raf': 'image/x-fuji-raf',
  '.rw2': 'image/x-panasonic-rw2',
  '.rwl': 'image/x-leica-rwl',
  '.pef': 'image/x-pentax-pef',
  '.ptx': 'image/x-pentax-ptx',
  '.srw': 'image/x-samsung-srw',
  '.x3f': 'image/x-sigma-x3f',
};

export function mediaTypeForPath(filePath: string): {
  extension: string;
  mimeType: string;
} | null {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXTENSION[extension];
  return mimeType ? { extension, mimeType } : null;
}

export function matchesLibraryExclusion(
  relativePath: string,
  patterns: readonly string[],
  isDirectory: boolean,
): boolean {
  const candidate = toPosix(relativePath) + (isDirectory ? '/' : '');
  return patterns.some((pattern) => globToRegExp(toPosix(pattern)).test(candidate));
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === '*') {
      const nextIsStar = pattern[index + 1] === '*';
      if (nextIsStar) {
        index++;
        if (pattern[index + 1] === '/') {
          index++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(character);
    }
  }
  source += '$';
  return new RegExp(source);
}

function escapeRegExp(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function toPosix(candidate: string): string {
  return candidate.split(path.sep).join('/');
}
