import fs from 'node:fs/promises';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../services/db.js';
import { librariesRouter } from './libraries.js';

let temporaryRoot: string;
let externalRoot: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-library-api-'));
  externalRoot = path.join(temporaryRoot, 'photos');
  await fs.mkdir(externalRoot);
  await initDb(path.join(temporaryRoot, 'photolib.db'));

  const app = express();
  app.use('/api/libraries', librariesRouter({
    allowedRoots: [externalRoot],
    managedRoot: path.join(temporaryRoot, 'managed'),
    thumbnailRoot: path.join(temporaryRoot, 'thumbs'),
    databasePath: path.join(temporaryRoot, 'photolib.db'),
  }));
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  closeDb();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('integrated library API', () => {
  it('registers, scans and lists an external library without exposing host paths', async () => {
    const filePath = path.join(externalRoot, 'api-photo.jpg');
    await sharp({
      create: {
        width: 32,
        height: 24,
        channels: 3,
        background: { r: 40, g: 100, b: 180 },
      },
    }).jpeg().toFile(filePath);

    const availableResponse = await fetch(`${baseUrl}/api/libraries/available-roots`);
    expect(availableResponse.status).toBe(200);
    const available = await availableResponse.json() as {
      roots: Array<{ id: string; label: string; available: boolean }>;
    };
    expect(available.roots[0]).toMatchObject({ label: 'photos', available: true });
    expect(available.roots[0]).not.toHaveProperty('path');

    const createResponse = await fetch(`${baseUrl}/api/libraries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'API library',
        mode: 'external',
        roots: [{ rootId: available.roots[0].id }],
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json() as {
      library: { id: string; roots: unknown[]; capabilities: { canScan: boolean } };
    };
    expect(created.library.capabilities.canScan).toBe(true);
    expect(JSON.stringify(created)).not.toContain(externalRoot);

    const scanResponse = await fetch(
      `${baseUrl}/api/libraries/${created.library.id}/scans`,
      { method: 'POST' },
    );
    expect(scanResponse.status).toBe(202);
    const queued = await scanResponse.json() as { scan: { id: string } };
    const scan = await waitForScan(created.library.id, queued.scan.id);
    expect(scan).toMatchObject({ status: 'completed', added: 1 });

    const assetsResponse = await fetch(
      `${baseUrl}/api/libraries/${created.library.id}/assets?limit=10`,
    );
    expect(assetsResponse.status).toBe(200);
    const page = await assetsResponse.json() as {
      assets: Array<{ id: string; relativePath: string; status: string }>;
      libraryRevision: number;
    };
    expect(page.assets).toHaveLength(1);
    expect(page.assets[0]).toMatchObject({
      relativePath: 'api-photo.jpg',
      status: 'online',
    });
    expect(JSON.stringify(page)).not.toContain(externalRoot);

    const originalResponse = await fetch(
      `${baseUrl}/api/libraries/${created.library.id}/assets/${page.assets[0].id}/original`,
    );
    expect(originalResponse.status).toBe(200);
    expect(originalResponse.headers.get('content-type')).toContain('image/jpeg');
    const originalLength = (await originalResponse.arrayBuffer()).byteLength;
    expect(originalLength).toBeGreaterThan(10);

    const etag = originalResponse.headers.get('etag');
    expect(etag).toBeTruthy();
    const cachedOriginal = await fetch(
      `${baseUrl}/api/libraries/${created.library.id}/assets/${page.assets[0].id}/original`,
      { headers: { 'if-none-match': etag! } },
    );
    expect(cachedOriginal.status).toBe(304);

    const rangedOriginal = await fetch(
      `${baseUrl}/api/libraries/${created.library.id}/assets/${page.assets[0].id}/original`,
      { headers: { range: 'bytes=0-9' } },
    );
    expect(rangedOriginal.status).toBe(206);
    expect(rangedOriginal.headers.get('content-range')).toBe(`bytes 0-9/${originalLength}`);
    expect((await rangedOriginal.arrayBuffer()).byteLength).toBe(10);

    const thumbnailResponse = await fetch(
      `${baseUrl}/api/libraries/${created.library.id}/assets/${page.assets[0].id}/thumbnail?size=small`,
    );
    expect(thumbnailResponse.status).toBe(200);
    expect(thumbnailResponse.headers.get('content-type')).toContain('image/webp');
    expect((await thumbnailResponse.arrayBuffer()).byteLength).toBeGreaterThan(0);

    const changesResponse = await fetch(
      `${baseUrl}/api/libraries/${created.library.id}/assets/changes?afterRevision=0&limit=10`,
    );
    const changes = await changesResponse.json() as { assets: unknown[] };
    expect(changes.assets).toHaveLength(1);

    const deleteResponse = await fetch(
      `${baseUrl}/api/libraries/${created.library.id}`,
      { method: 'DELETE' },
    );
    expect(deleteResponse.status).toBe(204);
    expect((await fs.stat(filePath)).isFile()).toBe(true);
  });

  it('locates the library root of a legacy ServerPath directory without echoing the host path', async () => {
    const nested = path.join(externalRoot, 'legacy', '2025');
    await fs.mkdir(nested, { recursive: true });

    const response = await fetch(`${baseUrl}/api/libraries/locate-root`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: nested }),
    });
    expect(response.status).toBe(200);
    const located = await response.json() as { root: { label: string }; relativePath: string };
    expect(located.root.label).toBe('photos');
    expect(located.relativePath).toBe('legacy/2025');
    expect(JSON.stringify(located)).not.toContain(externalRoot);

    const refused = await fetch(`${baseUrl}/api/libraries/locate-root`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: temporaryRoot }),
    });
    expect(refused.status).toBe(403);
  });

  it('imports managed originals through staging and deduplicates by full checksum', async () => {
    const image = await sharp({
      create: {
        width: 18,
        height: 12,
        channels: 3,
        background: { r: 180, g: 70, b: 25 },
      },
    }).jpeg().toBuffer();
    const createLibrary = await fetch(`${baseUrl}/api/libraries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Managed API library', mode: 'managed' }),
    });
    expect(createLibrary.status).toBe(201);
    const { library } = await createLibrary.json() as {
      library: { id: string; capabilities: { canImport: boolean } };
    };
    expect(library.capabilities.canImport).toBe(true);

    const first = await importManagedFile(library.id, 'managed-photo.jpg', image);
    expect(first.duplicate).toBe(false);
    expect(first.asset).toMatchObject({
      name: 'managed-photo.jpg',
      status: 'online',
      mimeType: 'image/jpeg',
    });

    const duplicate = await importManagedFile(library.id, 'copy.jpg', image);
    expect(duplicate).toMatchObject({ duplicate: true });
    expect(duplicate.asset.id).toBe(first.asset.id);

    const assetsResponse = await fetch(
      `${baseUrl}/api/libraries/${library.id}/assets?limit=10`,
    );
    const page = await assetsResponse.json() as { assets: unknown[] };
    expect(page.assets).toHaveLength(1);

    const original = await fetch(
      `${baseUrl}/api/libraries/${library.id}/assets/${first.asset.id}/original`,
    );
    expect(original.status).toBe(200);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(image);

    const integrity = await fetch(
      `${baseUrl}/api/libraries/${library.id}/integrity-check`,
      { method: 'POST' },
    );
    expect(integrity.status).toBe(200);
    expect(await integrity.json()).toMatchObject({
      report: { checked: 1, valid: 1, missing: 0, changed: 0 },
    });

    const trash = await fetch(
      `${baseUrl}/api/libraries/${library.id}/assets/${first.asset.id}/trash`,
      { method: 'POST' },
    );
    expect(trash.status).toBe(200);
    expect(await trash.json()).toMatchObject({ asset: { status: 'trashed' } });
    expect((await fetch(
      `${baseUrl}/api/libraries/${library.id}/assets/${first.asset.id}/original`,
    )).status).toBe(409);

    const restore = await fetch(
      `${baseUrl}/api/libraries/${library.id}/assets/${first.asset.id}/restore`,
      { method: 'POST' },
    );
    expect(restore.status).toBe(200);
    expect(await restore.json()).toMatchObject({ asset: { status: 'online' } });
    expect((await fetch(
      `${baseUrl}/api/libraries/${library.id}/assets/${first.asset.id}/original`,
    )).status).toBe(200);

    expect((await fetch(
      `${baseUrl}/api/libraries/${library.id}/assets/${first.asset.id}/trash`,
      { method: 'POST' },
    )).status).toBe(200);
    // The "canonical" purge route from the implementation contract was never
    // built into a client; only the asset-scoped one below purges (F116).
    expect((await fetch(
      `${baseUrl}/api/libraries/${library.id}/trash/${first.asset.id}`,
      { method: 'DELETE' },
    )).status).toBe(404);
    expect((await fetch(
      `${baseUrl}/api/libraries/${library.id}/assets/${first.asset.id}/trash`,
      { method: 'DELETE' },
    )).status).toBe(204);
    expect((await fetch(
      `${baseUrl}/api/libraries/${library.id}/assets/${first.asset.id}`,
    )).status).toBe(404);
  });
});

