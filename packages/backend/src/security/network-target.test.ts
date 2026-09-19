import { EventEmitter, getEventListeners } from 'node:events';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  areResolvedAddressesAllowed,
  classifyNetworkAddress,
  isAddressAllowed,
  parseNetworkTarget,
  parsePrivateHostAllowlist,
  requestNetworkBuffer,
} from './network-target.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('network target policy', () => {
  it('classifies public, private and sensitive IPv4 addresses', () => {
    expect(classifyNetworkAddress('8.8.8.8')).toBe('public');
    expect(classifyNetworkAddress('10.2.3.4')).toBe('private');
    expect(classifyNetworkAddress('192.168.1.5')).toBe('private');
    expect(classifyNetworkAddress('127.0.0.1')).toBe('forbidden');
    expect(classifyNetworkAddress('169.254.169.254')).toBe('forbidden');
    expect(classifyNetworkAddress('100.64.0.1')).toBe('forbidden');
  });

  it('handles IPv6 ULA, loopback and IPv4-mapped forms', () => {
    expect(classifyNetworkAddress('2606:4700:4700::1111')).toBe('public');
    expect(classifyNetworkAddress('fd00::1')).toBe('private');
    expect(classifyNetworkAddress('::1')).toBe('forbidden');
    expect(classifyNetworkAddress('::ffff:127.0.0.1')).toBe('forbidden');
    expect(classifyNetworkAddress('::ffff:192.168.1.1')).toBe('private');
  });

  it('requires an explicit policy for private networks', () => {
    expect(isAddressAllowed('192.168.1.5', { allowPrivate: false })).toBe(false);
    expect(isAddressAllowed('192.168.1.5', { allowPrivate: true })).toBe(true);
    expect(isAddressAllowed('169.254.169.254', { allowPrivate: true })).toBe(false);
  });

  it('allows private addresses only for exact allowlisted hostnames', () => {
    const policy = {
      allowPrivate: false,
      allowedPrivateHosts: parsePrivateHostAllowlist(
        'Immich.Home.ARPA., nas.internal, immich.home.arpa',
      ),
    };

    expect([...policy.allowedPrivateHosts]).toEqual(['immich.home.arpa', 'nas.internal']);
    expect(isAddressAllowed('192.168.1.5', policy, 'immich.home.arpa')).toBe(true);
    expect(isAddressAllowed('fd00::12', policy, 'IMMICH.HOME.ARPA.')).toBe(true);
    expect(isAddressAllowed('192.168.1.5', policy, 'other.home.arpa')).toBe(false);
    expect(isAddressAllowed('192.168.1.5', policy, 'photos.immich.home.arpa')).toBe(false);
    expect(isAddressAllowed('192.168.1.5', policy, 'evilimmich.home.arpa')).toBe(false);
  });

  it('never lets an allowlisted hostname enable forbidden address classes', () => {
    const hostname = 'immich.home.arpa';
    const policy = {
      allowPrivate: false,
      allowedPrivateHosts: parsePrivateHostAllowlist(hostname),
    };

    expect(isAddressAllowed('127.0.0.1', policy, hostname)).toBe(false);
    expect(isAddressAllowed('169.254.169.254', policy, hostname)).toBe(false);
    expect(isAddressAllowed('100.64.0.1', policy, hostname)).toBe(false);
    expect(isAddressAllowed('::1', policy, hostname)).toBe(false);
    expect(isAddressAllowed('fe80::1', policy, hostname)).toBe(false);
    expect(isAddressAllowed('::ffff:169.254.169.254', policy, hostname)).toBe(false);
  });

  it('rejects a DNS answer set when any address violates the target policy', () => {
    const hostname = 'immich.home.arpa';
    const policy = {
      allowPrivate: false,
      allowedPrivateHosts: parsePrivateHostAllowlist(hostname),
    };

    expect(areResolvedAddressesAllowed(['192.168.1.5', 'fd00::12'], policy, hostname)).toBe(true);
    expect(areResolvedAddressesAllowed(['192.168.1.5', '169.254.169.254'], policy, hostname)).toBe(false);
    expect(areResolvedAddressesAllowed([], policy, hostname)).toBe(false);
  });

  it('rejects IP literals, wildcards and URL-shaped allowlist entries', () => {
    for (const value of [
      '192.168.1.5',
      '::ffff:192.168.1.5',
      '*.home.arpa',
      'https://immich.home.arpa',
      'immich.home.arpa:2283',
      'user@immich.home.arpa',
      'localhost',
      'metadata.google.internal',
    ]) {
      expect(() => parsePrivateHostAllowlist(value)).toThrow('Invalid private-target hostname');
    }
  });

  it('does not apply the hostname allowlist to literal private-IP URLs', () => {
    const policy = {
      allowPrivate: false,
      allowedPrivateHosts: parsePrivateHostAllowlist('immich.home.arpa'),
    };

    expect(() => parseNetworkTarget('http://192.168.1.5:2283/', policy)).toThrow(
      'Target IP address is not allowed',
    );
  });

  it('rejects sensitive hostnames, URL credentials, and non-HTTP schemes', () => {
    const policy = { allowPrivate: false };
    expect(() => parseNetworkTarget('http://localhost/admin', policy)).toThrow('not allowed');
    expect(() => parseNetworkTarget('http://LOCALHOST./admin', policy)).toThrow('not allowed');
    expect(() => parseNetworkTarget('http://metadata.google.internal/', policy)).toThrow('not allowed');
    expect(() => parseNetworkTarget('https://alice:secret@example.com/', policy)).toThrow('headers');
    expect(() => parseNetworkTarget('file:///etc/passwd', policy)).toThrow('http(s)');
  });
});

