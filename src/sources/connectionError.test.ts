import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubSelfhostBuild, unstubBuild } from '../test/build';
import { DirectSourceFetchError } from '../platform/sourceTransport';
import {
  classifySourceConnectionFailure,
  classifySourceConnectionResponse,
  SourceConnectionError,
} from './connectionError';
import { ImmichSource } from './ImmichSource';
import { ImmichV3Source } from './ImmichV3Source';
import { LycheeSource } from './LycheeSource';
import { sourceManager } from './SourceManager';
import { WebDAVSource } from './WebDAVSource';

beforeEach(() => {
  // These exercise the backend proxy, so they describe the selfhost build.
  stubSelfhostBuild();
});

afterEach(unstubBuild);

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('shared source connection response classification', () => {
  it.each(['Unauthorized', 'Invalid or expired token', 'Token revoked'])(
    'recognizes an exact PhotoLib proxy 401 (%s)',
    async (error) => {
      await expect(classifySourceConnectionResponse(
        jsonResponse(401, { error }),
        'server-proxy',
        'Family photos',
      )).resolves.toMatchObject({
        code: 'backend-auth-required',
        sourceName: 'Family photos',
        status: 401,
      });
    },
  );

  it('recognizes an exact PhotoLib administrator rejection', async () => {
    await expect(classifySourceConnectionResponse(
      jsonResponse(403, { error: 'Administrator access required' }),
      'server-proxy',
      'WebDAV',
    )).resolves.toMatchObject({ code: 'backend-admin-required', status: 403 });
  });

  it.each([
    'Invalid URL',
    'Only http(s) targets are allowed',
    'Credentials must be sent as headers, not in the URL',
    'Target host is not allowed',
    'Target IP address is not allowed',
    'Target hostname did not resolve',
    'Target hostname resolves to a disallowed address',
  ])('recognizes an exact NetworkTargetError proxy response (%s)', async (error) => {
    await expect(classifySourceConnectionResponse(
      jsonResponse(403, { error }),
      'server-proxy',
      'NAS',
    )).resolves.toMatchObject({ code: 'proxy-target-blocked', status: 403 });
  });

  it.each([
    ['Upstream request failed', 'proxy-upstream-failed'],
    ['Upstream response is too large', 'proxy-response-too-large'],
  ] as const)('recognizes the proxy failure %s', async (error, code) => {
    await expect(classifySourceConnectionResponse(
      jsonResponse(502, { error }),
      'server-proxy',
      'Lychee',
    )).resolves.toMatchObject({ code, status: 502 });
  });

  it.each([
    [401, { error: 'Unauthorized', message: 'Invalid API key' }],
    [403, { error: 'Target host is not allowed', detail: 'upstream payload' }],
    [403, { error: 'some other rejection' }],
    [502, { error: 'some other gateway response' }],
  ] as const)('does not mistake an upstream HTTP %s body for an exact backend error', async (status, body) => {
    await expect(classifySourceConnectionResponse(
      jsonResponse(status, body),
      'server-proxy',
      'Source',
    )).resolves.toMatchObject({ code: 'source-http-error', status });
  });

  it('never treats a browser-direct response as a PhotoLib backend response', async () => {
    await expect(classifySourceConnectionResponse(
      jsonResponse(401, { error: 'Unauthorized' }),
      'browser-direct',
      'Immich',
    )).resolves.toMatchObject({ code: 'source-http-error', status: 401 });
  });
});

