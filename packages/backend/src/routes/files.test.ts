import fs from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filesRouter } from './files.js';

let allowedRoot: string;
let outsideRoot: string;
let photosDir: string;
let validateDir: string;
let pngPath: string;
let jpgPath: string;
let server: Server;
let baseUrl: string;

interface BrowseBody {
  files: Array<{ name: string; path: string; isDir: boolean; mimeType?: string }>;
  total: number;
  hasMore: boolean;
}

beforeAll(async () => {
  allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-files-api-'));
  outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-files-outside-'));
  photosDir = path.join(allowedRoot, 'photos');
  validateDir = path.join(allowedRoot, 'validate');
  await fs.mkdir(photosDir);
  await fs.mkdir(validateDir);

  const png = await solidImage(64).png().toBuffer();
  pngPath = path.join(photosDir, 'a.png');
  jpgPath = path.join(photosDir, 'b.jpg');
  await fs.writeFile(pngPath, png);
  await fs.writeFile(jpgPath, await solidImage(16).jpeg().toBuffer());
  await fs.writeFile(path.join(photosDir, 'notes.txt'), 'not an image');
  await fs.writeFile(path.join(photosDir, '.hidden.png'), png);
  await fs.writeFile(path.join(validateDir, 'x.png'), png);
  await fs.writeFile(path.join(validateDir, 'readme.txt'), 'text');
  await fs.writeFile(path.join(outsideRoot, 'secret.png'), png);
  await fs.symlink(outsideRoot, path.join(allowedRoot, 'escape'));

  const app = express();
  app.use('/api/files', filesRouter([allowedRoot]));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  await fs.rm(allowedRoot, { recursive: true, force: true });
  await fs.rm(outsideRoot, { recursive: true, force: true });
});

describe('files API wire contract', () => {
  it('lists supported, non-hidden images sorted by name', async () => {
    const response = await get(`/browse?path=${q(photosDir)}`);
    expect(response.status).toBe(200);
    const body = await response.json() as BrowseBody;
    expect(body).toMatchObject({ total: 2, hasMore: false });
    expect(body.files.map((file) => [file.name, file.mimeType, file.isDir])).toEqual([
      ['a.png', 'image/png', false],
      ['b.jpg', 'image/jpeg', false],
    ]);
  });

  it('paginates the listing', async () => {
    const first = await (await get(`/browse?path=${q(photosDir)}&page=1&pageSize=1`)).json() as BrowseBody;
    const second = await (await get(`/browse?path=${q(photosDir)}&page=2&pageSize=1`)).json() as BrowseBody;
    expect(first).toMatchObject({ total: 2, hasMore: true });
    expect(first.files.map((file) => file.name)).toEqual(['a.png']);
    expect(second).toMatchObject({ total: 2, hasMore: false });
    expect(second.files.map((file) => file.name)).toEqual(['b.jpg']);
  });

  it.each(['pageSize=0', 'pageSize=501', 'page=0', 'pageSize=abc'])('rejects %s with 400', async (query) => {
    const response = await get(`/browse?path=${q(photosDir)}&${query}`);
    expect(response.status).toBe(400);
  });

  it('refuses paths outside the allowed roots', async () => {
    const secret = path.join(outsideRoot, 'secret.png');
    const traversal = `${allowedRoot}/../${path.basename(outsideRoot)}`;
    const refused = [
      await get(`/browse?path=${q(outsideRoot)}`),
      await get(`/browse?path=${q(traversal)}`),
      await get(`/browse?path=${q(path.join(allowedRoot, 'escape'))}`),
      await get(`/browse?path=${q('photos')}`),
      await get(`/download?path=${q(secret)}`),
      await get(`/download?path=${q(path.join(allowedRoot, 'escape', 'secret.png'))}`),
      await get(`/thumb?path=${q(secret)}`),
      await postJson('/validate', { path: outsideRoot }),
    ];
    for (const response of refused) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Path not allowed' });
    }
  });

  it('downloads the file bytes unchanged', async () => {
    const response = await get(`/download?path=${q(jpgPath)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.equals(await fs.readFile(jpgPath))).toBe(true);
  });

  it('serves only supported image files', async () => {
    const notes = path.join(photosDir, 'notes.txt');
    expect((await get(`/download?path=${q(notes)}`)).status).toBe(415);
    expect((await get(`/thumb?path=${q(notes)}`)).status).toBe(415);
  });

  it('renders a JPEG thumbnail without enlarging', async () => {
    const small = await get(`/thumb?path=${q(pngPath)}&size=32`);
    expect(small.status).toBe(200);
    expect(small.headers.get('content-type')).toBe('image/jpeg');
    expect(await sharp(Buffer.from(await small.arrayBuffer())).metadata()).toMatchObject({
      format: 'jpeg', width: 32, height: 32,
    });

    const defaultSize = await get(`/thumb?path=${q(pngPath)}`);
    expect(await sharp(Buffer.from(await defaultSize.arrayBuffer())).metadata()).toMatchObject({
      format: 'jpeg', width: 64, height: 64,
    });
  });

  it('rejects thumbnail sizes outside 32..2048', async () => {
    expect((await get(`/thumb?path=${q(pngPath)}&size=16`)).status).toBe(400);
    expect((await get(`/thumb?path=${q(pngPath)}&size=4096`)).status).toBe(400);
  });

  it('validates directories and refuses missing paths', async () => {
    const existing = await postJson('/validate', { path: validateDir });
    expect(existing.status).toBe(200);
    expect(await existing.json()).toEqual({ valid: true, fileCount: 2, imageCount: 1 });

    const file = await postJson('/validate', { path: path.join(validateDir, 'x.png') });
    expect(await file.json()).toEqual({ valid: false, error: 'Not a directory' });

    const missing = await postJson('/validate', { path: path.join(allowedRoot, 'missing') });
    expect(missing.status).toBe(403);

    expect((await postJson('/validate', {})).status).toBe(400);
    // No JSON body at all: express leaves req.body undefined.
    expect((await fetch(`${baseUrl}/api/files/validate`, { method: 'POST' })).status).toBe(400);
  });

  it('keeps admin-only thumbnails out of shared caches', async () => {
    const response = await get(`/thumb?path=${q(pngPath)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400');
  });

  it.todo('F063 POST /mkdir creates a directory below an allowed root, or ServerPathSource.createAlbum is removed');

  it('refuses the directory that contains an allowed root', async () => {
    const parent = path.dirname(allowedRoot);
    for (const response of [
      await get(`/browse?path=${q(parent)}`),
      await postJson('/validate', { path: parent }),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Path not allowed' });
    }
  });
});

function solidImage(edge: number) {
  return sharp({ create: { width: edge, height: edge, channels: 3, background: { r: 200, g: 80, b: 40 } } });
}

function q(value: string): string {
  return encodeURIComponent(value);
}

function get(segment: string): Promise<Response> {
  return fetch(`${baseUrl}/api/files${segment}`);
}

function postJson(segment: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/files${segment}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
