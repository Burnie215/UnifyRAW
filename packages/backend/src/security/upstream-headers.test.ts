import { describe, expect, it } from 'vitest';
import { isForwardableUpstreamHeader } from './upstream-headers.js';

describe('isForwardableUpstreamHeader', () => {
  it('forwards what the source providers authenticate and negotiate with', () => {
    // Immich, Piwigo, PhotoProm, SmugMug and Dropbox all authenticate through
    // one of these; WebDAV needs Depth, Destination and Overwrite.
    for (const [name, value] of [
      ['Authorization', 'Basic YWxpY2U6c2VjcmV0'],
      ['x-api-key', 'immich-key'],
      ['X-Immich-Checksum', 'abc'],
      ['X-Auth-Token', 'photoprism-session'],
      ['X-PIWIGO-API', 'piwigo-key'],
      ['Content-Type', 'application/json'],
      ['Accept', 'application/json'],
      ['Accept-Encoding', 'gzip'],
      ['Depth', '1'],
      ['Destination', 'https://dav.example/target.jpg'],
      ['Overwrite', 'T'],
      ['Dropbox-API-Arg', '{"path":"/a.jpg"}'],
    ]) {
      expect(isForwardableUpstreamHeader(name, value), name).toBe(true);
    }
  });

  it('never hands the client address or our own routing headers to the upstream', () => {
    for (const name of [
      'X-Forwarded-For',
      'x-forwarded-for',
      'X-Forwarded-Proto',
      'X-Forwarded-Host',
      'X-Real-IP',
      'X-Proxy-Url',
      'x-proxy-headers',
    ]) {
      expect(isForwardableUpstreamHeader(name, '203.0.113.7'), name).toBe(false);
    }
  });

  it('drops cookies, hop-by-hop headers and oversized entries', () => {
    expect(isForwardableUpstreamHeader('Cookie', 'session=secret')).toBe(false);
    expect(isForwardableUpstreamHeader('Host', 'internal.example')).toBe(false);
    expect(isForwardableUpstreamHeader('Connection', 'keep-alive')).toBe(false);
    expect(isForwardableUpstreamHeader('Proxy-Authorization', 'Basic x')).toBe(false);
    expect(isForwardableUpstreamHeader('Transfer-Encoding', 'chunked')).toBe(false);
    expect(isForwardableUpstreamHeader('User-Agent', 'curl/8')).toBe(false);
    expect(isForwardableUpstreamHeader('x'.repeat(129), 'v')).toBe(false);
    expect(isForwardableUpstreamHeader('X-Api-Key', 'v'.repeat(16_385))).toBe(false);
  });
});
