// Bump on protocol changes (NOT on every build — content-hashed assets
// are self-versioning). v2 (2026-05-19): switch to network-first for HTML
// so new bundles roll out without users getting stuck on stale index.html
// referencing dead asset hashes.
const CACHE_NAME = 'photolib-v2';

const HTML_ASSETS = ['/', '/index.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  // Don't pre-cache HTML — it'd just defeat network-first. Activate fast.
  self.skipWaiting();
  event.waitUntil(Promise.resolve());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API: always network, never cache.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req));
    return;
  }

  const isHtml = url.pathname === '/'
    || url.pathname.endsWith('.html')
    || HTML_ASSETS.includes(url.pathname)
    || (req.mode === 'navigate' && req.destination === 'document');

  if (isHtml) {
    // Network-first for HTML so a new index.html (with current asset hashes)
    // wins over the cached one. Fall back to cache only when offline.
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(req).then((cached) => cached ?? Response.error())),
    );
    return;
  }

  // Hashed static assets (/assets/index-*.js, *.css, fonts, …) are
  // immutable per content hash — cache-first is safe and fast.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return response;
      });
    }),
  );
});
