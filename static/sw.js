const CACHE = 'hikepath-v5';
const PRECACHE = [
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
  const url = new URL(e.request.url);

  if (
    e.request.method !== 'GET' ||
    url.hostname !== location.hostname ||
    url.pathname.startsWith('/api/') ||
    !url.pathname.startsWith('/static/')
  ) {
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
    )
  );
});
