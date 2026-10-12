// Service worker: precaches the app shell so Folio opens with no network.
// Bump VERSION whenever any file in APP_SHELL changes.

const VERSION = 'folio-v1';
const APP_SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/epub.js',
  './js/reader.js',
  './js/zip.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations always get the app shell (the app routes via the URL hash).
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => cached || fetch(request)),
    );
    event.waitUntil(refresh('./index.html'));
    return;
  }

  // Cache first, then refresh in the background (stale-while-revalidate).
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const network = refresh(request);
      return cached || network.then((res) => res || Response.error());
    }),
  );
});

async function refresh(request) {
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await caches.open(VERSION);
      await cache.put(request, res.clone());
    }
    return res;
  } catch {
    return null;
  }
}
