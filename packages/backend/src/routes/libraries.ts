import { Router, json as expressJson } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { getRequestUserId } from '../middleware/auth.js';
import { getDb, saveToFile } from '../services/db.js';
import { sendError } from '../util/errors.js';
import { LibraryRequestError } from '../libraries/library.errors.js';
import { isPathInside, type LibraryStorageConfig } from '../libraries/library.paths.js';
import { LibraryRepository } from '../libraries/library.repository.js';
import { LibraryService } from '../libraries/library.service.js';
import {
  LIBRARY_ASSET_STATUSES,
  type LibraryAssetStatus,
} from '@photolib/shared';
import { LibraryAssetRepository } from '../libraries/library.asset.repository.js';
import { LibraryScanner } from '../libraries/library.scanner.js';
import { LibraryScanQueue } from '../libraries/library.scan-queue.js';
import { LibraryStorage } from '../libraries/library.storage.js';
import { LibraryImportRepository } from '../libraries/library.import.repository.js';
import { LibraryImportService } from '../libraries/library.import.service.js';
import { LibraryIntegrityService } from '../libraries/library.integrity.js';
import {
  LibraryThumbnailService,
  type LibraryThumbnailSize,
} from '../libraries/library.thumbnails.js';
import { getOrCreateSmartPreviewFromFile, parsePreviewSize } from './raw.js';

