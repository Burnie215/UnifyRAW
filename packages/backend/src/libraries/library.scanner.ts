import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Dirent, Stats } from 'node:fs';
import sharp from 'sharp';
import type { PhotoLibraryAssetMetadata } from '@photolib/shared';
import { saveToFile } from '../services/db.js';
import { computeLibraryQuickHash } from './library.hash.js';
import { isPathInside } from './library.paths.js';
import { matchesLibraryExclusion, mediaTypeForPath } from './library.media.js';
import {
  LibraryAssetRepository,
  type ScanCounters,
  type StoredLibraryAsset,
} from './library.asset.repository.js';
import {
  LibraryRepository,
  type StoredLibraryRoot,
  type StoredPhotoLibrary,
} from './library.repository.js';

const execFileAsync = promisify(execFile);

interface ScanContext {
  ownerId: string;
  library: StoredPhotoLibrary;
  scanId: string;
  generation: number;
  counters: ScanCounters;
  lastPersistedAt: number;
  shouldCancel(): boolean;
}

interface RootScanResult {
  complete: boolean;
}

export class LibraryScanner {
  constructor(
    private readonly libraries: LibraryRepository,
    private readonly assets: LibraryAssetRepository,
    private readonly persist: () => void = saveToFile,
  ) {}

  async run(
    ownerId: string,
    libraryId: string,
    scanId: string,
    shouldCancel: () => boolean,
  ): Promise<void> {
    const library = this.libraries.get(ownerId, libraryId);
    const scan = this.assets.getScan(ownerId, libraryId, scanId);
    if (!library || !scan) return;

    const counters: ScanCounters = {
      discovered: 0,
      added: 0,
      updated: 0,
      offline: 0,
      restored: 0,
      errors: 0,
    };
    const context: ScanContext = {
      ownerId,
      library,
      scanId,
      generation: scan.generation,
      counters,
      lastPersistedAt: Date.now(),
      shouldCancel,
    };
    this.assets.markScanRunning(ownerId, libraryId, scanId, Date.now());
    this.persist();

    try {
      let completeRoots = 0;
      let incompleteRoots = 0;
      for (const root of library.roots) {
        this.throwIfCancelled(context);
        const result = await this.scanRoot(context, root);
        if (result.complete) {
          completeRoots++;
          const now = Date.now();
          this.assets.markRootAvailable(root.id, now);
          counters.offline += this.assets.markMissingOffline(
            ownerId,
            libraryId,
            root.id,
            context.generation,
            now,
          );
        } else {
          incompleteRoots++;
          this.assets.markRootUnavailable(root.id);
        }
        this.assets.updateScanProgress(ownerId, libraryId, scanId, counters, null);
        this.persist();
      }

      this.throwIfCancelled(context);
      if (incompleteRoots === 0) {
        const moves = this.assets.reconcileMoves(
          ownerId,
          libraryId,
          context.generation,
          Date.now(),
        );
        counters.added = Math.max(0, counters.added - moves);
        counters.offline = Math.max(0, counters.offline - moves);
        counters.updated += moves;
      }

      const errorSummary = incompleteRoots > 0
        ? `${incompleteRoots} library root${incompleteRoots === 1 ? '' : 's'} could not be scanned completely`
        : null;
      if (completeRoots === 0 && library.roots.length > 0) {
        this.assets.finishScan(
          ownerId,
          libraryId,
          scanId,
          'failed',
          counters,
          errorSummary ?? 'No library root could be scanned',
          Date.now(),
        );
      } else {
        this.assets.finishScan(
          ownerId,
          libraryId,
          scanId,
          'completed',
          counters,
          errorSummary,
          Date.now(),
        );
      }
      this.persist();
    } catch (error) {
      if (error instanceof ScanCancelledError) {
        this.assets.finishScan(
          ownerId,
          libraryId,
          scanId,
          'cancelled',
          counters,
          null,
          Date.now(),
        );
        this.persist();
        return;
      }
      this.assets.finishScan(
        ownerId,
        libraryId,
        scanId,
        'failed',
        counters,
        'Library scan failed',
        Date.now(),
      );
      this.persist();
    }
  }

