// AP05 (F015) will change raw.ts; the contracts checked here (validation, policy) stay.
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import http, { type ClientRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SMART_PREVIEW_MAX_PX, smartPreviewFileName } from '@photolib/shared';
import { bodyTooLargeHandler } from '../middleware/body-errors.js';

const dcrawAvailable = spawnSync('which', ['dcraw_emu']).status === 0;

let raw: typeof import('./raw.js');
let temporaryRoot: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'unifyraw-raw-api-'));
  // raw.ts reads these at import time, so the module is loaded only after stubbing.
  vi.stubEnv('SMART_PREVIEW_DIR', path.join(temporaryRoot, 'smart-previews'));
  vi.stubEnv('RAW_MAX_UPLOAD_MB', '1');
  vi.stubEnv('RAW_ALLOW_PRIVATE_FETCH', 'false');
  vi.stubEnv('RAW_ALLOWED_PRIVATE_HOSTS', '');
  raw = await import('./raw.js');

  const app = express();
  app.use('/api/raw', raw.rawRouter);
  app.use(bodyTooLargeHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  vi.unstubAllEnvs();
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parsePreviewSize', () => {
  // The ceiling is the shared fact, not a number this file repeats: the
  // export's "native" request asks for exactly it, so a clamp that drifted
  // away from SMART_PREVIEW_MAX_PX would silently shrink every native export.
  it('clamps at the shared smart-preview ceiling', () => {
    expect(SMART_PREVIEW_MAX_PX).toBe(8000);
    expect(raw.parsePreviewSize(SMART_PREVIEW_MAX_PX + 1)).toBe(SMART_PREVIEW_MAX_PX);
  });

  it.each([
    [undefined, 1200],
    ['1200', 1200],
    ['1500.4', 1500],
    ['1500.6', 1501],
    [199, 200],
    [-5, 200],
    [200, 200],
    [8000, 8000],
    [8001, 8000],
    [12000, 8000],
    ['1e9', 8000],
    ['abc', 1200],
    [Infinity, 1200],
  ])('maps %s to %i', (input, expected) => {
    expect(raw.parsePreviewSize(input)).toBe(expected);
  });
});

describe('smart-preview decode size and cache version (F015)', () => {
  it('decodes at half size only up to 2540 px', () => {
    expect(raw.dcrawEmuArgs(1200)).toContain('-h');
    expect(raw.dcrawEmuArgs(raw.HALF_SIZE_MAX_PX)).toContain('-h');
    expect(raw.dcrawEmuArgs(raw.HALF_SIZE_MAX_PX + 1)).not.toContain('-h');
    expect(raw.dcrawEmuArgs(8000)).not.toContain('-h');
    expect(raw.dcrawEmuArgs(8000)).toEqual(['-T', '-6', '-g', '1', '1', '-w', '-o', '1']);
  });
});

describe('RAW decoder and calibration contracts (F070)', () => {
  it('uses only the decoder installed in the production image', () => {
    expect(raw.RAW_DECODE_TOOLS).toEqual(['dcraw_emu']);
  });

  it('bakes the same camera WB and sRGB output into both decoder paths', () => {
    expect(raw.DCRAW_EMU_COLOR).toEqual(['-w', '-o', '1']);
    expect(raw.dcrawEmuDecodeArgs('/tmp/input.raw')).toEqual([
      '-q', '3', '-w', '-o', '1', '/tmp/input.raw',
    ]);
    expect(raw.dcrawEmuArgs(8000)).toEqual([
      '-T', '-6', '-g', '1', '1', '-w', '-o', '1',
    ]);
  });

  it('copies descriptive metadata but no already-applied RAW calibration', () => {
    expect(raw.EXIFTOOL_COPY_TAGS).toEqual([
      '-Make', '-Model', '-ISO', '-FocalLength', '-Orientation',
    ]);
  });
});