describe('network request cancellation', () => {
  it('destroys an active upstream request and response when aborted', async () => {
    const response = fakeResponse();
    const destroyResponse = vi.spyOn(response, 'destroy');
    const { request, destroyRequest } = mockHttpRequest(response);
    const controller = new AbortController();
    const pending = requestNetworkBuffer('http://8.8.8.8/image.raw', {
      timeoutMs: 60_000,
      maxResponseBytes: 1024,
      policy: { allowPrivate: false },
      signal: controller.signal,
    });

    await request.end.mock.results[0].value;
    response.write(Buffer.from('partial'));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(destroyRequest).toHaveBeenCalledTimes(1);
    expect(destroyResponse).toHaveBeenCalled();
    expect(destroyResponse.mock.calls[0][0]).toMatchObject({ name: 'AbortError' });
  });

  it('removes the abort listener after a response completes', async () => {
    const response = fakeResponse();
    const { request } = mockHttpRequest(response);
    const controller = new AbortController();
    const pending = requestNetworkBuffer('http://8.8.8.8/image.raw', {
      timeoutMs: 60_000,
      maxResponseBytes: 1024,
      policy: { allowPrivate: false },
      signal: controller.signal,
    });

    await request.end.mock.results[0].value;
    response.end(Buffer.from('complete'));
    await expect(pending).resolves.toMatchObject({ body: Buffer.from('complete') });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});

function fakeResponse(): PassThrough & Pick<IncomingMessage, 'headers' | 'statusCode'> {
  return Object.assign(new PassThrough(), {
    headers: {},
    statusCode: 200,
  });
}

function mockHttpRequest(
  response: PassThrough & Pick<IncomingMessage, 'headers' | 'statusCode'>,
): {
  request: EventEmitter & { end: ReturnType<typeof vi.fn> };
  destroyRequest: ReturnType<typeof vi.fn>;
} {
  const request = new EventEmitter() as EventEmitter & {
    destroy: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    setTimeout: ReturnType<typeof vi.fn>;
  };
  const destroyRequest = vi.fn((error?: Error) => request.emit('error', error));
  request.destroy = destroyRequest;
  request.end = vi.fn(() => new Promise<void>((resolve) => {
    queueMicrotask(() => {
      responseCallback(response as unknown as IncomingMessage);
      resolve();
    });
  }));
  request.setTimeout = vi.fn();

  let responseCallback!: (value: IncomingMessage) => void;
  vi.spyOn(http, 'request').mockImplementation(((
    _url: URL,
    _options: http.RequestOptions,
    callback: (value: IncomingMessage) => void,
  ) => {
    responseCallback = callback;
    return request as unknown as ClientRequest;
  }) as typeof http.request);
  return { request, destroyRequest };
}
