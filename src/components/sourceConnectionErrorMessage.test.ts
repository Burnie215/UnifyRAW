import { describe, expect, it, vi } from 'vitest';
import {
  SourceConnectionError,
  type SourceConnectionErrorCode,
} from '../sources/connectionError';
import { sourceConnectionErrorMessage } from './sourceConnectionErrorMessage';

describe('sourceConnectionErrorMessage', () => {
  it.each([
    ['backend-auth-required', 'sources.connectionProxyAuthRequired'],
    ['backend-admin-required', 'sources.connectionProxyAdminRequired'],
    ['proxy-target-blocked', 'sources.connectionProxyTargetBlocked'],
    ['proxy-upstream-failed', 'sources.connectionProxyUpstreamFailed'],
    ['proxy-response-too-large', 'sources.connectionProxyResponseTooLarge'],
    ['source-invalid-response', 'sources.connectionSourceInvalidResponse'],
    ['source-http-error', 'sources.connectionSourceHttpError'],
  ] as const)('maps HTTP error %s with source name and status', (code, expectedKey) => {
    const t = vi.fn((key: string) => key);
    const error = new SourceConnectionError(code, { sourceName: 'Home photos', status: 502 });

    expect(sourceConnectionErrorMessage(error, t)).toBe(expectedKey);
    expect(t).toHaveBeenCalledWith(expectedKey, { source: 'Home photos', status: 502 });
  });

  it.each([
    ['proxy-unreachable', 'sources.connectionProxyUnreachable'],
    ['browser-network-error', 'sources.connectionBrowserNetworkError'],
    ['browser-invalid-url', 'sources.connectionBrowserInvalidUrl'],
    ['browser-https-required', 'sources.connectionBrowserHttpsRequired'],
  ] as const)('maps response-less error %s without inventing an HTTP status', (code, expectedKey) => {
    const t = vi.fn((key: string) => key);
    const error = new SourceConnectionError(code as SourceConnectionErrorCode, { sourceName: 'NAS' });

    expect(sourceConnectionErrorMessage(error, t)).toBe(expectedKey);
    expect(t).toHaveBeenCalledWith(expectedKey, { source: 'NAS' });
  });
});
