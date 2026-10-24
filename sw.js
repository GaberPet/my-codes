// My Codes service worker: keeps the app itself available offline and makes it installable.
// Codes are never cached here; they come live from ntfy.
const CACHE = 'mycodes-v1';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'Code.gs', 'icon-192.png', 'icon-512.png',
  'maskable-192.png', 'maskable-512.png', 'logo-96.png', 'favicon.png', 'apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first, so updates show up right away; fall back to the cached copy when offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
