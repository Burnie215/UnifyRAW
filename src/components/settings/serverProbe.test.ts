import { describe, expect, it } from 'vitest';
import {
  describeProbeError,
  describeProbeResponse,
  healthRole,
  probeHealthUrl,
  validateHubUrl,
} from './serverProbe';

describe('probeHealthUrl', () => {
  it('appends the health path', () => {
    expect(probeHealthUrl('https://sync.example.com')).toBe('https://sync.example.com/api/health');
  });

  it('drops trailing slashes and surrounding space', () => {
    expect(probeHealthUrl('  https://sync.example.com//  ')).toBe('https://sync.example.com/api/health');
  });
});

describe('describeProbeResponse', () => {
  it('accepts a sync-only hub', () => {
    expect(describeProbeResponse(true, 200, { ok: true, role: 'sync' })).toEqual({ kind: 'ok' });
  });

  it('accepts a full backend, which serves /api/sync as well', () => {
    expect(describeProbeResponse(true, 200, { ok: true, role: 'photolib' })).toEqual({ kind: 'ok' });
  });

  it('accepts a backend from before health carried a role', () => {
    expect(describeProbeResponse(true, 200, { ok: true })).toEqual({ kind: 'ok' });
  });

  it('reports the status when the server refuses', () => {
    expect(describeProbeResponse(false, 502, null)).toEqual({
      kind: 'failed', detail: 'HTTP 502', blocked: false,
    });
  });

  // The case a bare status check misses: a static host answers every unknown
  // path with index.html, so an app address looks reachable and then fails at
  // the login for a reason that has nothing to do with the address.
  it('refuses a static host that answers 200 with a page', () => {
    expect(describeProbeResponse(true, 200, '<!doctype html><html></html>')).toEqual({
      kind: 'not-ours', detail: 'HTTP 200',
    });
  });

  it('refuses a JSON answer that is not a health response', () => {
    expect(describeProbeResponse(true, 200, { service: 'something-else' })).toEqual({
      kind: 'not-ours', detail: 'HTTP 200',
    });
  });

  it('refuses ok:false', () => {
    expect(describeProbeResponse(true, 200, { ok: false, role: 'sync' }).kind).toBe('not-ours');
  });
});

describe('healthRole', () => {
  it('names which deployment answered', () => {
    expect(healthRole({ ok: true, role: 'sync' })).toBe('sync');
    expect(healthRole({ ok: true, role: 'photolib' })).toBe('photolib');
  });

  it('is null for anything else', () => {
    expect(healthRole(null)).toBeNull();
    expect(healthRole('ok')).toBeNull();
    expect(healthRole({ ok: 'yes' })).toBeNull();
  });
});

describe('describeProbeError', () => {
  it('reports an opaque refusal as blocked', () => {
    expect(describeProbeError(new TypeError('Failed to fetch'))).toEqual({
      kind: 'failed', detail: 'Failed to fetch', blocked: true,
    });
  });

  // An abort is the user typing on or leaving, not a broken address.
  it('returns to idle on abort', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(describeProbeError(abort)).toEqual({ kind: 'idle' });
  });

  it('survives a non-Error rejection', () => {
    expect(describeProbeError('boom')).toEqual({ kind: 'failed', detail: 'boom', blocked: true });
  });
});

describe('validateHubUrl', () => {
  it('accepts an https hub on another domain', () => {
    expect(validateHubUrl('https://sync.example.com', 'https://app.unifyraw.com')).toEqual({
      ok: true, url: 'https://sync.example.com',
    });
  });

  // The difference from validateBackendUrl: the self-hosted build serves
  // /api/sync from the very origin the app was loaded from.
  it('accepts the page own origin, unlike the backend field', () => {
    expect(validateHubUrl('https://photos.example.com', 'https://photos.example.com')).toEqual({
      ok: true, url: 'https://photos.example.com',
    });
  });

  it('strips trailing slashes', () => {
    expect(validateHubUrl('https://sync.example.com/', 'https://app.unifyraw.com')).toEqual({
      ok: true, url: 'https://sync.example.com',
    });
  });

  it('refuses http from an https page', () => {
    expect(validateHubUrl('http://192.168.1.60:3000', 'https://app.unifyraw.com')).toEqual({
      ok: false, reason: 'mixed-content',
    });
  });

  it('allows http while the page itself is http', () => {
    expect(validateHubUrl('http://192.168.1.60:3000', 'http://localhost:5173').ok).toBe(true);
  });

  it('refuses a non-http scheme and gibberish', () => {
    expect(validateHubUrl('ftp://sync.example.com', 'https://app.unifyraw.com')).toEqual({
      ok: false, reason: 'invalid',
    });
    expect(validateHubUrl('sync.example.com', 'https://app.unifyraw.com')).toEqual({
      ok: false, reason: 'invalid',
    });
  });

  it('calls an empty field empty, not invalid', () => {
    expect(validateHubUrl('   ', 'https://app.unifyraw.com')).toEqual({ ok: false, reason: 'empty' });
  });
});
