import fs from 'node:fs';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS_POLICY, SELFHOST_CSP_DIRECTIVES, selfhostSecurityHeaders } from './csp.js';

const NGINX_HEADERS = fs.readFileSync(
  fileURLToPath(new URL('../../../../docker/online/security-headers.conf', import.meta.url)),
  'utf8',
);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(selfhostSecurityHeaders());
  app.get('/', (_req, res) => { res.send('ok'); });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe('self-hosted security headers', () => {
  it('declare the same CSP as the online build', () => {
    const fromConstant = Object.fromEntries(
      Object.entries(SELFHOST_CSP_DIRECTIVES).map(([name, sources]) => [name, [...sources].sort()]),
    );
    expect(fromConstant).toEqual(parsePolicy(nginxHeader('Content-Security-Policy')));
  });

  it('send that CSP and the Permissions-Policy on the wire', async () => {
    const response = await fetch(baseUrl);
    expect(parsePolicy(response.headers.get('content-security-policy') ?? ''))
      .toEqual(parsePolicy(nginxHeader('Content-Security-Policy')));
    expect(response.headers.get('permissions-policy')).toBe(nginxHeader('Permissions-Policy'));
  });

  // HSTS is the TLS terminator's call. From the app, under a host name and a
  // local CA, it turns a lost certificate authority into a year-long lockout.
  it('leave Strict-Transport-Security to whoever terminates TLS', async () => {
    const response = await fetch(baseUrl);
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  // The app fetch()es object URLs it created itself (preset thumbnails, node
  // previews, decoded RAW previews). Without blob: every preset tile showed
  // the unedited photo under this policy.
  it('let the app fetch its own object URLs', () => {
    expect(parsePolicy(nginxHeader('Content-Security-Policy'))['connect-src']).toContain('blob:');
  });

  it('declare the same Permissions-Policy as the online build', () => {
    expect(PERMISSIONS_POLICY).toBe(nginxHeader('Permissions-Policy'));
  });
});

function nginxHeader(name: string): string {
  const match = NGINX_HEADERS.match(new RegExp(`^add_header ${name} "([^"]*)"`, 'm'));
  if (!match) throw new Error(`security-headers.conf has no ${name}`);
  return match[1];
}

function parsePolicy(value: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const directive of value.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) directives[name.toLowerCase()] = sources.sort();
  }
  return directives;
}
