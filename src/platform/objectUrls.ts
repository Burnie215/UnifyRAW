/**
 * Release object URLs a view created.
 *
 * Only a `blob:` URL is ours to release. A source can hand back a plain http
 * URL (a thumbnail endpoint), and that one belongs to the server, not to this
 * document. Returns what was actually released, so a caller - or a test - can
 * name it instead of trusting a round trip.
 */
export function revokeBlobUrls(urls: Iterable<string | null | undefined>): string[] {
  const revoked: string[] = [];
  for (const url of urls) {
    if (typeof url === 'string' && url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
      revoked.push(url);
    }
  }
  return revoked;
}
