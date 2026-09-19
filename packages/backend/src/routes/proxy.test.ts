import { randomBytes } from 'node:crypto';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Router } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NetworkResponseTooLargeError,
  NetworkTargetError,
  requestNetworkBuffer,
} from '../security/network-target.js';
import { bodyTooLargeHandler } from '../middleware/body-errors.js';
import { proxyRouter } from './proxy.js';

// Loopback targets are forbidden by the target policy, so a local upstream
// server cannot stand in for the remote side.
vi.mock('../security/network-target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../security/network-target.js')>()),
  requestNetworkBuffer: vi.fn(),
}));

const upstream = vi.mocked(requestNetworkBuffer);
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  ({ server, baseUrl } = await listen(proxyRouter));
});

afterAll(async () => {
  await close(server);
});

beforeEach(() => {
  upstream.mockReset();
  upstream.mockResolvedValue({
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('upstream'),
  });
});

describe('proxy API wire contract', () => {
  it('answers 400, not 502, to a request without a JSON body', async () => {
    const response = await fetch(`${baseUrl}/api/proxy/`, { method: 'POST' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing url' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects a request without url', async () => {
    const response = await postJson(baseUrl, '/', { method: 'GET' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing url' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects methods outside the allowlist', async () => {
    const response = await postJson(baseUrl, '/', { url: 'https://dav.example/', method: 'TRACE' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Method not allowed' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards only allowlisted headers and mirrors the upstream response', async () => {
    upstream.mockResolvedValue({
      status: 207,
      headers: { 'content-type': 'application/xml' },
      body: Buffer.from('<multistatus/>'),
    });

    const response = await postJson(baseUrl, '/', {
      url: 'https://dav.example/remote.php/dav',
      method: 'propfind',
      headers: {
        Cookie: 'session=secret',
        Host: 'internal.example',
        'X-Forwarded-For': '203.0.113.7',
        'X-Real-IP': '203.0.113.7',
        'X-Proxy-Url': 'https://elsewhere.example/',
        Authorization: 'Basic YWxpY2U6c2VjcmV0',
        'X-Api-Key': 'key',
        Depth: '1',
      },
      requestBody: '<propfind/>',
    });

    expect(response.status).toBe(207);
    expect(response.headers.get('content-type')).toContain('application/xml');
    expect(await response.text()).toBe('<multistatus/>');
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, options] = upstream.mock.calls[0];
    expect(url).toBe('https://dav.example/remote.php/dav');
    expect(options.method).toBe('PROPFIND');
    expect(options.body).toBe('<propfind/>');
    expect(options.headers).toEqual({
      Authorization: 'Basic YWxpY2U6c2VjcmV0',
      'X-Api-Key': 'key',
      Depth: '1',
    });
  });

  it('answers 403 when the target policy rejects the url', async () => {
    upstream.mockRejectedValue(new NetworkTargetError('Target IP address is not allowed'));
    const response = await postJson(baseUrl, '/', { url: 'http://127.0.0.1/' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Target IP address is not allowed' });
  });

  it('answers 502 when the upstream response exceeds the response limit', async () => {
    upstream.mockRejectedValue(new NetworkResponseTooLargeError('too large'));
    const response = await postJson(baseUrl, '/', { url: 'https://dav.example/big' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Upstream response is too large' });
  });

  it('aborts an active upstream request when the proxy client disconnects', async () => {
    let markStarted!: (signal: AbortSignal | undefined) => void;
    const started = new Promise<AbortSignal | undefined>((resolve) => {
      markStarted = resolve;
    });
    upstream.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      markStarted(options.signal);
      options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }));

    const client = http.request(`${baseUrl}/api/proxy/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    client.on('error', () => {});
    client.end(JSON.stringify({ url: 'https://dav.example/slow' }));

    const signal = await started;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    client.destroy();

    await expect.poll(() => signal?.aborted, { timeout: 500 }).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.todo('F028 ocs-apirequest (Nextcloud OCS) is forwarded by the header filter');
});

describe('binary proxy wire contract', () => {
  it('rejects a binary request without X-Proxy-Url', async () => {
    const response = await postBinary(baseUrl, new Uint8Array([1, 2, 3]), {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Missing X-Proxy-Url' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects binary methods other than POST, PUT and PATCH', async () => {
    const response = await postBinary(baseUrl, new Uint8Array([1]), {
      'X-Proxy-Url': 'https://content.dropboxapi.example/upload',
      'X-Proxy-Method': 'GET',
    });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards the body bytes verbatim and filters X-Proxy-Headers', async () => {
    const body = randomBytes(64 * 1024);
    const response = await postBinary(baseUrl, new Uint8Array(body), {
      'X-Proxy-Url': 'https://content.dropboxapi.example/2/files/upload',
      'X-Proxy-Method': 'put',
      'X-Proxy-Headers': encodeHeaders({
        Cookie: 'session=secret',
        Host: 'internal.example',
        Authorization: 'Bearer token',
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': '{"path":"/a.jpg"}',
      }),
    });

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, options] = upstream.mock.calls[0];
    expect(url).toBe('https://content.dropboxapi.example/2/files/upload');
    expect(options.method).toBe('PUT');
    expect(Buffer.isBuffer(options.body) && options.body.equals(body)).toBe(true);
    expect(options.headers).toEqual({
      Authorization: 'Bearer token',
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': '{"path":"/a.jpg"}',
    });
  });

  it('rejects X-Proxy-Headers that are not base64 JSON', async () => {
    const response = await postBinary(baseUrl, new Uint8Array([1]), {
      'X-Proxy-Url': 'https://content.dropboxapi.example/upload',
      'X-Proxy-Headers': Buffer.from('not json').toString('base64'),
    });
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('proxy body limits from the environment', () => {
  let limitedServer: Server;
  let limitedUrl: string;
  let limitedUpstream: typeof upstream;

  beforeAll(async () => {
    vi.stubEnv('PROXY_MAX_BODY_MB', '1');
    vi.stubEnv('PROXY_MAX_JSON_BODY_MB', '1');
    vi.resetModules();
    const network = await import('../security/network-target.js');
    const limited = await import('./proxy.js');
    limitedUpstream = vi.mocked(network.requestNetworkBuffer);
    limitedUpstream.mockResolvedValue({ status: 200, headers: {}, body: Buffer.alloc(0) });
    ({ server: limitedServer, baseUrl: limitedUrl } = await listen(limited.proxyRouter));
  });

  afterAll(async () => {
    await close(limitedServer);
    vi.unstubAllEnvs();
  });

  it('enforces PROXY_MAX_BODY_MB on binary uploads', async () => {
    const headers = { 'X-Proxy-Url': 'https://content.dropboxapi.example/upload' };
    const atLimit = await postBinary(limitedUrl, new Uint8Array(1024 * 1024), headers);
    expect(atLimit.status).toBe(200);
    expect(limitedUpstream).toHaveBeenCalledTimes(1);

    const overLimit = await postBinary(limitedUrl, new Uint8Array(1024 * 1024 + 1), headers);
    expect(overLimit.status).toBe(413);
    expect(limitedUpstream).toHaveBeenCalledTimes(1);
  });

  it('enforces PROXY_MAX_JSON_BODY_MB on string request bodies', async () => {
    limitedUpstream.mockClear();
    const response = await postJson(limitedUrl, '/', {
      url: 'https://dav.example/upload',
      method: 'PUT',
      requestBody: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Proxy request body is too large' });
    expect(limitedUpstream).not.toHaveBeenCalled();
  });

  it('refuses a JSON envelope far beyond PROXY_MAX_JSON_BODY_MB in the parser', async () => {
    limitedUpstream.mockClear();
    const response = await postJson(limitedUrl, '/', {
      url: 'https://dav.example/upload',
      method: 'PUT',
      requestBody: 'x'.repeat(3 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload too large', code: 'body-too-large' });
    expect(limitedUpstream).not.toHaveBeenCalled();
  });
});

async function listen(router: Router): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use('/api/proxy', router);
  app.use(bodyTooLargeHandler);
  const created = http.createServer(app);
  await new Promise<void>((resolve) => created.listen(0, '127.0.0.1', resolve));
  return { server: created, baseUrl: `http://127.0.0.1:${(created.address() as AddressInfo).port}` };
}

async function close(target: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    target.close((error) => error ? reject(error) : resolve());
  });
}

function postJson(origin: string, segment: string, body: unknown): Promise<Response> {
  return fetch(`${origin}/api/proxy${segment}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postBinary(origin: string, body: Uint8Array<ArrayBuffer>, headers: Record<string, string>): Promise<Response> {
  return fetch(`${origin}/api/proxy/binary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...headers },
    body,
  });
}

function encodeHeaders(headers: Record<string, string>): string {
  return Buffer.from(JSON.stringify(headers)).toString('base64');
}
