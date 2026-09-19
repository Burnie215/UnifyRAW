/** Read the display name from a Sync-Hub session token without trusting it for authorization. */
export function syncTokenUsername(token: string | undefined): string | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  try {
    const base64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    return typeof payload.username === 'string' && payload.username.length > 0
      ? payload.username
      : null;
  } catch {
    return null;
  }
}
