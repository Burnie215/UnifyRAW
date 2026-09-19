/**
 * A browser tab can keep an older Vite entry bundle open across a deploy.
 * If it opens a lazy route afterwards, that bundle requests a content-hashed
 * chunk which is no longer present in the new image. Returning a tiny module
 * which reloads the document lets even pre-fix clients recover from that 404.
 */
export const STALE_ASSET_RECOVERY_MODULE = `
const key = 'photolib:stale-asset-reload';
let shouldReload = true;
try {
  const previous = Number(sessionStorage.getItem(key) || 0);
  shouldReload = !Number.isFinite(previous) || Date.now() - previous > 10000;
  if (shouldReload) sessionStorage.setItem(key, String(Date.now()));
} catch {}
if (shouldReload) window.location.reload();
throw new Error('PhotoLib was updated while this tab was open. Reloading the current version.');
`.trimStart();

export function isMissingJavaScriptAsset(pathname: string): boolean {
  return pathname.startsWith('/assets/') && /\.(?:js|mjs)$/i.test(pathname);
}