export function librariesRouter(storageConfig: LibraryStorageConfig) {
  const router = Router();
  router.use(expressJson({ limit: '1mb' }));
  const service = () => new LibraryService(
    new LibraryRepository(getDb()),
    storageConfig,
  );
  let queue: LibraryScanQueue | null = null;
  let storage: LibraryStorage | null = null;
  let thumbnails: LibraryThumbnailService | null = null;
  const libraryStorage = () => {
    if (storage) return storage;
    storage = new LibraryStorage(
      new LibraryRepository(getDb()),
      new LibraryAssetRepository(getDb()),
    );
    return storage;
  };
  const thumbnailService = () => {
    if (thumbnails) return thumbnails;
    thumbnails = new LibraryThumbnailService(libraryStorage(), storageConfig.thumbnailRoot);
    return thumbnails;
  };
  const scanQueue = () => {
    if (queue) return queue;
    const libraries = new LibraryRepository(getDb());
    const assets = new LibraryAssetRepository(getDb());
    queue = new LibraryScanQueue(
      libraries,
      assets,
      new LibraryScanner(libraries, assets),
    );
    return queue;
  };
  let schedulerRunning = false;
  const runPeriodicScans = () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try {
      const due = new LibraryRepository(getDb()).listDueForScan(Date.now());
      for (const library of due) {
        try {
          scanQueue().enqueue(library.ownerId, library.libraryId);
        } catch (error) {
          if (!(error instanceof LibraryRequestError && error.code === 'SCAN_ALREADY_RUNNING')) {
            console.error('[libraries.scan.periodic] could not queue scan', {
              libraryId: library.libraryId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } catch {
      // The router is constructed before the database is initialized.
    } finally {
      schedulerRunning = false;
    }
  };
  const schedulerTimer = setInterval(runPeriodicScans, 60_000);
  schedulerTimer.unref();
  const importService = () => {
    const db = getDb();
    return new LibraryImportService(
      db,
      new LibraryRepository(db),
      new LibraryImportRepository(db),
      new LibraryAssetRepository(db),
      storageConfig,
    );
  };
  const integrityService = () => {
    const db = getDb();
    const libraries = new LibraryRepository(db);
    const assets = new LibraryAssetRepository(db);
    const assetStorage = new LibraryStorage(libraries, assets);
    return new LibraryIntegrityService(libraries, assets, assetStorage);
  };

  router.get('/available-roots', async (_req, res) => {
    try {
      res.json({ roots: await service().availableRoots() });
    } catch (error) {
      handleError(res, 'libraries.available-roots', error);
    }
  });

  /**
   * Which configured root holds an absolute server path. The migration
   * assistant asks this for the root a legacy `server-path` source carries;
   * the answer names only the opaque root id and the relative path below it.
   */
  router.post('/locate-root', async (req, res) => {
    try {
      const body = asObject(req.body);
      res.json(await service().locateRoot(body.path));
    } catch (error) {
      handleError(res, 'libraries.locate-root', error);
    }
  });

  router.post('/validate-root', async (req, res) => {
    try {
      const body = asObject(req.body);
      const root = await service().validateRoot(body.root);
      res.json({ valid: true, root });
    } catch (error) {
      handleError(res, 'libraries.validate-root', error);
    }
  });

  router.get('/', (req, res) => {
    try {
      res.json({ libraries: service().list(getRequestUserId(req)) });
    } catch (error) {
      handleError(res, 'libraries.list', error);
    }
  });

  router.post('/', async (req, res) => {
    try {
      const library = await service().create(getRequestUserId(req), req.body);
      saveToFile();
      res.status(201).json({ library });
    } catch (error) {
      handleError(res, 'libraries.create', error);
    }
  });

  router.post('/:libraryId/scans', (req, res) => {
    try {
      const scan = scanQueue().enqueue(
        getRequestUserId(req),
        param(req, 'libraryId'),
      );
      res.status(202).json({ scan });
    } catch (error) {
      handleError(res, 'libraries.scan.start', error);
    }
  });

  router.get('/:libraryId/scans/:scanId', (req, res) => {
    try {
      const scan = scanQueue().get(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'scanId'),
      );
      res.json({ scan });
    } catch (error) {
      handleError(res, 'libraries.scan.get', error);
    }
  });

  router.post('/:libraryId/scans/:scanId/cancel', (req, res) => {
    try {
      const scan = scanQueue().cancel(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'scanId'),
      );
      res.status(202).json({ scan });
    } catch (error) {
      handleError(res, 'libraries.scan.cancel', error);
    }
  });

  router.get('/:libraryId/stats', (req, res) => {
    try {
      const ownerId = getRequestUserId(req);
      const libraryId = param(req, 'libraryId');
      service().get(ownerId, libraryId);
      res.json(new LibraryAssetRepository(getDb()).getStats(ownerId, libraryId));
    } catch (error) {
      handleError(res, 'libraries.stats', error);
    }
  });

  router.post('/:libraryId/integrity-check', async (req, res) => {
    try {
      const report = await integrityService().check(
        getRequestUserId(req),
        param(req, 'libraryId'),
      );
      saveToFile();
      res.json({ report });
    } catch (error) {
      saveToFile();
      handleError(res, 'libraries.integrity', error);
    }
  });

  router.post('/:libraryId/imports', (req, res) => {
    try {
      const record = importService().create(
        getRequestUserId(req),
        param(req, 'libraryId'),
        req.body,
      );
      saveToFile();
      res.status(201).json({ import: record });
    } catch (error) {
      handleError(res, 'libraries.import.create', error);
    }
  });

  router.get('/:libraryId/imports/:importId', (req, res) => {
    try {
      const record = importService().get(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'importId'),
      );
      res.json({ import: record });
    } catch (error) {
      handleError(res, 'libraries.import.get', error);
    }
  });

  router.put('/:libraryId/imports/:importId/content', async (req, res) => {
    try {
      if (!req.is('application/octet-stream')) {
        throw new LibraryRequestError(
          'INVALID_CONTENT_TYPE',
          415,
          'Import content must use application/octet-stream',
        );
      }
      const record = await importService().uploadContent(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'importId'),
        req,
      );
      saveToFile();
      res.json({ import: record });
    } catch (error) {
      saveToFile();
      handleError(res, 'libraries.import.upload', error);
    }
  });

  router.post('/:libraryId/imports/:importId/commit', async (req, res) => {
    try {
      const result = await importService().commit(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'importId'),
      );
      saveToFile();
      res.json(result);
    } catch (error) {
      saveToFile();
      handleError(res, 'libraries.import.commit', error);
    }
  });

  router.delete('/:libraryId/imports/:importId', async (req, res) => {
    try {
      await importService().cancel(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'importId'),
      );
      saveToFile();
      res.status(204).end();
    } catch (error) {
      handleError(res, 'libraries.import.cancel', error);
    }
  });

  router.get('/:libraryId/assets/changes', (req, res) => {
    try {
      const ownerId = getRequestUserId(req);
      const libraryId = param(req, 'libraryId');
      service().get(ownerId, libraryId);
      const afterRevision = parseNonNegativeInteger(req.query.afterRevision, 0, 'afterRevision');
      const limit = parseLimit(req.query.limit);
      const changes = new LibraryAssetRepository(getDb()).listChanges(
        ownerId,
        libraryId,
        afterRevision,
        limit,
      );
      res.json(changes);
    } catch (error) {
      handleError(res, 'libraries.assets.changes', error);
    }
  });

  router.get('/:libraryId/assets/:assetId', (req, res) => {
    try {
      const ownerId = getRequestUserId(req);
      const libraryId = param(req, 'libraryId');
      service().get(ownerId, libraryId);
      const asset = new LibraryAssetRepository(getDb()).getAsset(
        ownerId,
        libraryId,
        param(req, 'assetId'),
      );
      if (!asset) {
        throw new LibraryRequestError('ASSET_NOT_FOUND', 404, 'Library asset not found');
      }
      res.json({ asset });
    } catch (error) {
      handleError(res, 'libraries.assets.get', error);
    }
  });

  router.post('/:libraryId/assets/:assetId/trash', async (req, res) => {
    try {
      const asset = await libraryStorage().trashAsset(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'assetId'),
      );
      saveToFile();
      res.json({ asset });
    } catch (error) {
      handleError(res, 'libraries.assets.trash', error);
    }
  });

  router.post('/:libraryId/assets/:assetId/restore', async (req, res) => {
    try {
      const asset = await libraryStorage().restoreAsset(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'assetId'),
      );
      saveToFile();
      res.json({ asset });
    } catch (error) {
      handleError(res, 'libraries.assets.restore', error);
    }
  });

  // Purge a trashed asset (the web client's only trash-delete endpoint).
  router.delete('/:libraryId/assets/:assetId/trash', async (req, res) => {
    try {
      await libraryStorage().purgeTrashedAsset(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'assetId'),
      );
      saveToFile();
      res.status(204).end();
    } catch (error) {
      handleError(res, 'libraries.assets.purge', error);
    }
  });

  router.get('/:libraryId/assets/:assetId/original', async (req, res) => {
    try {
      const file = await libraryStorage().resolveAssetFile(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'assetId'),
      );
      const etag = `"library-original-${file.size}-${file.mtimeMs}"`;
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.set({
        'Content-Type': file.asset.mimeType ?? 'application/octet-stream',
        'Content-Disposition': contentDisposition(file.asset.name),
        'Cache-Control': 'private, no-cache',
        ETag: etag,
        'X-Content-Type-Options': 'nosniff',
      });
      await sendFile(res, file.filePath);
    } catch (error) {
      handleError(res, 'libraries.assets.original', error);
    }
  });

  router.post('/:libraryId/assets/:assetId/raw-preview', async (req, res) => {
    try {
      const ownerId = getRequestUserId(req);
      const libraryId = param(req, 'libraryId');
      const assetId = param(req, 'assetId');
      const file = await libraryStorage().resolveAssetFile(ownerId, libraryId, assetId);
      const cacheKey = `library_${createHash('sha256')
        .update(`${ownerId}\0${libraryId}\0${assetId}\0${file.size}\0${file.mtimeMs}`)
        .digest('hex')}`;
      const preview = await getOrCreateSmartPreviewFromFile(
        file.filePath,
        cacheKey,
        parsePreviewSize(req.query.size),
      );
      res.set({
        'Content-Type': 'image/tiff',
        'Cache-Control': 'private, no-cache',
        'X-Cache-Hit': preview.cacheHit ? '1' : '0',
      });
      if (preview.width > 0) res.set('X-Image-Width', String(preview.width));
      if (preview.height > 0) res.set('X-Image-Height', String(preview.height));
      res.send(preview.bytes);
    } catch (error) {
      handleError(res, 'libraries.assets.raw-preview', error);
    }
  });

  router.get('/:libraryId/assets/:assetId/thumbnail', async (req, res) => {
    try {
      const size = parseThumbnailSize(req.query.size);
      const thumbnail = await thumbnailService().getOrCreate(
        getRequestUserId(req),
        param(req, 'libraryId'),
        param(req, 'assetId'),
        size,
      );
      if (req.headers['if-none-match'] === thumbnail.etag) {
        res.status(304).end();
        return;
      }
      res.set({
        'Content-Type': 'image/webp',
        'Cache-Control': 'private, max-age=3600, must-revalidate',
        ETag: thumbnail.etag,
        'X-Content-Type-Options': 'nosniff',
      });
      await sendFile(res, thumbnail.filePath);
    } catch (error) {
      handleError(res, 'libraries.assets.thumbnail', error);
    }
  });

  router.get('/:libraryId/assets', (req, res) => {
    try {
      const ownerId = getRequestUserId(req);
      const libraryId = param(req, 'libraryId');
      service().get(ownerId, libraryId);
      const cursor = parseCursor(req.query.cursor);
      const limit = parseLimit(req.query.limit);
      const status = parseAssetStatus(req.query.status);
      const page = new LibraryAssetRepository(getDb()).listAssets(
        ownerId,
        libraryId,
        cursor,
        limit,
        status,
      );
      res.json(page);
    } catch (error) {
      handleError(res, 'libraries.assets.list', error);
    }
  });

  router.get('/:libraryId', (req, res) => {
    try {
      const library = service().get(getRequestUserId(req), param(req, 'libraryId'));
      res.json({ library });
    } catch (error) {
      handleError(res, 'libraries.get', error);
    }
  });

  router.patch('/:libraryId', (req, res) => {
    try {
      const library = service().update(
        getRequestUserId(req),
        param(req, 'libraryId'),
        req.body,
      );
      saveToFile();
      res.json({ library });
    } catch (error) {
      handleError(res, 'libraries.update', error);
    }
  });

  router.delete('/:libraryId', async (req, res) => {
    try {
      const libraryId = param(req, 'libraryId');
      service().delete(
        getRequestUserId(req),
        libraryId,
        req.query.preserveOriginals === 'true',
      );
      saveToFile();
      await removeLibraryThumbnails(storageConfig.thumbnailRoot, libraryId);
      res.status(204).end();
    } catch (error) {
      handleError(res, 'libraries.delete', error);
    }
  });

  return router;
}