describe('shared source connection network failure classification', () => {
  it('names the CORS header when a direct fetch has no response', () => {
    // The browser will not say why, but on a direct connection the missing
    // Access-Control-Allow-Origin is the cause the user can actually fix, so
    // the failure carries the exact line to paste (§P4).
    expect(classifySourceConnectionFailure(
      new TypeError('Failed to fetch'),
      'browser-direct',
      'WebDAV',
    )).toMatchObject({
      code: 'browser-cors-blocked',
      sourceName: 'WebDAV',
      status: undefined,
      headerLine: `Access-Control-Allow-Origin: ${window.location.origin}`,
    });
  });

  it.each([
    ['invalid-url', 'browser-invalid-url'],
    ['https-required', 'browser-https-required'],
  ] as const)('keeps local direct-fetch validation safe and specific (%s)', (causeCode, errorCode) => {
    expect(classifySourceConnectionFailure(
      new DirectSourceFetchError(causeCode),
      'browser-direct',
      'Lychee',
    )).toMatchObject({ code: errorCode, sourceName: 'Lychee', status: undefined });
  });

  it('distinguishes an unreachable PhotoLib proxy from direct browser failures', () => {
    expect(classifySourceConnectionFailure(
      new TypeError('Failed to fetch'),
      'server-proxy',
      'Immich',
    )).toEqual(new SourceConnectionError('proxy-unreachable', { sourceName: 'Immich' }));
  });
});

describe('provider connection error integration', () => {
  it.each([
    ['Immich v2', (label: string) => new ImmichSource('source', label, {
      serverUrl: 'https://photos.example.test', apiKey: 'secret', transport: 'server-proxy',
    })],
    ['Immich v3', (label: string) => new ImmichV3Source('source', label, {
      serverUrl: 'https://photos.example.test', apiKey: 'secret', transport: 'server-proxy',
    })],
  ] as const)('stores classified proxy errors for %s', async (_name, createSource) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(401, { error: 'Invalid or expired token' }),
    ));
    const source = createSource('My photos');

    await expect(source.connect()).resolves.toBe(false);
    expect(source.getConnectionError()).toMatchObject({
      code: 'backend-auth-required',
      sourceName: 'My photos',
      status: 401,
    });
  });

  it('classifies a WebDAV private-target block from the server proxy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(403, { error: 'Target hostname resolves to a disallowed address' }),
    ));
    const source = new WebDAVSource('source', 'Home NAS', {
      url: 'https://dav.home.test/photos',
      username: 'alice',
      password: 'secret',
      transport: 'server-proxy',
    });

    await expect(source.connect()).resolves.toBe(false);
    expect(source.getConnectionError()).toMatchObject({
      code: 'proxy-target-blocked',
      sourceName: 'Home NAS',
      status: 403,
    });
  });

  it('classifies a direct Lychee network/CORS failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const source = new LycheeSource('source', 'Gallery', {
      serverUrl: 'https://gallery.home.test',
      apiToken: 'secret',
      transport: 'browser-direct',
    });

    await expect(source.connect()).resolves.toBe(false);
    expect(source.getConnectionError()).toMatchObject({
      code: 'browser-cors-blocked',
      sourceName: 'Gallery',
    });
  });

  it('reports a successful but malformed Lychee response without leaking its body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));
    const source = new LycheeSource('source', 'Gallery', {
      serverUrl: 'https://gallery.home.test',
      apiToken: 'secret',
      transport: 'browser-direct',
    });

    await expect(source.connect()).resolves.toBe(false);
    expect(source.getConnectionError()).toMatchObject({
      code: 'source-invalid-response',
      sourceName: 'Gallery',
      status: 200,
    });
  });

  it('clears a previous error after a successful WebDAV retry', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 207 })));
    const source = new WebDAVSource('source', 'WebDAV', {
      url: 'https://dav.home.test/photos',
      username: 'alice',
      password: 'secret',
      transport: 'browser-direct',
    });

    await expect(source.connect()).resolves.toBe(false);
    expect(source.getConnectionError()).toMatchObject({ code: 'source-http-error', status: 404 });
    await expect(source.connect()).resolves.toBe(true);
    expect(source.getConnectionError()).toBeNull();
  });

  it('propagates the structured error while probing an album list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      jsonResponse(401, { error: 'Unauthorized' }),
    ));

    await expect(sourceManager.tryListAlbums('immich', {
      serverUrl: 'https://photos.example.test',
      apiKey: 'secret',
      transport: 'server-proxy',
    }, 'Travel library')).rejects.toMatchObject({
      code: 'backend-auth-required',
      sourceName: 'Travel library',
      status: 401,
    });
  });
});
