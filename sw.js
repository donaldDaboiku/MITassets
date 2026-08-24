const CACHE = 'mit-asset-v27';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './js/main.js',
  './js/utils.js',
  './js/bridge.js',
  './js/state.js',
  './js/auth.js',
  './js/views.js',
  './js/reports-automation.js',
  './js/storage-ui.js',
  './js/cloud.js',
  './js/presence.js',
  './js/ui-core.js',
  './manifest.json',
  './icons/icon.svg',
];

function bypassServiceWorker(url) {
  const p = url.pathname.toLowerCase();
  // Live-reload / Five Server / tooling — must not be intercepted
  return (
    p.includes('fiveserver') ||
    p.includes('browser-sync') ||
    p.includes('live-server') ||
    p.includes('/.well-known/') ||
    p.includes('__vite') ||
    p.includes('@vite')
  );
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        ASSETS.map((url) => cache.add(url).catch(() => null))
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  let url;
  try {
    url = new URL(e.request.url);
  } catch (_) {
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (bypassServiceWorker(url)) return;

  const isAppFile =
    /\.(html|js|css|json|svg)$/i.test(url.pathname) ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html');

  if (isAppFile) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(e.request, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request).then(
            (cached) =>
              cached ||
              new Response('Offline', { status: 503, statusText: 'Offline' })
          )
        )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).catch(
        () => new Response('', { status: 503, statusText: 'Offline' })
      );
    })
  );
});
