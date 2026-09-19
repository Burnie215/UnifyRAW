/**
 * What a reachability check of a UnifyRAW server or sync hub found.
 *
 * Both the server field (config.backendUrl) and the hub field
 * (sync.serverUrl) ask the same question - "does something answer at this
 * address, and is it one of ours?" - so they ask it with the same functions
 * rather than with two copies that drift apart.
 */

export type ProbeState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok' }
  /**
   * `blocked` means the browser refused the call without giving the page a
   * reason. It is not proof of a misconfiguration - a dead host looks the
   * same - so the UI names the candidates instead of asserting one.
   */
  | { kind: 'failed'; detail: string; blocked: boolean }
  /** Something answered, but it is not a UnifyRAW backend. */
  | { kind: 'not-ours'; detail: string };

/** The health endpoint of `serverUrl`, with any trailing slashes removed. */
export function probeHealthUrl(serverUrl: string): string {
  return `${serverUrl.trim().replace(/\/+$/, '')}/api/health`;
}

/**
 * Read `GET /api/health`.
 *
 * A 200 is not enough. A static host answers every unknown path with
 * index.html, so pointing the hub field at an app address (app.unifyraw.com,
 * or any online-build deployment) yields 200 and a page - which would read as
 * "reachable" and then fail at the login with something unrelated. Only the
 * documented body counts, and `role` says which of the two deployments
 * answered: a full backend serves /api/sync beside everything else, a
 * SYNC_ONLY hub serves only it. Both are valid hubs.
 */
export function describeProbeResponse(
  ok: boolean,
  status: number,
  body: unknown,
): ProbeState {
  if (!ok) return { kind: 'failed', detail: `HTTP ${status}`, blocked: false };
  const role = healthRole(body);
  if (role === null) return { kind: 'not-ours', detail: `HTTP ${status}` };
  return { kind: 'ok' };
}

/** The `role` of a health response, or null when this is not one. */
export function healthRole(body: unknown): 'sync' | 'photolib' | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as { ok?: unknown; role?: unknown };
  if (record.ok !== true) return null;
  if (record.role === 'sync' || record.role === 'photolib') return record.role;
  // A backend from before /api/health carried a role still answers {ok:true}.
  return 'photolib';
}

/**
 * Turn a rejected fetch into a state.
 *
 * An aborted check is not a failure - the user navigated away or typed on, and
 * reporting it would overwrite the field with an error nobody caused. Anything
 * else is opaque: CORS, Private Network Access and an unreachable host all
 * arrive as the same TypeError.
 */
export function describeProbeError(error: unknown): ProbeState {
  if (isAbortError(error)) return { kind: 'idle' };
  return { kind: 'failed', detail: errorMessage(error), blocked: true };
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'AbortError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why an address cannot serve as a sync hub; `empty` means "no hub set". */
export type HubUrlRejection = 'empty' | 'invalid' | 'mixed-content';

export type HubUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: HubUrlRejection };

/**
 * Whether an address can be this catalog's sync hub.
 *
 * Deliberately not validateBackendUrl: that one refuses the page's own origin,
 * because in the online build our own origin is the static host and there is no
 * backend behind it. For a hub the same address is the normal case - the
 * self-hosted build serves /api/sync from the very origin the app was loaded
 * from, and defaultSyncSettings pre-fills exactly that.
 *
 * What still holds is mixed content: an HTTPS page may not call http:// at all,
 * which is the usual LAN server without a certificate.
 */
export function validateHubUrl(input: string, pageOrigin: string): HubUrlCheck {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  const target = parseUrl(trimmed);
  if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
    return { ok: false, reason: 'invalid' };
  }

  const page = parseUrl(pageOrigin);
  if (page?.protocol === 'https:' && target.protocol === 'http:') {
    return { ok: false, reason: 'mixed-content' };
  }

  return { ok: true, url: trimmed.replace(/\/+$/, '') };
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