describe('raw routes without a decoder', () => {
  it('requires a safe key and a url for smart-preview-from-url', async () => {
    const withoutKey = await postJson('/smart-preview-from-url', { url: 'https://photos.example/a.raf' });
    expect(withoutKey.status).toBe(400);

    const traversalKey = await postJson('/smart-preview-from-url', {
      url: 'https://photos.example/a.raf',
      key: '../../etc/passwd',
    });
    expect(traversalKey.status).toBe(400);

    const withoutUrl = await postJson('/smart-preview-from-url', { key: 'abc' });
    expect(withoutUrl.status).toBe(400);
    expect(await withoutUrl.json()).toEqual({ error: 'missing url' });
  });

  it('accepts only GET and POST as upstream method', async () => {
    const response = await postJson('/smart-preview-from-url', {
      url: 'https://photos.example/a.raf',
      key: 'abc',
      method: 'PUT',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'method must be GET or POST' });
  });

  it.each([
    ['http://127.0.0.1/x', 'Target IP address is not allowed'],
    ['http://[::1]/x', 'Target IP address is not allowed'],
    ['http://169.254.169.254/latest/meta-data', 'Target IP address is not allowed'],
    ['http://10.0.0.1/x', 'Target IP address is not allowed'],
    ['http://localhost/x', 'Target host is not allowed'],
    ['file:///etc/passwd', 'Only http(s) targets are allowed'],
    ['http://user:secret@photos.example/x', 'Credentials must be sent as headers, not in the URL'],
  ])('refuses the target %s with 403', async (url, error) => {
    const response = await postJson('/smart-preview-from-url', { url, key: 'abc' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error });
  });

  it.each(['/decode-binary', '/smart-preview?key=abc'])(
    'rejects an empty upload to %s with 400',
    async (segment) => {
      const response = await postBinary(segment, new Uint8Array(0));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'empty body' });
    },
  );

  it('no longer serves the dcraw-only /thumbnail and /decode routes', async () => {
    // Both called the `dcraw` binary, which the image never installed (F116).
    expect((await postBinary('/thumbnail', new Uint8Array([1]))).status).toBe(404);
    expect((await postBinary('/decode', new Uint8Array([1]))).status).toBe(404);
    // The route the client actually uses is still mounted.
    expect((await postBinary('/decode-binary', new Uint8Array(0))).status).toBe(400);
  });

  it('rejects smart-preview uploads without a valid key', async () => {
    expect((await postBinary('/smart-preview', new Uint8Array([1]))).status).toBe(400);
    expect((await postBinary('/smart-preview?key=a.b', new Uint8Array([1]))).status).toBe(400);
  });

  it('rejects uploads over RAW_MAX_UPLOAD_MB with 413', async () => {
    const response = await postBinary('/decode-binary', new Uint8Array(1024 * 1024 + 1));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'RAW upload is too large' });
  });

  it('answers 404 for an uncached smart preview and 400 for an invalid key', async () => {
    expect((await fetch(`${baseUrl}/api/raw/smart-preview/abc?size=1200`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/raw/smart-preview/a.b`)).status).toBe(400);
  });

  it('serves a cached preview over GET so the client never uploads the RAW (F054)', async () => {
    const key = 'source-1_photo-7';
    await fs.mkdir(path.join(temporaryRoot, 'smart-previews'), { recursive: true });
    await fs.writeFile(
      path.join(temporaryRoot, 'smart-previews', smartPreviewFileName(key, 1200, 'tiff')),
      'cached-tiff-bytes',
    );

    const response = await fetch(`${baseUrl}/api/raw/smart-preview/${key}?size=1200`);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache-Hit')).toBe('1');
    expect(response.headers.get('Content-Type')).toBe('image/tiff');
    expect(await response.text()).toBe('cached-tiff-bytes');
  });

  it('answers 413 for a smart-preview-from-url body over 8 KB', async () => {
    const response = await postJson('/smart-preview-from-url', {
      url: 'https://photos.example/a.raf',
      key: 'abc',
      headers: { Cookie: 'x'.repeat(9 * 1024) },
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload too large', code: 'body-too-large' });
  });

  it('cancels an active remote RAW fetch when the client disconnects', async () => {
    const upstreamResponse = Object.assign(new PassThrough(), {
      headers: {},
      statusCode: 200,
    });
    const upstreamRequest = new EventEmitter() as EventEmitter & {
      destroy: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      setTimeout: ReturnType<typeof vi.fn>;
    };
    const destroyRequest = vi.fn((error?: Error) => upstreamRequest.emit('error', error));
    upstreamRequest.destroy = destroyRequest;
    upstreamRequest.setTimeout = vi.fn();
    let respond!: (value: IncomingMessage) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    upstreamRequest.end = vi.fn(() => queueMicrotask(() => {
      respond(upstreamResponse as unknown as IncomingMessage);
      markStarted();
    }));
    vi.spyOn(http, 'request').mockImplementation(((
      _url: URL,
      _options: http.RequestOptions,
      callback: (value: IncomingMessage) => void,
    ) => {
      respond = callback;
      return upstreamRequest as unknown as ClientRequest;
    }) as typeof http.request);

    const controller = new AbortController();
    const clientResult = fetch(`${baseUrl}/api/raw/smart-preview-from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://8.8.8.8/slow.raf', key: 'abort-test' }),
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await started;
    upstreamResponse.write(Buffer.from('partial RAW'));
    controller.abort();

    await expect(clientResult).resolves.toMatchObject({ name: 'AbortError' });
    await expect.poll(() => destroyRequest.mock.calls.length, { timeout: 500 }).toBe(1);
    expect(upstreamResponse.destroyed).toBe(true);
  });
});

describe.skipIf(!dcrawAvailable)('raw routes with dcraw_emu', () => {
  it.todo('F015 /smart-preview with size=8000 keeps the full sensor resolution (no half-size decode above 2540 px)');
  it.todo('F105 /smart-preview-from-url still fetches and decodes a small JSON request after the per-router parser change');
});

function postJson(segment: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/raw${segment}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postBinary(segment: string, body: Uint8Array<ArrayBuffer>): Promise<Response> {
  return fetch(`${baseUrl}/api/raw${segment}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body,
  });
}
