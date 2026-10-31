import { formatDistance } from "./geo.js";

const OSRM_BASE = "https://router.project-osrm.org";

/**
 * Snap a GPS point to the nearest drivable road.
 */
export async function snapToRoad(point) {
  const url = `${OSRM_BASE}/nearest/v1/driving/${point.lng},${point.lat}?number=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nearest failed (${res.status})`);
  const data = await res.json();
  if (data.code !== "Ok" || !data.waypoints?.[0]) {
    throw new Error("Could not snap to road");
  }
  const wp = data.waypoints[0];
  const [lng, lat] = wp.location;
  return { lat, lng, name: wp.name || null, distance: wp.distance };
}

function parseOsrmRoutes(data) {
  if (data.code !== "Ok" || !data.routes?.length) {
    throw new Error(data.message || data.code || "No routes found");
  }
  return data.routes.map((route, i) => {
    const points = (route.geometry?.coordinates || []).map(([lng, lat]) => ({
      lat,
      lng,
    }));
    if (points.length < 2) {
      throw new Error("Route geometry too short");
    }
    return {
      id: `route_${i}_${Math.round(route.distance)}`,
      distance: route.distance,
      duration: route.duration,
      points,
      summary: routeLabel(route.distance, route.duration, i),
    };
  });
}

/**
 * Fetch driving routes. Tries snapped coords, then raw, then straight fallback.
 * Always returns at least one route option.
 */
export async function fetchRoutes(origin, destination, options = {}) {
  const { vias = [], preferAlternatives = true } = options;

  const attempts = [];

  // 1) Snap both ends to road network (fixes many "NoRoute" cases)
  try {
    const [o, d] = await Promise.all([
      snapToRoad(origin),
      snapToRoad(destination),
    ]);
    attempts.push({ origin: o, destination: d, label: "snapped" });
  } catch {
    /* continue */
  }

  // 2) Raw coordinates
  attempts.push({ origin, destination, label: "raw" });

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const routes = await requestOsrm(
        attempt.origin,
        attempt.destination,
        vias,
        preferAlternatives
      );
      if (routes.length) return routes;
    } catch (err) {
      lastError = err;
      console.warn(`OSRM ${attempt.label} failed:`, err.message);
    }
  }

  // 3) Straight-line fallback — always gives the user an option
  console.warn("Using straight-line route fallback", lastError?.message);
  return straightRoute(origin, destination);
}

async function requestOsrm(origin, destination, vias, preferAlternatives) {
  const parts = [
    origin,
    ...vias.filter((v) => v && Number.isFinite(v.lat) && Number.isFinite(v.lng)),
    destination,
  ];
  const coords = parts.map((p) => `${p.lng},${p.lat}`).join(";");
  const alt = preferAlternatives && vias.length === 0 ? "true" : "false";
  const url =
    `${OSRM_BASE}/route/v1/driving/${coords}` +
    `?overview=full&geometries=geojson&alternatives=${alt}&steps=false&continue_straight=false`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Routing failed (${res.status})`);
  const data = await res.json();
  return parseOsrmRoutes(data);
}

function routeLabel(distanceM, durationS, index) {
  const mins = Math.max(1, Math.round(durationS / 60));
  const tag = index === 0 ? "Recommended" : `Option ${index + 1}`;
  return `${tag} · ${formatDistance(distanceM)} · ~${mins} min`;
}

/** Straight-line fallback when OSRM is offline. */
export function straightRoute(origin, destination) {
  const points = densify([origin, destination], 24);
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    distance += haversine(points[i - 1], points[i]);
  }
  const duration = distance / 13.9;
  return [
    {
      id: "route_straight",
      distance,
      duration,
      points,
      summary: `Direct path · ${formatDistance(distance)} · ~${Math.max(1, Math.round(duration / 60))} min`,
    },
  ];
}

function densify(points, segments) {
  if (points.length < 2) return points;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    for (let s = 0; s < segments; s++) {
      const t = s / segments;
      out.push({
        lat: a.lat + (b.lat - a.lat) * t,
        lng: a.lng + (b.lng - a.lng) * t,
      });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Min distance from point to polyline (meters). */
export function distanceToPolyline(point, polyline) {
  if (!polyline?.length) return Infinity;
  let best = Infinity;
  for (const p of polyline) {
    const d = haversine(point, p);
    if (d < best) best = d;
  }
  return best;
}

/** Index of nearest polyline vertex to point. */
export function nearestPolylineIndex(point, polyline) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < polyline.length; i++) {
    const d = haversine(point, polyline[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return { index: best, distance: bestD };
}

/**
 * Move along a polyline by distanceM starting from fromIndex (and optional fromPos on that segment).
 * Arrived is true only when the final vertex is reached and no further travel remains on the path.
 */
export function advanceAlongPolyline(polyline, fromIndex, distanceM, fromPos = null) {
  if (!polyline?.length) return null;
  if (polyline.length === 1) {
    return { pos: { ...polyline[0] }, index: 0, arrived: true };
  }

  let i = Math.max(0, Math.min(fromIndex, polyline.length - 2));
  let remaining = Math.max(0, distanceM);
  let pos = fromPos
    ? { lat: fromPos.lat, lng: fromPos.lng }
    : { ...polyline[i] };

  // If fromPos is closer to the next vertex path, keep walking forward only
  while (remaining > 0 && i < polyline.length - 1) {
    const next = polyline[i + 1];
    const seg = haversine(pos, next);
    if (seg <= 0.05) {
      i += 1;
      pos = { ...next };
      continue;
    }
    if (remaining >= seg) {
      remaining -= seg;
      i += 1;
      pos = { ...next };
    } else {
      const t = remaining / seg;
      pos = {
        lat: pos.lat + (next.lat - pos.lat) * t,
        lng: pos.lng + (next.lng - pos.lng) * t,
      };
      remaining = 0;
    }
  }

  const last = polyline[polyline.length - 1];
  const atEnd = i >= polyline.length - 1 && haversine(pos, last) < 5;
  return { pos, index: Math.min(i, polyline.length - 1), arrived: atEnd };
}