async function importManagedFile(
  libraryId: string,
  fileName: string,
  content: Buffer,
): Promise<{
  duplicate: boolean;
  asset: { id: string; name: string; status: string; mimeType: string };
}> {
  const create = await fetch(`${baseUrl}/api/libraries/${libraryId}/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName, sizeBytes: content.byteLength }),
  });
  expect(create.status).toBe(201);
  const created = await create.json() as { import: { id: string } };

  const upload = await fetch(
    `${baseUrl}/api/libraries/${libraryId}/imports/${created.import.id}/content`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(content),
    },
  );
  expect(upload.status).toBe(200);

  const commit = await fetch(
    `${baseUrl}/api/libraries/${libraryId}/imports/${created.import.id}/commit`,
    { method: 'POST' },
  );
  expect(commit.status).toBe(200);
  return commit.json() as Promise<{
    duplicate: boolean;
    asset: { id: string; name: string; status: string; mimeType: string };
  }>;
}

async function waitForScan(libraryId: string, scanId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(
      `${baseUrl}/api/libraries/${libraryId}/scans/${scanId}`,
    );
    const body = await response.json() as { scan: Record<string, unknown> };
    if (['completed', 'failed', 'cancelled'].includes(String(body.scan.status))) {
      return body.scan;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for library scan');
}
