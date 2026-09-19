import { vi } from 'vitest';

/**
 * Which build a test describes.
 *
 * Node tests run without a `window` and without VITE_MODE, which resolves to
 * "online build, no backend" — there `apiFetch` refuses every call to our own
 * origin (ONLINE_MODE_PLAN §P5) and the RAW decoder drops smart-preview (§P3).
 * A test that exercises the backend proxy or a server-decoded preview has to
 * say so.
 *
 * Both helpers set VITE_MODE the way build:selfhost and build:online do. The
 * legacy window flag is covered once, in platform/config.test.ts.
 *
 * Pair with `afterEach(unstubBuild)`.
 */
export function stubSelfhostBuild(origin = 'https://app.test'): void {
  vi.stubEnv('VITE_MODE', 'hosted');
  vi.stubGlobal('window', { location: { origin } });
}

export function stubOnlineBuild(origin = 'https://app.test'): void {
  vi.stubEnv('VITE_MODE', 'online');
  vi.stubGlobal('window', { location: { origin } });
}

export function unstubBuild(): void {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
}
