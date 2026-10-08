/* TeQx service worker: app shell + offline fallback.
   Bump VERSION whenever you deploy a new index.html so users get the update. */
const VERSION = 'teqx-v1';
const SHELL = [
  './', 'index.html', 'manifest.json',
  'icons/favicon.ico', 'icons/apple-touch-icon.png',
  'icons/icon-192.png', 'icons/icon-512.png',
  'icons/teqx-192.png', 'icons/teqx-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const keep = (res) => res && (res.ok || res.type === 'basic') && res.type !== 'opaque';

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || !/^https?:$/.test(url.protocol)) return;
  if (url.pathname.includes('/api/')) return;          // never cache orders, stores, products
  if (url.hostname === 'images.unsplash.com') return;  // let the browser cache photos

  // Opening the app: try the network first, fall back to the saved copy when offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put('index.html', copy)); return res; })
        .catch(() => caches.match('index.html').then(r => r || caches.match('./')))
    );
    return;
  }

  // Icons, manifest, React/Babel scripts and fonts: serve saved copy, refresh in background
  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req)
        .then(res => { if (keep(res)) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return res; })
        .catch(() => hit);
      return hit || net;
    })
  );
});
