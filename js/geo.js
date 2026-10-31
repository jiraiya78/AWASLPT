/** Haversine distance in meters between two WGS84 points. */
export function distanceMeters(a, b) {
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

export function formatDistance(meters) {
  if (meters == null || Number.isNaN(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 2 : 1)} km`;
}

export function formatEta(meters, speedMps) {
  if (meters == null || Number.isNaN(meters)) return "—";
  const speed = speedMps > 1 ? speedMps : 13.9; // ~50 km/h fallback
  const sec = meters / speed;
  if (sec < 60) return `<1 min`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

export function formatSpeed(mps) {
  if (mps == null || Number.isNaN(mps) || mps < 0) return "—";
  const kmh = mps * 3.6;
  return `${Math.round(kmh)} km/h`;
}

/** Bearing from a → b in degrees (0 = north). */
export function bearingDegrees(a, b) {
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

/** Move a point by distance meters along bearing degrees. */
export function destinationPoint(origin, bearingDeg, distanceM) {
  const R = 6371000;
  const δ = distanceM / R;
  const θ = (bearingDeg * Math.PI) / 180;
  const φ1 = (origin.lat * Math.PI) / 180;
  const λ1 = (origin.lng * Math.PI) / 180;
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ)
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
    );
  return {
    lat: (φ2 * 180) / Math.PI,
    lng: (((λ2 * 180) / Math.PI + 540) % 360) - 180,
  };
}

/**
 * Estimate speed (m/s) from successive GPS fixes.
 * Prefers GeolocationCoordinates.speed when available and plausible.
 */
export function estimateSpeed(prev, next, reportedSpeed) {
  if (
    typeof reportedSpeed === "number" &&
    !Number.isNaN(reportedSpeed) &&
    reportedSpeed >= 0 &&
    reportedSpeed < 70
  ) {
    return reportedSpeed;
  }
  if (!prev || !next || !prev.t || !next.t) return 0;
  const dt = (next.t - prev.t) / 1000;
  if (dt <= 0.2) return prev.speed ?? 0;
  const dist = distanceMeters(prev, next);
  const raw = dist / dt;
  if (raw > 70) return prev.speed ?? 0; // GPS jump filter
  // Light smoothing
  const prevSpeed = prev.speed ?? raw;
  return prevSpeed * 0.35 + raw * 0.65;
}

export function nearestCamera(position, cameras) {
  if (!position || !cameras?.length) return null;
  let best = null;
  for (const cam of cameras) {
    const d = distanceMeters(position, cam);
    if (!best || d < best.distance) best = { cam, distance: d };
  }
  return best;
}

/** Bounding box expanded by padKm around a polyline of lat/lng points. */
export function paddedBounds(points, padKm = 1) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  const padDeg = padKm / 111; // ~km to degrees latitude
  return {
    south: minLat - padDeg,
    north: maxLat + padDeg,
    west: minLng - padDeg,
    east: maxLng + padDeg,
  };
}
