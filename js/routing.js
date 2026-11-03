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
      steps: flattenSteps(route),
      summary: routeLabel(route.distance, route.duration, i),
    };
  });
}

function flattenSteps(route) {
  const steps = [];
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      const [lng, lat] = step.maneuver?.location || [];
      const modifier = step.maneuver?.modifier || "";
      const type = step.maneuver?.type || "";
      steps.push({
        lat,
        lng,
        name: step.name || "",
        distance: step.distance || 0,
        duration: step.duration || 0,
        type,
        modifier,
        instruction: stepInstruction(type, modifier, step.name),
      });
    }
  }
  return steps;
}

function stepInstruction(type, modifier, name) {
  const road = name ? ` onto ${name}` : "";
  const mod = modifier ? ` ${modifier}` : "";
  switch (type) {
    case "depart":
      return `Depart${road}`;
    case "arrive":
      return "Arrive at destination";
    case "turn":
      return `Turn${mod}${road}`;
    case "new name":
      return `Continue${road}`;
    case "merge":
      return `Merge${mod}${road}`;
    case "ramp":
      return `Take ramp${mod}${road}`;
    case "fork":
      return `Keep${mod}${road}`;
    case "end of road":
      return `At end of road, turn${mod}${road}`;
    case "continue":
      return `Continue${mod}${road}`;
    case "roundabout":
    case "rotary":
      return `Enter roundabout${road}`;
    case "notification":
      return name || "Continue";
    default:
      return `${type || "Continue"}${mod}${road}`.trim();
  }
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
    `?overview=full&geometries=geojson&alternatives=${alt}&steps=true&continue_straight=false`;

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
      steps: [
        {
          lat: origin.lat,
          lng: origin.lng,
          name: "",
          distance,
          duration,
          type: "depart",
          modifier: "",
          instruction: "Head toward destination",
        },
        {
          lat: destination.lat,
          lng: destination.lng,
          name: "",
          distance: 0,
          duration: 0,
          type: "arrive",
          modifier: "",
          instruction: "Arrive at destination",
        },
      ],
      summary: `Direct path · ${formatDistance(distance)} · ~${Math.max(1, Math.round(duration / 60))} min`,
    },
  ];
}

/**
 * Progress along a polyline: distance from start to the closest point on the path.
 */
export function progressAlongPolyline(point, polyline) {
  if (!polyline?.length) return { alongM: 0, index: 0, distToPath: Infinity };
  if (polyline.length === 1) {
    return {
      alongM: 0,
      index: 0,
      distToPath: haversine(point, polyline[0]),
    };
  }

  let bestDist = Infinity;
  let bestAlong = 0;
  let bestIndex = 0;
  let traveled = 0;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const segLen = haversine(a, b);
    const { dist, t } = distanceToSegment(point, a, b);
    if (dist < bestDist) {
      bestDist = dist;
      bestAlong = traveled + segLen * t;
      bestIndex = i;
    }
    traveled += segLen;
  }

  return { alongM: bestAlong, index: bestIndex, distToPath: bestDist };
}

function distanceToSegment(p, a, b) {
  const latToM = 111320;
  const lngToM = 111320 * Math.cos((p.lat * Math.PI) / 180);
  const ax = 0;
  const ay = 0;
  const bx = (b.lng - a.lng) * lngToM;
  const by = (b.lat - a.lat) * latToM;
  const px = (p.lng - a.lng) * lngToM;
  const py = (p.lat - a.lat) * latToM;
  const seg2 = bx * bx + by * by;
  let t = seg2 <= 1e-6 ? 0 : (px * bx + py * by) / seg2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * bx;
  const cy = ay + t * by;
  const dist = Math.hypot(px - cx, py - cy);
  return { dist, t };
}

/**
 * Next upcoming turn based on distance-along-route (not nearest by crow-flies).
 * Once you pass a maneuver, the next one is shown immediately.
 */
export function nextTurnFromSteps(position, steps, routePoints) {
  if (!position || !steps?.length) return null;

  const poly = routePoints?.length ? routePoints : steps.filter((s) => Number.isFinite(s.lat));
  const progress = progressAlongPolyline(position, poly);
  const PASS_BUFFER_M = 35; // consider a turn "passed" this far after it

  const upcoming = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    if (s.type === "depart") continue;

    const stepAlong = progressAlongPolyline(s, poly).alongM;
    // Still ahead of us (or we're not yet past it)
    if (stepAlong <= progress.alongM + PASS_BUFFER_M && s.type !== "arrive") {
      continue;
    }

    // Skip tiny "continue" / rename noise
    if (
      (s.type === "continue" || s.type === "new name" || s.type === "notification") &&
      (s.distance || 0) < 60 &&
      s.type !== "arrive"
    ) {
      continue;
    }

    upcoming.push({
      ...s,
      index: i,
      alongM: stepAlong,
      distanceAway: Math.max(0, stepAlong - progress.alongM),
    });
  }

  if (!upcoming.length) {
    const last = steps[steps.length - 1];
    if (!last || !Number.isFinite(last.lat)) return null;
    const along = progressAlongPolyline(last, poly).alongM;
    return {
      ...last,
      distanceAway: Math.max(0, along - progress.alongM),
    };
  }

  upcoming.sort((a, b) => a.alongM - b.alongM);
  return upcoming[0];
}

/** Point at distance `alongM` meters from the start of a polyline. */
export function pointAlongPolyline(polyline, alongM) {
  if (!polyline?.length) return null;
  if (polyline.length === 1 || alongM <= 0) return { ...polyline[0] };
  let acc = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const seg = haversine(polyline[i], polyline[i + 1]);
    if (acc + seg >= alongM) {
      const t = seg < 1e-6 ? 0 : (alongM - acc) / seg;
      return {
        lat: polyline[i].lat + (polyline[i + 1].lat - polyline[i].lat) * t,
        lng: polyline[i].lng + (polyline[i + 1].lng - polyline[i].lng) * t,
      };
    }
    acc += seg;
  }
  return { ...polyline[polyline.length - 1] };
}

/**
 * Bearing (deg) parallel to the route under the car.
 * Uses the segment the user is on (same direction as the drawn polyline).
 */
export function routeHeadingDegrees(position, routePoints, lookAheadM = 30) {
  if (!position || !routePoints?.length || routePoints.length < 2) return null;
  const { alongM, index, distToPath } = progressAlongPolyline(position, routePoints);
  if (distToPath > 150) return null;

  // Prefer the geometric segment underfoot — that is "parallel to the route"
  let i = Math.max(0, Math.min(index, routePoints.length - 2));
  while (i < routePoints.length - 2 && haversine(routePoints[i], routePoints[i + 1]) < 1.5) {
    i += 1;
  }
  const a = routePoints[i];
  const b = routePoints[i + 1];
  if (a && b && haversine(a, b) >= 1.5) {
    return bearingBetween(a, b);
  }

  // Fallback: short look-ahead along the path
  const from = pointAlongPolyline(routePoints, Math.max(0, alongM));
  const to = pointAlongPolyline(routePoints, alongM + lookAheadM);
  if (!from || !to || haversine(from, to) < 1) return null;
  return bearingBetween(from, to);
}

function bearingBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
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
