import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseTrustProxy, warnForwardedWithoutTrustProxy } from './trust-proxy.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseTrustProxy', () => {
  it('reads an integer as the hop count, switches off for empty, 0 and false, and passes the rest', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12')).toBe('10.0.0.0/8, 172.16.0.0/12');
  });

  it('refuses boolean-sounding values instead of passing them to Express', () => {
    for (const word of ['true', 'TRUE', ' True ', 'on', 'yes', 'enabled']) {
      expect(() => parseTrustProxy(word), word).toThrow(/TRUST_PROXY/);
    }
    expect(parseTrustProxy('off')).toBe(false);
    expect(parseTrustProxy('no')).toBe(false);
  });

  it('documents what Express does with such a string: it throws where nobody can read it', () => {
    // express 5.2.1, measured: proxy-addr compiles the value in app.set().
    expect(() => express().set('trust proxy', 'true')).toThrow(/invalid IP address/);
  });

  it('makes Express take the client address from behind the given number of hops', async () => {
    // Cloudflare tunnel, then Traefik (the socket peer): the client is two hops out.
    const forwarded = '203.0.113.7, 198.51.100.2';
    expect(await clientAddress(parseTrustProxy('2'), forwarded)).toBe('203.0.113.7');
    expect(await clientAddress(parseTrustProxy('1'), forwarded)).toBe('198.51.100.2');
    expect(await clientAddress(parseTrustProxy('0'), forwarded)).toMatch(/127\.0\.0\.1$/);
  });
});

describe('warnForwardedWithoutTrustProxy', () => {
  it('warns once when forwarded requests arrive while trust proxy is off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await withApp(false, async (url) => {
      await fetch(url);
      expect(warn).not.toHaveBeenCalled();
      await fetch(url, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
      await fetch(url, { headers: { 'X-Forwarded-For': '203.0.113.8' } });
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TRUST_PROXY'));
  });

  it('stays quiet when trust proxy is set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await withApp(1, async (url) => {
      await fetch(url, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

async function clientAddress(trustProxy: boolean | number | string, forwarded: string): Promise<string> {
  let ip = '';
  await withApp(trustProxy, async (url) => {
    const response = await fetch(url, { headers: { 'X-Forwarded-For': forwarded } });
    ip = String((await response.json() as { ip: unknown }).ip);
  });
  return ip;
}

async function withApp(
  trustProxy: boolean | number | string,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.use(warnForwardedWithoutTrustProxy());
  app.get('/', (req, res) => res.json({ ip: req.ip }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