  private async scanRoot(
    context: ScanContext,
    root: StoredLibraryRoot,
  ): Promise<RootScanResult> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await fs.realpath(root.path);
      const stat = await fs.stat(canonicalRoot);
      if (!stat.isDirectory() || canonicalRoot !== root.canonicalPath) {
        return { complete: false };
      }
    } catch {
      context.counters.errors++;
      return { complete: false };
    }

    let complete = true;
    const directories: Array<{ absolutePath: string; relativePath: string }> = [
      { absolutePath: canonicalRoot, relativePath: '' },
    ];

    while (directories.length > 0) {
      this.throwIfCancelled(context);
      const directory = directories.pop()!;
      let entries: Dirent[];
      try {
        const handle = await fs.opendir(directory.absolutePath);
        entries = [];
        for await (const entry of handle) entries.push(entry);
      } catch {
        context.counters.errors++;
        complete = false;
        continue;
      }

      for (const entry of entries) {
        this.throwIfCancelled(context);
        if (
          context.library.mode === 'managed'
          && directory.relativePath === ''
          && (entry.name === '.incoming' || entry.name === '.trash')
        ) continue;
        if (!context.library.includeHidden && entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) continue;

        const relativeNative = path.join(directory.relativePath, entry.name);
        const relativePath = toPosix(relativeNative);
        const absolutePath = path.join(canonicalRoot, relativeNative);
        const isDirectory = entry.isDirectory();
        if (matchesLibraryExclusion(
          relativePath,
          context.library.exclusionPatterns,
          isDirectory,
        )) continue;

        if (isDirectory) {
          directories.push({ absolutePath, relativePath: relativeNative });
          continue;
        }
        if (!entry.isFile()) continue;

        const media = mediaTypeForPath(entry.name);
        if (!media) continue;
        context.counters.discovered++;

        const existing = this.assets.findByPath(
          context.ownerId,
          context.library.id,
          root.id,
          relativePath,
        );
        try {
          const canonicalFile = await fs.realpath(absolutePath);
          if (!isPathInside(canonicalRoot, canonicalFile)) throw new Error('File escaped root');
          const stat = await fs.stat(canonicalFile);
          if (!stat.isFile()) continue;
          await this.reconcileFile(context, root, relativePath, canonicalFile, stat, media, existing);
        } catch {
          context.counters.errors++;
          if (existing) {
            this.assets.markAssetError(
              existing,
              context.generation,
              'FILE_UNREADABLE',
              Date.now(),
            );
          }
        }

        if (context.counters.discovered % 100 === 0) {
          this.assets.updateScanProgress(
            context.ownerId,
            context.library.id,
            context.scanId,
            context.counters,
            relativePath,
          );
          const now = Date.now();
          if (now - context.lastPersistedAt >= 5_000) {
            this.persist();
            context.lastPersistedAt = now;
          }
        }
      }
    }

    return { complete };
  }

  private async reconcileFile(
    context: ScanContext,
    root: StoredLibraryRoot,
    relativePath: string,
    canonicalFile: string,
    stat: Stats,
    media: { extension: string; mimeType: string },
    existing: StoredLibraryAsset | null,
  ): Promise<void> {
    const mtimeMs = Math.trunc(stat.mtimeMs);
    const now = Date.now();
    if (
      existing
      && existing.status === 'online'
      && existing.sizeBytes === stat.size
      && existing.dateModified === mtimeMs
      && existing.quickHash
      && existing.metadata !== null
    ) {
      this.assets.touchUnchanged(existing.id, context.generation, now);
      return;
    }

    const quickHash = await computeLibraryQuickHash(canonicalFile, stat.size);
    const metadata = await extractRasterMetadata(canonicalFile, media.mimeType);
    const afterHash = await fs.stat(canonicalFile);
    if (afterHash.size !== stat.size || Math.trunc(afterHash.mtimeMs) !== mtimeMs) {
      throw new Error('File changed while it was being indexed');
    }

    const result = this.assets.reconcileFile(
      {
        ownerId: context.ownerId,
        libraryId: context.library.id,
        rootId: root.id,
        relativePath,
        fileName: path.basename(relativePath),
        extension: media.extension,
        mimeType: media.mimeType,
        size: stat.size,
        mtimeMs,
        inode: Number.isSafeInteger(stat.ino) ? stat.ino : null,
        quickHash,
        width: metadata.width,
        height: metadata.height,
      orientation: metadata.orientation,
      dateTaken: metadata.dateTaken,
      metadata: metadata.capture,
        scanGeneration: context.generation,
        seenAt: now,
      },
      existing,
      randomUUID(),
    );
    context.counters[result]++;
  }

  private throwIfCancelled(context: ScanContext): void {
    if (context.shouldCancel()) throw new ScanCancelledError();
  }
}

