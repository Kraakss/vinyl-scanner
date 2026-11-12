// Service worker : rend l'appli installable et utilisable hors ligne (interface + historique).
// Stratégie "réseau d'abord" pour les fichiers de l'appli : une mise à jour publiée
// sur GitHub Pages est prise en compte dès la prochaine ouverture avec du réseau.
// Les appels à l'API Discogs ne sont jamais mis en cache ici.

const CACHE = 'vinyl-scanner-v4';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/discogs.js',
  './js/rarity.js',
  './js/scanner.js',
  './js/ocr.js',
  './js/collection.js',
  './js/refresh.js',
  './js/config.js',
  './js/core/ui.js',
  './js/core/backend.js',
  './js/core/job.js',
  './js/core/media.js',
  './js/games.js',
  './js/games-pricing.js',
  './js/dvd.js',
  './js/disney.js',
  './js/livecatno.js',
  './data/disney-classiques.json',
  './vendor/html5-qrcode.min.js',
  './vendor/papaparse.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // Discogs, CDN… : pas d'interception

  // « no-cache » : on demande toujours au serveur si le fichier a changé (réponse 304
  // très légère sinon). Évite de mélanger une nouvelle page avec d'anciens scripts.
  const fresh = req.mode === 'navigate' ? fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(req, { cache: 'no-cache' });
  event.respondWith(
    fresh
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});
