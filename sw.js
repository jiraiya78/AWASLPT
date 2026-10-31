/* AWAS Alert service worker — caches app shell + serves offline map tiles */
const APP_CACHE = "awas-app-v2";
const TILE_CACHE = "awas-tiles-v1";

const SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/app.js",
  "./js/geo.js",
  "./js/storage.js",
  "./js/offline.js",
  "./js/routing.js",
  "./js/search.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isOsmTile(url) {
  return /tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png/.test(url);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = req.url;

  // Map tiles: cache-first (filled by route prefetch + runtime)
  if (isOsmTile(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          return new Response("", { status: 504, statusText: "Offline tile miss" });
        }
      })
    );
    return;
  }

  // Same-origin app assets: stale-while-revalidate
  const sameOrigin = new URL(url).origin === self.location.origin;
  if (!sameOrigin) return;

  event.respondWith(
    caches.open(APP_CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