function handleError(res: Response, tag: string, error: unknown): void {
  if (res.headersSent) {
    console.error(`[${tag}] response failed after headers were sent`, error);
    res.end();
    return;
  }
  if (error instanceof LibraryRequestError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  sendError(res, tag, 500, 'Library operation failed', error);
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LibraryRequestError('INVALID_REQUEST', 400, 'Request body must be an object');
  }
  return value as Record<string, unknown>;
}

function parseLimit(value: unknown): number {
  return parseNonNegativeInteger(value, 200, 'limit', 1, 500);
}

function parseNonNegativeInteger(
  value: unknown,
  fallback: number,
  field: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new LibraryRequestError('INVALID_QUERY', 400, `Invalid ${field}`);
  }
  return parsed;
}

function parseCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 64 || !/^[a-f0-9-]+$/i.test(value)) {
    throw new LibraryRequestError('INVALID_QUERY', 400, 'Invalid cursor');
  }
  return value;
}

function parseAssetStatus(value: unknown): LibraryAssetStatus | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === 'string'
    && (LIBRARY_ASSET_STATUSES as readonly string[]).includes(value)
  ) return value as LibraryAssetStatus;
  throw new LibraryRequestError('INVALID_QUERY', 400, 'Invalid status');
}

function parseThumbnailSize(value: unknown): LibraryThumbnailSize {
  if (value === undefined || value === 'small') return 'small';
  if (value === 'large') return 'large';
  throw new LibraryRequestError('INVALID_QUERY', 400, 'Invalid thumbnail size');
}

function contentDisposition(fileName: string): string {
  let fallback = '';
  for (const character of fileName) {
    const code = character.charCodeAt(0);
    fallback += code >= 32 && code <= 126 && character !== '"' && character !== '\\'
      ? character
      : '_';
  }
  const encoded = encodeURIComponent(fileName)
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
  return `inline; filename="${fallback || 'photo'}"; filename*=UTF-8''${encoded}`;
}

function sendFile(res: Response, filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    res.sendFile(filePath, (error) => error ? reject(error) : resolve());
  });
}

async function removeLibraryThumbnails(
  thumbnailRoot: string | undefined,
  libraryId: string,
): Promise<void> {
  if (!thumbnailRoot || !/^[a-f0-9-]{16,64}$/i.test(libraryId)) return;
  const root = path.resolve(thumbnailRoot);
  const target = path.join(root, libraryId);
  if (!isPathInside(root, target) || target === root) return;
  await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
}
