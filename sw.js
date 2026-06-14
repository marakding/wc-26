// 90 — minimal PWA service worker.
// Network-first for the app shell (so deploys show up immediately, avoiding the
// stale-page problem), cache-first for static assets, with offline fallback.
const CACHE = 'wc26-v1';
const ASSETS = ['./', './index.html', './manifest.webmanifest',
  './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => k !== CACHE && caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App shell / navigations: network-first, fall back to cache when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((resp) => { const cp = resp.clone(); caches.open(CACHE).then((c) => c.put('./index.html', cp)); return resp; })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Same-origin static assets: cache-first.
  if (url.origin === location.origin && /\.(png|webmanifest|css|js|svg|woff2?)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((r) => r || fetch(req).then((resp) => {
        const cp = resp.clone();
        caches.open(CACHE).then((c) => c.put(req, cp));
        return resp;
      }))
    );
  }
  // Everything else (the football/commentary API) falls through to the network.
});
