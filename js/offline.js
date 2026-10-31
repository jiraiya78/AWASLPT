import { paddedBounds } from "./geo.js";

const TILE_CACHE = "awas-tiles-v1";
const APP_CACHE = "awas-app-v1";

/** OSM tile URL template (no API key). */
export const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return Promise.resolve(null);
  // Relative path works for both root and /repo/ github.io paths
  return navigator.serviceWorker.register("./sw.js").catch((err) => {
    console.warn("SW register failed", err);
    return null;
  });
}

function latLngToTile(lat, lng, zoom) {
  const n = 2 ** zoom;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

function tileUrl(z, x, y) {
  return TILE_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y);
}

/**
 * Prefetch OSM tiles covering a route corridor into Cache Storage.
 * Zooms 11–15 keep size reasonable for a phone.
 */
export async function cacheRouteTiles(points, options = {}) {
  const {
    padKm = 1.2,
    minZoom = 11,
    maxZoom = 15,
    onProgress = () => {},
  } = options;

  if (!points?.length) throw new Error("No route points");
  const bounds = paddedBounds(points, padKm);
  const urls = new Set();

  for (let z = minZoom; z <= maxZoom; z++) {
    const nw = latLngToTile(bounds.north, bounds.west, z);
    const se = latLngToTile(bounds.south, bounds.east, z);
    const x0 = Math.min(nw.x, se.x);
    const x1 = Math.max(nw.x, se.x);
    const y0 = Math.min(nw.y, se.y);
    const y1 = Math.max(nw.y, se.y);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        urls.add(tileUrl(z, x, y));
      }
    }
  }

  const list = [...urls];
  const cache = await caches.open(TILE_CACHE);
  let done = 0;
  const concurrency = 6;

  async function worker(queue) {
    while (queue.length) {
      const url = queue.shift();
      try {
        const hit = await cache.match(url);
        if (!hit) {
          const res = await fetch(url, { mode: "cors", credentials: "omit" });
          if (res.ok) await cache.put(url, res.clone());
        }
      } catch {
        /* skip failed tiles */
      }
      done += 1;
      onProgress(done, list.length);
    }
  }

  const queue = [...list];
  await Promise.all(
    Array.from({ length: concurrency }, () => worker(queue))
  );
  return { cached: list.length, bounds };
}

export async function clearTileCache() {
  await caches.delete(TILE_CACHE);
}

export { TILE_CACHE, APP_CACHE };