async function extractRasterMetadata(
  filePath: string,
  mimeType: string,
): Promise<{
  width: number | null;
  height: number | null;
  orientation: number | null;
  dateTaken: number | null;
  capture: PhotoLibraryAssetMetadata;
}> {
  let sharpWidth: number | null = null;
  let sharpHeight: number | null = null;
  let sharpOrientation: number | null = null;
  try {
    if (['image/jpeg', 'image/png', 'image/tiff', 'image/webp', 'image/gif', 'image/avif'].includes(mimeType)) {
      const metadata = await sharp(filePath, { failOn: 'error' }).metadata();
      sharpWidth = metadata.width ?? null;
      sharpHeight = metadata.height ?? null;
      sharpOrientation = metadata.orientation ?? null;
    }
  } catch {
    // ExifTool below supports containers that sharp cannot decode.
  }

  let exif: ExifToolMetadata = {};
  try {
    const { stdout } = await execFileAsync('exiftool', [
      '-json', '-n', '-fast2',
      '-Make', '-Model', '-LensModel', '-LensID',
      '-ISO', '-ISOSpeed', '-StandardOutputSensitivity', '-RecommendedExposureIndex',
      '-FNumber', '-ApertureValue', '-ExposureTime', '-ShutterSpeedValue',
      '-FocalLength', '-FocalLengthIn35mmFormat',
      '-DateTimeOriginal', '-CreateDate',
      '-ImageWidth', '-ImageHeight', '-ExifImageWidth', '-ExifImageHeight', '-Orientation',
      filePath,
    ], { encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(String(stdout)) as unknown;
    if (Array.isArray(parsed) && typeof parsed[0] === 'object' && parsed[0] !== null) {
      exif = parsed[0] as ExifToolMetadata;
    }
  } catch {
    // The image remains indexable without metadata (and test/dev installs may
    // intentionally not include the runtime ExifTool binary).
  }

  const normalized = metadataFromExifToolRecord(exif);
  return {
    width: positiveNumber(exif.ExifImageWidth) ?? positiveNumber(exif.ImageWidth) ?? sharpWidth,
    height: positiveNumber(exif.ExifImageHeight) ?? positiveNumber(exif.ImageHeight) ?? sharpHeight,
    orientation: positiveNumber(exif.Orientation) ?? sharpOrientation,
    dateTaken: parseExifDate(exif.DateTimeOriginal ?? exif.CreateDate),
    capture: normalized,
  };
}

interface ExifToolMetadata extends Record<string, unknown> {
  Make?: unknown;
  Model?: unknown;
  LensModel?: unknown;
  LensID?: unknown;
  ISO?: unknown;
  ISOSpeed?: unknown;
  StandardOutputSensitivity?: unknown;
  RecommendedExposureIndex?: unknown;
  FNumber?: unknown;
  ApertureValue?: unknown;
  ExposureTime?: unknown;
  ShutterSpeedValue?: unknown;
  FocalLength?: unknown;
  FocalLengthIn35mmFormat?: unknown;
  DateTimeOriginal?: unknown;
  CreateDate?: unknown;
  ImageWidth?: unknown;
  ImageHeight?: unknown;
  ExifImageWidth?: unknown;
  ExifImageHeight?: unknown;
  Orientation?: unknown;
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function rounded(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function metadataFromExifToolRecord(record: ExifToolMetadata): PhotoLibraryAssetMetadata {
  const make = cleanString(record.Make);
  const model = cleanString(record.Model);
  const shutterApex = positiveNumber(record.ShutterSpeedValue);
  const apertureApex = positiveNumber(record.ApertureValue);
  const exposure = positiveNumber(record.ExposureTime)
    ?? (shutterApex !== null ? 2 ** -shutterApex : null);
  const aperture = positiveNumber(record.FNumber)
    ?? (apertureApex !== null ? 2 ** (apertureApex / 2) : null);
  return {
    camera: make && model ? (model.startsWith(make) ? model : `${make} ${model}`) : model ?? make,
    lens: cleanString(record.LensModel) ?? cleanString(record.LensID),
    iso: positiveNumber(record.ISO)
      ?? positiveNumber(record.ISOSpeed)
      ?? positiveNumber(record.StandardOutputSensitivity)
      ?? positiveNumber(record.RecommendedExposureIndex),
    focalLength: positiveNumber(record.FocalLength)
      ?? positiveNumber(record.FocalLengthIn35mmFormat),
    aperture: aperture !== null ? rounded(aperture) : null,
    shutterSpeed: exposure === null
      ? null
      : exposure < 1
        ? `1/${Math.max(1, Math.round(1 / exposure))}`
        : `${rounded(exposure, 3)}`,
  };
}

function parseExifDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^(\d{4}):(\d{2}):(\d{2}) /, '$1-$2-$3T');
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

class ScanCancelledError extends Error {}

function toPosix(candidate: string): string {
  return candidate.split(path.sep).join('/');
}
