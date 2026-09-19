import { Router, json as expressJson } from 'express';
import type { Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import sharp from 'sharp';
import { sendError } from '../util/errors.js';
import { resolveAllowedExistingPath } from '../security/allowed-path.js';

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif', '.heic', '.heif', '.hif',
  '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng',
  '.orf', '.raf', '.rw2', '.rwl', '.pef', '.ptx', '.srw', '.x3f',
]);

export function filesRouter(allowedRoots: string[]) {
  const router = Router();
  router.use(expressJson({ limit: '1mb' }));

  /**
   * GET /api/files/browse?path=/mnt/photos&page=1&pageSize=200
   */
  router.get('/browse', async (req: Request, res: Response) => {
    const dirPath = req.query.path as string;
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 200);

    if (!dirPath) { res.status(400).json({ error: 'Missing path' }); return; }
    if (!isIntegerInRange(page, 1, Number.MAX_SAFE_INTEGER) || !isIntegerInRange(pageSize, 1, 500)) {
      res.status(400).json({ error: 'page must be positive and pageSize must be between 1 and 500' });
      return;
    }

    const safePath = await resolveAllowedExistingPath(dirPath, allowedRoots);
    if (!safePath) { res.status(403).json({ error: 'Path not allowed' }); return; }

    try {
      const directoryStat = await fs.stat(safePath);
      if (!directoryStat.isDirectory()) {
        res.status(400).json({ error: 'Path is not a directory' });
        return;
      }
      const entries = await fs.readdir(safePath, { withFileTypes: true });
      const files: { name: string; path: string; size: number; mtime: number; isDir: boolean; mimeType?: string }[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const fullPath = path.join(safePath, entry.name);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat) continue;

        if (entry.isDirectory()) {
          files.push({ name: entry.name, path: fullPath, size: 0, mtime: stat.mtimeMs, isDir: true });
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (IMAGE_EXTENSIONS.has(ext)) {
            files.push({
              name: entry.name,
              path: fullPath,
              size: stat.size,
              mtime: stat.mtimeMs,
              isDir: false,
              mimeType: `image/${ext.slice(1).replace('jpg', 'jpeg')}`,
            });
          }
        }
      }

      // Sort: dirs first, then by name
      files.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const start = (page - 1) * pageSize;
      const paged = files.slice(start, start + pageSize);

      res.json({
        files: paged,
        total: files.length,
        hasMore: start + pageSize < files.length,
      });
    } catch (e) {
      sendError(res, 'files.browse', 500, 'Directory read failed', e);
    }
  });

  /**
   * GET /api/files/thumb?path=/mnt/photos/img.jpg&size=300
   */
  router.get('/thumb', async (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    const size = Number(req.query.size ?? 300);

    if (!filePath) { res.status(400).json({ error: 'Missing path' }); return; }
    if (!isIntegerInRange(size, 32, 2048)) {
      res.status(400).json({ error: 'size must be between 32 and 2048' });
      return;
    }

    const safePath = await resolveAllowedExistingPath(filePath, allowedRoots);
    if (!safePath) { res.status(403).json({ error: 'Path not allowed' }); return; }

    try {
      if (!await isSupportedImageFile(safePath)) {
        res.status(415).json({ error: 'Path is not a supported image file' });
        return;
      }
      const buffer = await sharp(safePath)
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=86400').send(buffer);
    } catch (e) {
      sendError(res, 'files.thumb', 500, 'Thumbnail generation failed', e);
    }
  });

  /**
   * GET /api/files/download?path=/mnt/photos/img.jpg
   */
  router.get('/download', async (req: Request, res: Response) => {
    const filePath = req.query.path as string;

    if (!filePath) { res.status(400).json({ error: 'Missing path' }); return; }

    const safePath = await resolveAllowedExistingPath(filePath, allowedRoots);
    if (!safePath) { res.status(403).json({ error: 'Path not allowed' }); return; }

    try {
      if (!await isSupportedImageFile(safePath)) {
        res.status(415).json({ error: 'Path is not a supported image file' });
        return;
      }
      res.sendFile(safePath, (error) => {
        if (!error) return;
        if (res.headersSent) res.destroy(error);
        else sendError(res, 'files.download', 500, 'File send failed', error);
      });
    } catch (e) {
      sendError(res, 'files.download', 500, 'File send failed', e);
    }
  });

  /**
   * POST /api/files/validate
   * Body: { path: "/mnt/photos" }
   */
  router.post('/validate', async (req: Request, res: Response) => {
    const dirPath = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof dirPath !== 'string' || !dirPath) { res.status(400).json({ error: 'Missing path' }); return; }

    const safePath = await resolveAllowedExistingPath(dirPath, allowedRoots);
    if (!safePath) { res.status(403).json({ error: 'Path not allowed' }); return; }

    try {
      const stat = await fs.stat(safePath);
      if (!stat.isDirectory()) { res.json({ valid: false, error: 'Not a directory' }); return; }

      const entries = await fs.readdir(safePath);
      const imageCount = entries.filter((e) => IMAGE_EXTENSIONS.has(path.extname(e).toLowerCase())).length;

      res.json({ valid: true, fileCount: entries.length, imageCount });
    } catch (e) {
      console.error('[files.validate] stat/read failed', e);
      res.json({ valid: false, error: 'Path not accessible' });
    }
  });

  return router;
}

async function isSupportedImageFile(filePath: string): Promise<boolean> {
  if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  const stat = await fs.stat(filePath);
  return stat.isFile();
}

function isIntegerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
