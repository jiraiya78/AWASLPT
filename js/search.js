/** Free geocoding via OpenStreetMap Nominatim (usage policy: identify app, throttle). */

const NOMINATIM = "https://nominatim.openstreetmap.org/search";

export async function searchPlaces(query, options = {}) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];

  const params = new URLSearchParams({
    q,
    format: "json",
    addressdetails: "0",
    limit: String(options.limit || 6),
    countrycodes: options.countrycodes || "my",
  });

  const res = await fetch(`${NOMINATIM}?${params}`, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  const data = await res.json();
  return (data || []).map((item) => ({
    id: String(item.place_id),
    name: item.display_name,
    lat: Number(item.lat),
    lng: Number(item.lon),
    type: item.type,
  }));
}
