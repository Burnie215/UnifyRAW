import type { SourceConnectionError } from '../sources/connectionError';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Map structured failures to localized messages without exposing raw errors. */
export function sourceConnectionErrorMessage(
  error: SourceConnectionError,
  t: Translate,
): string {
  const options = {
    source: error.sourceName,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.headerLine === undefined ? {} : { headerLine: error.headerLine }),
  };

  switch (error.code) {
    case 'backend-auth-required':
      return t('sources.connectionProxyAuthRequired', options);
    case 'backend-admin-required':
      return t('sources.connectionProxyAdminRequired', options);
    case 'proxy-target-blocked':
      return t('sources.connectionProxyTargetBlocked', options);
    case 'proxy-upstream-failed':
      return t('sources.connectionProxyUpstreamFailed', options);
    case 'proxy-response-too-large':
      return t('sources.connectionProxyResponseTooLarge', options);
    case 'proxy-unreachable':
      return t('sources.connectionProxyUnreachable', options);
    case 'browser-network-error':
      return t('sources.connectionBrowserNetworkError', options);
    case 'browser-cors-blocked':
      return t('sources.connectionBrowserCorsBlocked', options);
    case 'browser-invalid-url':
      return t('sources.connectionBrowserInvalidUrl', options);
    case 'browser-https-required':
      return t('sources.connectionBrowserHttpsRequired', options);
    case 'source-invalid-response':
      return t('sources.connectionSourceInvalidResponse', options);
    case 'source-http-error':
      return t('sources.connectionSourceHttpError', options);
  }
}
