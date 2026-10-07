/*
 * Service worker — the piece that makes this installable as a phone app.
 *
 * It is deliberately almost inert. The dashboard shows live CRM data behind a
 * session cookie, and a worker that caches any of that would hand one operator
 * another's leads, or show yesterday's conversations as if they were current.
 * So:
 *
 *   /api/*, /files/*  never touched — straight to the network, always.
 *   navigations       network first; the cached shell only answers when the
 *                     network fails, so a new deploy is live immediately.
 *   build assets      cache first — Vite fingerprints these filenames, so a
 *                     cached one can never be the wrong version.
 *
 * Bump CACHE when the shell changes shape; old caches are deleted on activate.
 */
const CACHE = 'turon-ai-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll is all-or-nothing: one 404 would abort the whole install and
      // leave the app with no worker at all.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Session-scoped and live. Never cached, never served from a cache.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE);
        return (
          (await cache.match('/index.html')) ??
          (await cache.match('/')) ??
          new Response('Oflayn — internetga ulaning.', {
            status: 503,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          })
        );
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((res) => {
          // Opaque and error responses are not worth storing, and storing an
          // opaque one silently eats quota.
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return res;
        }),
    ),
  );
});
