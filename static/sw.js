const CACHE = 'hikepath-v1';
const PRECACHE = [
  '/',
  '/static/css/style.css',
  '/static/js/app.js',
  '/static/js/map.js',
  '/static/js/navigate.js',
  '/static/manifest.json',
  '/static/icons/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network-first for API and map tiles; cache-first for static assets
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.hostname !== location.hostname) {
    return; // pass through
  }
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
