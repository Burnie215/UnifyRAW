export interface ResolvedDavHref {
  /** Canonical absolute URL. Path segments are encoded exactly once. */
  url: string;
  /** Decoded path relative to the configured WebDAV root. */
  relativePath: string;
  name: string;
  isRoot: boolean;
}

function decodePathSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new Error(`Invalid percent encoding in WebDAV path segment: ${segment}`);
  }

  if (decoded === '.' || decoded === '..') {
    throw new Error('WebDAV paths must not contain dot segments');
  }
  if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
    throw new Error('WebDAV path contains an ambiguous encoded separator');
  }
  return decoded;
}

function decodedPathSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map(decodePathSegment);
}

function encodedPath(segments: readonly string[], trailingSlash: boolean): string {
  const path = `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  return trailingSlash && path !== '/' ? `${path}/` : path;
}

function parseHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error('WebDAV URL must be an absolute HTTP(S) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WebDAV URL must use HTTP or HTTPS');
  }
  if (url.username || url.password) {
    throw new Error('Put WebDAV credentials in the username and password fields');
  }
  if (url.search || url.hash) {
    throw new Error('WebDAV URL must not contain a query string or fragment');
  }
  return url;
}

/** Returns a canonical absolute root URL with an encoded path and trailing slash. */
export function normalizeDavRootUrl(rawUrl: string, legacyBasePath?: string): string {
  const url = parseHttpUrl(rawUrl);
  const rootSegments = decodedPathSegments(url.pathname);
  if (legacyBasePath) rootSegments.push(...normalizeDavRelativePath(legacyBasePath).split('/').filter(Boolean));
  url.pathname = encodedPath(rootSegments, true);
  return url.toString();
}

/** Normalizes a decoded, root-relative DAV path without changing its characters. */
export function normalizeDavRelativePath(path: string): string {
  if (path.includes('\\') || path.includes('\0')) {
    throw new Error('Invalid WebDAV relative path');
  }
  const segments = path.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new Error('WebDAV paths must not contain dot segments');
    }
  }
  return segments.join('/');
}

/** Builds an absolute URL below the configured root, encoding every segment once. */
export function buildDavResourceUrl(
  rootUrl: string,
  relativePath = '',
  directory = false,
): string {
  const root = new URL(normalizeDavRootUrl(rootUrl));
  const rootSegments = decodedPathSegments(root.pathname);
  const relativeSegments = normalizeDavRelativePath(relativePath).split('/').filter(Boolean);
  root.pathname = encodedPath([...rootSegments, ...relativeSegments], directory || relativeSegments.length === 0);
  return root.toString();
}

/**
 * Resolves a DAV `href` safely. Cross-origin and outside-root targets are
 * rejected so callers can never forward the source Authorization header to
 * an address selected by a remote XML response.
 */
export function resolveDavHref(rootUrl: string, requestUrl: string, href: string): ResolvedDavHref {
  const root = new URL(normalizeDavRootUrl(rootUrl));
  let resolved: URL;
  try {
    resolved = new URL(href.trim(), requestUrl);
  } catch {
    throw new Error('Invalid WebDAV href');
  }

  if (resolved.origin !== root.origin) {
    throw new Error('WebDAV href points to a different origin');
  }
  if (resolved.search || resolved.hash) {
    throw new Error('WebDAV href must not contain a query string or fragment');
  }

  const rootSegments = decodedPathSegments(root.pathname);
  const targetSegments = decodedPathSegments(resolved.pathname);
  const isBelowRoot = rootSegments.every((segment, index) => targetSegments[index] === segment);
  if (!isBelowRoot || targetSegments.length < rootSegments.length) {
    throw new Error('WebDAV href points outside the configured root');
  }

  const relativeSegments = targetSegments.slice(rootSegments.length);
  const trailingSlash = resolved.pathname.endsWith('/');
  resolved.pathname = encodedPath(targetSegments, trailingSlash);
  const relativePath = relativeSegments.join('/');
  return {
    url: resolved.toString(),
    relativePath,
    name: relativeSegments.at(-1) ?? '',
    isRoot: relativeSegments.length === 0,
  };
}
