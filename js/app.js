import {
  distanceMeters,
  formatDistance,
  formatEta,
  formatSpeed,
  estimateSpeed,
  nearestCamera,
  destinationPoint,
  bearingDegrees,
} from "./geo.js";
import {
  loadCameras,
  saveCameras,
  setMeta,
  getMeta,
  uid,
  LPT_CAMERAS,
  CAMERA_SEED_VERSION,
} from "./storage.js";
import {
  registerServiceWorker,
  cacheRouteTiles,
  TILE_URL,
} from "./offline.js";
import {
  fetchRoutes,
  straightRoute,
  distanceToPolyline,
  nearestPolylineIndex,
  advanceAlongPolyline,
} from "./routing.js";
import { searchPlaces } from "./search.js";

const DEFAULT_ALERT_KM = 2;
const ROUTE_CAM_CORRIDOR_M = 800; // highway cams near LPT centerline
const OFF_ROUTE_M = 180; // derail threshold
const OFF_ROUTE_HITS = 3; // consecutive fixes before reroute
const REROUTE_COOLDOWN_MS = 25000;
const DEFAULT_DEMO_KMH = 90;

const el = {
  status: document.getElementById("statusLine"),
  nextDist: document.getElementById("nextDist"),
  nextEta: document.getElementById("nextEta"),
  speedVal: document.getElementById("speedVal"),
  proximityBar: document.getElementById("proximityBar"),
  proximityPct: document.getElementById("proximityPct"),
  proximityLabel: document.getElementById("proximityLabel"),
  hint: document.getElementById("hintLine"),
  alertBanner: document.getElementById("alertBanner"),
  alertTitle: document.getElementById("alertTitle"),
  alertSub: document.getElementById("alertSub"),
  camList: document.getElementById("camList"),
  camCount: document.getElementById("camCount"),
  routeCamList: document.getElementById("routeCamList"),
  routeCamCount: document.getElementById("routeCamCount"),
  routeCamEmpty: document.getElementById("routeCamEmpty"),
  alertRadiusKm: document.getElementById("alertRadiusKm"),
  alertVolume: document.getElementById("alertVolume"),
  volumeLabel: document.getElementById("volumeLabel"),
  routeMode: document.getElementById("routeMode"),
  routeInfo: document.getElementById("routeInfo"),
  navInfo: document.getElementById("navInfo"),
  cacheProgress: document.getElementById("cacheProgress"),
  cacheBar: document.getElementById("cacheBar"),
  cacheStatus: document.getElementById("cacheStatus"),
  drawer: document.getElementById("drawer"),
  scrim: document.getElementById("drawerScrim"),
  btnDemo: document.getElementById("btnDemo"),
  btnDest: document.getElementById("btnDest"),
  btnRoutes: document.getElementById("btnRoutes"),
  btnFollow: document.getElementById("btnFollow"),
  btnInstallMenu: document.getElementById("btnInstallMenu"),
  installHint: document.getElementById("installHint"),
  btnCacheRoute: document.getElementById("btnCacheRoute"),
  routePicker: document.getElementById("routePicker"),
  routeOptions: document.getElementById("routeOptions"),
  btnConfirmRoute: document.getElementById("btnConfirmRoute"),
  searchPanel: document.getElementById("searchPanel"),
  searchForm: document.getElementById("searchForm"),
  searchInput: document.getElementById("searchInput"),
  searchResults: document.getElementById("searchResults"),
  recentBlock: document.getElementById("recentBlock"),
  recentList: document.getElementById("recentList"),
  demoSpeedBar: document.getElementById("demoSpeedBar"),
  demoSpeedLabel: document.getElementById("demoSpeedLabel"),
};

const state = {
  cameras: [],
  position: null,
  prevPosition: null,
  watchId: null,
  demoTimer: null,
  demoActive: false,
  tracking: false,
  follow: true,
  destMode: false,
  destination: null,
  routeAlternatives: [],
  selectedRoute: null,
  altRouteLayers: [],
  destMarker: null,
  navLine: null,
  routePoints: [],
  routeLine: null,
  alertRadiusM: DEFAULT_ALERT_KM * 1000,
  alertVolume: 0.7,
  alertSilenced: false,
  alertActive: false,
  audioCtx: null,
  alertTimer: null,
  map: null,
  userMarker: null,
  camLayer: null,
  accuracyCircle: null,
  suppressFollowUntil: 0,
  deferredInstall: null,
  recentSearches: [],
  offRouteHits: 0,
  lastRerouteAt: 0,
  rerouting: false,
  trail: [], // recent GPS crumbs for reroute context
  demoSpeedKmh: DEFAULT_DEMO_KMH,
  demoPathIndex: 0,
  demoPath: null, // dedicated copy so demo keeps moving even if route object changes
  demoPos: null,
  wakeLock: null,
  targetZoom: null,
  lastZoomAt: 0,
  pendingRoute: null, // previewed but not confirmed
};

function setStatus(text) {
  el.status.textContent = text;
}

function openDrawer(open) {
  el.drawer.classList.toggle("open", open);
  el.drawer.setAttribute("aria-hidden", open ? "false" : "true");
  el.scrim.classList.toggle("hidden", !open);
}

function camIcon() {
  return L.divIcon({
    className: "",
    html: '<div class="cam-marker">A</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function userIcon() {
  return L.divIcon({
    className: "",
    html: '<div class="user-marker"></div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function destIcon() {
  return L.divIcon({
    className: "",
    html: '<div class="dest-marker">D</div>',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
  }).setView([4.2, 103.1], 8);

  L.control.zoom({ position: "bottomright" }).addTo(state.map);

  L.tileLayer(TILE_URL, {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(state.map);

  state.camLayer = L.layerGroup().addTo(state.map);

  state.map.on("click", onMapClick);
  state.map.on("dragstart", () => {
    if (Date.now() < state.suppressFollowUntil) return;
    setFollow(false);
  });
}

function setFollow(on, recenter = true) {
  state.follow = on;
  el.btnFollow.classList.toggle("active", on);
  el.btnFollow.setAttribute("aria-pressed", on ? "true" : "false");
  if (on && recenter && state.position) {
    state.suppressFollowUntil = Date.now() + 400;
    const zoom = zoomForSpeed(state.position.speed);
    state.targetZoom = zoom;
    state.lastZoomAt = Date.now();
    state.map.setView([state.position.lat, state.position.lng], zoom, {
      animate: true,
    });
  }
}

function centerOnCar() {
  if (!state.position) {
    el.hint.textContent = "No position yet — waiting for GPS, or use Demo in the menu.";
    return;
  }
  setFollow(true, true);
}

async function persistCameras() {
  await saveCameras(state.cameras);
  renderCameras();
  renderRouteCameras();
}

function renderCameras() {
  state.camLayer.clearLayers();
  for (const cam of state.cameras) {
    const m = L.marker([cam.lat, cam.lng], { icon: camIcon() }).addTo(
      state.camLayer
    );
    m.bindPopup(
      `<strong>${escapeHtml(cam.name || "AWAS")}</strong><br/>` +
        `${cam.lat.toFixed(5)}, ${cam.lng.toFixed(5)}` +
        (cam.note ? `<br/><em>${escapeHtml(cam.note)}</em>` : "")
    );
  }

  el.camCount.textContent = String(state.cameras.length);
  el.camList.innerHTML = "";
  if (!state.cameras.length) {
    el.camList.innerHTML = '<li class="muted">No cameras yet.</li>';
    return;
  }
  for (const cam of state.cameras) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <div>${escapeHtml(cam.name || "AWAS")}</div>
        <div class="meta">${cam.lat.toFixed(5)}, ${cam.lng.toFixed(5)}</div>
      </div>
      <button type="button" data-id="${cam.id}" aria-label="Remove">Remove</button>`;
    li.querySelector("button").addEventListener("click", async () => {
      state.cameras = state.cameras.filter((c) => c.id !== cam.id);
      await persistCameras();
      updateHud();
    });
    el.camList.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MAX_RECENT = 8;

function openSearch(open) {
  el.searchPanel.classList.toggle("hidden", !open);
  if (open) {
    el.routePicker.classList.add("hidden");
    openDrawer(false);
    el.searchResults.innerHTML = "";
    renderRecentSearches();
    setTimeout(() => el.searchInput.focus(), 50);
  }
}

function placeKey(place) {
  return `${place.lat.toFixed(5)},${place.lng.toFixed(5)}`;
}

async function rememberSearch(place) {
  if (!place || !Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return;
  const entry = {
    name: place.name || `Pin ${place.lat.toFixed(4)}, ${place.lng.toFixed(4)}`,
    lat: place.lat,
    lng: place.lng,
    at: Date.now(),
  };
  const key = placeKey(entry);
  state.recentSearches = [
    entry,
    ...state.recentSearches.filter((r) => placeKey(r) !== key),
  ].slice(0, MAX_RECENT);
  await setMeta("recentSearches", state.recentSearches);
  renderRecentSearches();
}

function renderRecentSearches() {
  const list = el.recentList;
  if (!list) return;
  list.innerHTML = "";
  const items = state.recentSearches || [];
  if (!items.length) {
    el.recentBlock.classList.add("hidden");
    return;
  }
  el.recentBlock.classList.remove("hidden");
  for (const place of items) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `${escapeHtml(place.name)}<span class="meta">${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}</span>`;
    btn.addEventListener("click", async () => {
      openSearch(false);
      state.destMode = false;
      el.btnDest.classList.remove("active");
      await setDestination({
        lat: place.lat,
        lng: place.lng,
        name: place.name,
      });
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function setDestMode(on) {
  state.destMode = on;
  el.btnDest.classList.toggle("active", on);
  if (on) {
    el.routeMode.checked = false;
    openSearch(true);
    el.hint.textContent = "Search a place, or tap the map to set destination.";
  } else {
    openSearch(false);
    if (!el.routeMode.checked) {
      el.hint.textContent =
        "GPS tracks automatically. Tap Search for a destination.";
    }
  }
}

async function onMapClick(e) {
  const point = { lat: e.latlng.lat, lng: e.latlng.lng };

  if (state.destMode) {
    setDestMode(false);
    await setDestination({
      ...point,
      name: `Map pin ${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`,
    });
    return;
  }

  if (el.routeMode.checked) {
    if (state.routePoints.length >= 2) state.routePoints = [];
    state.routePoints.push(point);
    drawCorridor();
    return;
  }

  const name = prompt("Camera name (optional):", "AWAS camera");
  if (name === null) return;
  state.cameras.push({
    id: uid(),
    name: name.trim() || "AWAS camera",
    lat: point.lat,
    lng: point.lng,
    note: "User added",
  });
  await persistCameras();
  el.hint.textContent = "Camera saved. It will alert when you approach.";
  updateHud();
}

async function setDestination(dest) {
  state.destination = dest;
  state.offRouteHits = 0;
  state.selectedRoute = null;
  state.pendingRoute = null;
  clearAltLayers();
  if (state.navLine) {
    state.map.removeLayer(state.navLine);
    state.navLine = null;
  }
  if (state.destMarker) state.map.removeLayer(state.destMarker);
  state.destMarker = L.marker([dest.lat, dest.lng], { icon: destIcon() }).addTo(
    state.map
  );
  const destLabel = dest.name || "Destination";
  state.destMarker.bindPopup(escapeHtml(destLabel));

  const origin = state.position || {
    lat: state.map.getCenter().lat,
    lng: state.map.getCenter().lng,
  };

  el.navInfo.textContent = dest.name
    ? `To: ${dest.name.split(",")[0]} — fetching routes…`
    : "Fetching routes…";
  setStatus("Routing…");
  el.hint.textContent = "Fetching route options…";
  openSearch(false);

  const routes = await loadRouteOptions(origin, dest);
  state.routeAlternatives = routes;
  await setMeta("destination", dest);
  await setMeta("selectedRoute", null);
  await rememberSearch(dest);
  openRoutePicker(routes);
  el.hint.textContent = "Preview a route, then tap OK to confirm.";
}

/** Always returns ≥1 route (OSRM with snap, else straight). */
async function loadRouteOptions(origin, destination, vias = []) {
  try {
    const routes = await fetchRoutes(origin, destination, { vias });
    if (routes?.length) return routes;
  } catch (err) {
    console.warn(err);
  }
  el.hint.textContent = "No road route found — using direct path option.";
  return straightRoute(origin, destination);
}

function closeRoutePicker() {
  el.routePicker.classList.add("hidden");
  state.pendingRoute = null;
  if (el.btnConfirmRoute) el.btnConfirmRoute.disabled = true;
}

function openRoutePicker(routes) {
  if (!routes?.length) return;
  state.routeAlternatives = routes;
  openSearch(false);
  openDrawer(false);
  el.routePicker.classList.remove("hidden");
  el.routeOptions.innerHTML = "";
  routes.forEach((route, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "route-option" + (i === 0 ? " selected" : "");
    btn.dataset.routeId = route.id;
    btn.innerHTML = `${escapeHtml(route.summary)}`;
    btn.addEventListener("click", () => previewRouteChoice(route));
    el.routeOptions.appendChild(btn);
  });
  previewRouteChoice(routes[0]);
  el.hint.textContent = "Preview a route, then tap OK to confirm.";
}

function previewRouteChoice(route) {
  state.pendingRoute = route;
  el.btnConfirmRoute.disabled = false;
  document.querySelectorAll(".route-option").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.routeId === route.id);
  });

  // Keep committed nav line dim if present; highlight preview
  clearAltLayers();
  if (state.navLine) {
    state.navLine.setStyle({ opacity: 0.25, weight: 3 });
  }

  const routes = state.routeAlternatives || [route];
  routes.forEach((r) => {
    const selected = r.id === route.id;
    const latlngs = r.points.map((p) => [p.lat, p.lng]);
    const line = L.polyline(latlngs, {
      color: selected ? "#38bdf8" : "#64748b",
      weight: selected ? 6 : 3,
      opacity: selected ? 0.95 : 0.35,
      dashArray: selected ? null : "6 8",
    }).addTo(state.map);
    state.altRouteLayers.push(line);
  });

  const latlngs = route.points.map((p) => [p.lat, p.lng]);
  if (latlngs.length) {
    state.map.fitBounds(L.latLngBounds(latlngs), { padding: [48, 48] });
    setFollow(false);
  }
  setStatus("Previewing route");
}

function confirmPendingRoute() {
  if (!state.pendingRoute) return;
  const route = state.pendingRoute;
  selectRoute(route, { fromReroute: false });
  closeRoutePicker();
  setFollow(true, true);
}

async function openRoutesPanel() {
  openDrawer(false);
  openSearch(false);

  if (!state.destination) {
    setStatus("Set a destination first");
    el.hint.textContent = "Search a destination, then use Route to pick a path.";
    setDestMode(true);
    return;
  }

  setStatus("Loading routes…");
  el.hint.textContent = "Fetching route options…";
  const origin = state.position || {
    lat: state.map.getCenter().lat,
    lng: state.map.getCenter().lng,
  };
  const routes = await loadRouteOptions(origin, state.destination);
  openRoutePicker(routes);
}

function previewAlternatives(routes) {
  clearAltLayers();
  routes.forEach((route, i) => {
    const latlngs = route.points.map((p) => [p.lat, p.lng]);
    const line = L.polyline(latlngs, {
      color: i === 0 ? "#38bdf8" : "#64748b",
      weight: i === 0 ? 5 : 3,
      opacity: i === 0 ? 0.85 : 0.45,
      dashArray: i === 0 ? null : "6 8",
    }).addTo(state.map);
    state.altRouteLayers.push(line);
  });
  const all = routes.flatMap((r) => r.points.map((p) => [p.lat, p.lng]));
  if (all.length) {
    state.map.fitBounds(L.latLngBounds(all), { padding: [48, 48] });
    setFollow(false);
  }
}

function clearAltLayers() {
  for (const layer of state.altRouteLayers) {
    state.map.removeLayer(layer);
  }
  state.altRouteLayers = [];
}

function selectRoute(route, opts = {}) {
  const { quiet = false, fromReroute = false } = opts;
  state.selectedRoute = route;
  state.pendingRoute = null;
  state.offRouteHits = 0;
  clearAltLayers();
  if (state.navLine) {
    state.map.removeLayer(state.navLine);
    state.navLine = null;
  }
  const latlngs = route.points.map((p) => [p.lat, p.lng]);
  state.navLine = L.polyline(latlngs, {
    color: fromReroute ? "#22c55e" : "#38bdf8",
    weight: 5,
    opacity: 0.9,
  }).addTo(state.map);

  const persistPts = samplePoints(route.points, 80);
  state.routePoints = persistPts;
  drawCorridor(false);
  el.btnCacheRoute.disabled = persistPts.length < 2;

  const destName = state.destination?.name
    ? state.destination.name.split(",")[0]
    : "Destination";
  el.navInfo.textContent = `${fromReroute ? "Rerouted · " : ""}${destName} — ${route.summary}`;
  el.routeInfo.textContent = `Nav route ready to cache (${route.points.length} pts).`;
  if (!quiet) closeRoutePicker();
  setStatus(fromReroute ? "Rerouted" : "Route confirmed");
  if (!quiet) {
    el.hint.textContent = fromReroute
      ? "Back on a new route from your current path."
      : "Route confirmed. Open menu → Cameras on route for the list.";
  }

  // If demo is running, keep it on the new geometry from nearest point forward
  if (state.demoActive && state.demoPos && route.points?.length >= 2) {
    state.demoPath = route.points.map((p) => ({ lat: p.lat, lng: p.lng }));
    const near = nearestPolylineIndex(state.demoPos, state.demoPath);
    state.demoPathIndex = Math.min(near.index, state.demoPath.length - 2);
  }

  setMeta("selectedRoute", {
    id: route.id,
    distance: route.distance,
    duration: route.duration,
    summary: route.summary,
    points: persistPts,
  });
  setMeta("destination", state.destination);
  renderRouteCameras();
  updateHud();
}

/** Cameras within corridor of the selected route, ordered along the path. */
function camerasAlongRoute(routePoints) {
  if (!routePoints?.length) return [];
  const along = [];
  for (const cam of state.cameras) {
    const off = distanceToPolyline(cam, routePoints);
    if (off > ROUTE_CAM_CORRIDOR_M) continue;
    along.push({
      cam,
      offsetM: off,
      alongM: distanceAlongPolyline(cam, routePoints),
    });
  }
  along.sort((a, b) => a.alongM - b.alongM);
  return along;
}

function distanceAlongPolyline(point, polyline) {
  let best = Infinity;
  let bestAlong = 0;
  let traveled = 0;
  for (let i = 0; i < polyline.length; i++) {
    const d = distanceMeters(point, polyline[i]);
    if (d < best) {
      best = d;
      bestAlong = traveled;
    }
    if (i < polyline.length - 1) {
      traveled += distanceMeters(polyline[i], polyline[i + 1]);
    }
  }
  return bestAlong;
}

function renderRouteCameras() {
  const list = el.routeCamList;
  const routePts = state.selectedRoute?.points;
  const along = camerasAlongRoute(routePts);
  el.routeCamCount.textContent = String(along.length);
  list.innerHTML = "";

  if (!routePts?.length) {
    el.routeCamEmpty.classList.remove("hidden");
    el.routeCamEmpty.textContent =
      "Set a destination and choose a route to see AWAS cameras along it.";
    return;
  }
  if (!along.length) {
    el.routeCamEmpty.classList.remove("hidden");
    el.routeCamEmpty.textContent =
      "No cameras within ~800 m of this route. Check map or reset LPT list.";
    return;
  }

  el.routeCamEmpty.classList.add("hidden");
  for (const item of along) {
    const { cam, alongM, offsetM } = item;
    const li = document.createElement("li");
    li.innerHTML = `
      <div>
        <div>${escapeHtml(cam.name || "AWAS")}</div>
        <div class="meta">${cam.lat.toFixed(7)}, ${cam.lng.toFixed(7)}</div>
        <div class="meta">~${formatDistance(alongM)} along route · ${Math.round(offsetM)} m off path</div>
      </div>
      <button type="button" class="dist-tag" data-id="${cam.id}">Show</button>`;
    li.querySelector("button").addEventListener("click", () => {
      openDrawer(false);
      setFollow(false);
      state.map.setView([cam.lat, cam.lng], 14);
    });
    list.appendChild(li);
  }
}

function samplePoints(points, maxCount) {
  if (points.length <= maxCount) return points.map((p) => ({ ...p }));
  const out = [];
  const step = (points.length - 1) / (maxCount - 1);
  for (let i = 0; i < maxCount; i++) {
    const idx = Math.round(i * step);
    out.push({ ...points[idx] });
  }
  return out;
}

function clearNavigation() {
  state.destination = null;
  state.selectedRoute = null;
  state.routeAlternatives = [];
  state.offRouteHits = 0;
  clearAltLayers();
  if (state.navLine) {
    state.map.removeLayer(state.navLine);
    state.navLine = null;
  }
  if (state.destMarker) {
    state.map.removeLayer(state.destMarker);
    state.destMarker = null;
  }
  closeRoutePicker();
  el.navInfo.textContent = "No destination set.";
  setMeta("destination", null);
  setMeta("selectedRoute", null);
  setDestMode(false);
  renderRouteCameras();
}

function drawCorridor(fit = true) {
  if (state.routeLine) {
    state.map.removeLayer(state.routeLine);
    state.routeLine = null;
  }
  if (!state.routePoints.length) {
    if (!state.selectedRoute) {
      el.routeInfo.textContent = "No route set.";
      el.btnCacheRoute.disabled = true;
    }
    return;
  }
  const latlngs = state.routePoints.map((p) => [p.lat, p.lng]);
  // Only show dashed corridor if no nav line
  if (!state.navLine) {
    state.routeLine = L.polyline(latlngs, {
      color: "#38bdf8",
      weight: 4,
      dashArray: state.routePoints.length < 2 ? null : "8 8",
    }).addTo(state.map);
  }

  if (state.routePoints.length === 1) {
    el.routeInfo.textContent = "Start set — tap map for end point.";
    el.btnCacheRoute.disabled = true;
  } else {
    if (!state.selectedRoute) {
      const d = distanceMeters(state.routePoints[0], state.routePoints[state.routePoints.length - 1]);
      el.routeInfo.textContent = `Corridor ~${formatDistance(d)}. Cache pads ~1.2 km around it.`;
    }
    el.btnCacheRoute.disabled = false;
    if (fit && state.routeLine) {
      state.map.fitBounds(state.routeLine.getBounds(), { padding: [40, 40] });
    }
  }
  setMeta("route", state.routePoints);
}

function updateUserMarker(pos) {
  const latlng = [pos.lat, pos.lng];
  if (!state.userMarker) {
    state.userMarker = L.marker(latlng, {
      icon: userIcon(),
      zIndexOffset: 1000,
    }).addTo(state.map);
  } else {
    state.userMarker.setLatLng(latlng);
  }
  if (pos.accuracy && pos.accuracy < 200) {
    if (!state.accuracyCircle) {
      state.accuracyCircle = L.circle(latlng, {
        radius: pos.accuracy,
        color: "#38bdf8",
        weight: 1,
        fillOpacity: 0.08,
      }).addTo(state.map);
    } else {
      state.accuracyCircle.setLatLng(latlng);
      state.accuracyCircle.setRadius(pos.accuracy);
    }
  }

  if (state.follow) {
    state.suppressFollowUntil = Date.now() + 250;
    const zoom = zoomForSpeed(pos.speed);
    const now = Date.now();
    const prev = state.targetZoom;
    const zoomChanged = prev == null || Math.abs(zoom - prev) >= 0.25;
    // Zoom in quickly when slowing (intersections); zoom out more gently
    const zoomingIn = prev != null && zoom > prev;
    const throttleMs = zoomingIn ? 700 : 1400;
    if (zoomChanged && now - state.lastZoomAt > throttleMs) {
      state.targetZoom = zoom;
      state.lastZoomAt = now;
      state.map.setView(latlng, zoom, { animate: true, duration: zoomingIn ? 0.45 : 0.7 });
    } else {
      state.map.panTo(latlng, { animate: true, duration: 0.35 });
    }
  }
}

/**
 * Speed-based zoom while navigating.
 * Slow → close (road / intersections); fast → only a bit wider (never too far out).
 * Range ~18 (stopped) → ~15 (highway).
 */
function zoomForSpeed(speedMps) {
  const kmh = Math.max(0, (speedMps || 0) * 3.6);
  // 0 km/h → 18.0, 40 → 17.0, 70 → 16.25, 100 → 15.5, 120+ → 15.0
  const t = Math.min(kmh, 120) / 120;
  const zoom = 18 - t * 3;
  return Math.round(zoom * 4) / 4;
}

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    if (state.wakeLock) return;
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch (err) {
    console.warn("Wake Lock unavailable:", err.message);
  }
}

function setupWakeLock() {
  requestWakeLock();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestWakeLock();
  });
  // Some browsers drop the lock after idle; refresh periodically while page is open
  setInterval(() => {
    if (document.visibilityState === "visible" && !state.wakeLock) {
      requestWakeLock();
    }
  }, 30000);
}

function applyPosition(fix, reportedSpeed = null) {
  const next = {
    lat: fix.lat,
    lng: fix.lng,
    t: fix.t ?? Date.now(),
    accuracy: fix.accuracy,
    speed: 0,
  };
  next.speed = estimateSpeed(state.position, next, reportedSpeed);
  state.prevPosition = state.position;
  state.position = next;

  state.trail.push({ lat: next.lat, lng: next.lng, t: next.t });
  if (state.trail.length > 40) state.trail.shift();

  updateUserMarker(next);
  updateHud();
  maybeReroute(next);
}

function maybeReroute(pos) {
  if (state.demoActive) return; // demo stays on its path
  if (!state.destination || !state.selectedRoute?.points?.length) return;
  if (state.rerouting) return;

  const off = distanceToPolyline(pos, state.selectedRoute.points);
  if (off > OFF_ROUTE_M) {
    state.offRouteHits += 1;
  } else {
    state.offRouteHits = 0;
    return;
  }

  if (state.offRouteHits < OFF_ROUTE_HITS) return;
  if (Date.now() - state.lastRerouteAt < REROUTE_COOLDOWN_MS) return;

  state.offRouteHits = 0;
  rerouteFromCurrent("Off route — recalculating…");
}

async function rerouteFromCurrent(statusMsg = "Rerouting…") {
  if (!state.destination || state.rerouting) return;
  const origin = state.position;
  if (!origin) return;

  state.rerouting = true;
  state.lastRerouteAt = Date.now();
  setStatus(statusMsg);
  el.hint.textContent = statusMsg;

  // Use a recent trail point as via so the new route respects where you came from
  const vias = [];
  if (state.trail.length >= 8) {
    const via = state.trail[Math.floor(state.trail.length * 0.5)];
    const dVia = distanceMeters(origin, via);
    if (dVia > 80 && dVia < 2500) vias.push(via);
  }

  try {
    const routes = await loadRouteOptions(origin, state.destination, vias);
    state.routeAlternatives = routes;
    // Auto-apply best on derail; user can open Route anytime to change
    selectRoute(routes[0], { fromReroute: true });
    el.hint.textContent = "Rerouted. Tap Route to preview other options.";
  } catch (err) {
    console.warn(err);
    setStatus("Reroute failed");
    el.hint.textContent = "Could not reroute — staying on previous path.";
  } finally {
    state.rerouting = false;
  }
}

function pickNearestRelevant(pos) {
  const routePts = state.selectedRoute?.points;
  if (!routePts?.length) return nearestCamera(pos, state.cameras);

  const along = [];
  for (const cam of state.cameras) {
    const off = distanceToPolyline(cam, routePts);
    if (off <= ROUTE_CAM_CORRIDOR_M) {
      along.push({ cam, distance: distanceMeters(pos, cam) });
    }
  }
  if (along.length) {
    along.sort((a, b) => a.distance - b.distance);
    return along[0];
  }
  return nearestCamera(pos, state.cameras);
}

function updateHud() {
  const radius = state.alertRadiusM;
  const pos = state.position;
  el.speedVal.textContent = pos ? formatSpeed(pos.speed) : "—";

  if (!pos || !state.cameras.length) {
    el.nextDist.textContent = "—";
    el.nextEta.textContent = "—";
    setProximity(0, "far");
    hideAlertBanner();
    stopAlertSound();
    el.proximityLabel.textContent = state.cameras.length
      ? "Waiting for GPS…"
      : "No cameras loaded";
    return;
  }

  const nearest = pickNearestRelevant(pos);
  const d = nearest.distance;
  el.nextDist.textContent = formatDistance(d);
  el.nextEta.textContent = formatEta(d, pos.speed);
  el.proximityLabel.textContent = nearest.cam.name || "Nearest AWAS";

  const closeness = Math.max(0, Math.min(1, 1 - d / radius));
  let level = "far";
  if (d <= radius * 0.25) level = "alert";
  else if (d <= radius * 0.5) level = "near";
  else if (d <= radius) level = "mid";
  setProximity(closeness, level);

  if (d <= radius) {
    showAlertBanner();
    el.alertTitle.textContent = `AWAS ahead — ${nearest.cam.name || "camera"}`;
    el.alertSub.textContent = `${formatDistance(d)} · ETA ${formatEta(d, pos.speed)} · ${formatSpeed(pos.speed)}`;
    if (!state.alertSilenced) startAlertSound();
  } else {
    // Left the zone — allow future alerts again
    state.alertSilenced = false;
    hideAlertBanner();
    stopAlertSound();
  }
}

function hideAlertBanner() {
  el.alertBanner.classList.add("hidden");
}

function showAlertBanner() {
  el.alertBanner.classList.remove("hidden");
}

function setProximity(closeness01, level) {
  const pct = Math.round(closeness01 * 100);
  el.proximityBar.style.width = `${pct}%`;
  el.proximityBar.className = `bar-fill level-${level}`;
  el.proximityPct.textContent = `${pct}%`;
}

function getAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!state.audioCtx) state.audioCtx = new Ctx();
  if (state.audioCtx.state === "suspended") state.audioCtx.resume();
  return state.audioCtx;
}

function playAlertChirp() {
  if (state.alertVolume <= 0) return;
  try {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.setValueAtTime(660, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.001, state.alertVolume * 0.22),
      now + 0.02
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.3);
  } catch {
    /* ignore */
  }
}

function startAlertSound() {
  if (state.alertActive || state.alertSilenced) return;
  if (state.alertVolume <= 0) return;
  state.alertActive = true;
  playAlertChirp();
  state.alertTimer = setInterval(playAlertChirp, 650);
}

function stopAlertSound() {
  if (state.alertTimer) {
    clearInterval(state.alertTimer);
    state.alertTimer = null;
  }
  state.alertActive = false;
}

function applyVolume() {
  // Volume applied on next chirp; restart loop if already alerting
  if (state.alertActive && !state.alertSilenced) {
    stopAlertSound();
    if (state.alertVolume > 0) startAlertSound();
  }
}

function userStopAlert() {
  state.alertSilenced = true;
  stopAlertSound();
  el.hint.textContent = "Alert silenced until you leave the zone.";
}

function startTracking() {
  if (!navigator.geolocation) {
    setStatus("Geolocation unavailable");
    el.hint.textContent =
      "This browser has no GPS. Use HTTPS on a phone, or try Demo from the menu.";
    return;
  }
  if (state.watchId != null) return;
  if (state.demoActive) return;

  setStatus("Acquiring GPS…");
  state.tracking = true;
  setFollow(true, false);

  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      if (state.demoActive) return;
      applyPosition(
        {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          t: pos.timestamp,
          accuracy: pos.coords.accuracy,
        },
        pos.coords.speed
      );
      setStatus(
        pos.coords.accuracy
          ? `GPS ±${Math.round(pos.coords.accuracy)} m`
          : "GPS live"
      );
    },
    (err) => {
      setStatus(`GPS error: ${err.message}`);
      el.hint.textContent =
        "Allow location permission (required). Demo is available in the menu.";
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000,
    }
  );
}

function stopTracking() {
  if (state.watchId != null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  state.tracking = false;
}

function demoSpeedMps() {
  return (state.demoSpeedKmh / 3.6);
}

function updateDemoSpeedLabel() {
  el.demoSpeedLabel.textContent = `${Math.round(state.demoSpeedKmh)} km/h`;
}

function setDemoSpeedVisible(on) {
  el.demoSpeedBar.classList.toggle("hidden", !on);
  updateDemoSpeedLabel();
}

function adjustDemoSpeed(deltaKmh) {
  state.demoSpeedKmh = Math.max(20, Math.min(140, state.demoSpeedKmh + deltaKmh));
  updateDemoSpeedLabel();
  setMeta("demoSpeedKmh", state.demoSpeedKmh);
}

function syncDemoButton() {
  if (!el.btnDemo) return;
  if (state.demoActive) {
    el.btnDemo.classList.add("active");
    el.btnDemo.textContent = "Stop demo drive";
  } else {
    el.btnDemo.classList.remove("active");
    el.btnDemo.textContent = "Start demo drive";
  }
}

async function startDemo() {
  stopTracking();
  stopDemo({ resumeGps: false });
  state.alertSilenced = false;
  openDrawer(false);

  if (!state.cameras.length) {
    state.cameras = LPT_CAMERAS.map((c) => ({ ...c }));
    await persistCameras();
  }

  // Prefer current nav path toward destination
  let path = state.selectedRoute?.points;
  if ((!path || path.length < 2) && state.destination) {
    setStatus("Building demo route…");
    const origin =
      state.position ||
      (path && path[0]) ||
      { lat: LPT_CAMERAS[0].lat, lng: LPT_CAMERAS[0].lng };
    const routes = await loadRouteOptions(origin, state.destination);
    selectRoute(routes[0], { quiet: true });
    path = state.selectedRoute?.points;
  }

  if (!path || path.length < 2) {
    el.hint.textContent =
      "No route set — demo drives toward nearest camera. Set Dest for path demo.";
    startDemoTowardCamera();
    return;
  }

  // Own copy of the path; always start from the beginning toward destination
  state.demoPath = path.map((p) => ({ lat: p.lat, lng: p.lng }));
  state.demoPathIndex = 0;
  state.demoPos = { ...state.demoPath[0] };

  const pos = {
    ...state.demoPos,
    t: Date.now(),
    speed: demoSpeedMps(),
    accuracy: 10,
  };

  state.demoActive = true;
  syncDemoButton();
  setDemoSpeedVisible(true);
  setStatus("Demo on route");
  el.hint.textContent =
    "Demo following your selected path. Use − / + to change speed.";
  setFollow(true, false);
  state.map.setView([pos.lat, pos.lng], 14);
  applyPosition(pos, demoSpeedMps());

  const tickMs = 250;
  state.demoTimer = setInterval(() => {
    const poly = state.demoPath;
    if (!poly || poly.length < 2) {
      stopDemo();
      return;
    }
    const stepM = demoSpeedMps() * (tickMs / 1000);
    const advanced = advanceAlongPolyline(
      poly,
      state.demoPathIndex,
      stepM,
      state.demoPos
    );
    if (!advanced) {
      stopDemo();
      return;
    }
    state.demoPathIndex = advanced.index;
    state.demoPos = { ...advanced.pos };
    applyPosition(
      {
        ...advanced.pos,
        t: Date.now(),
        speed: demoSpeedMps(),
        accuracy: 10,
      },
      demoSpeedMps()
    );
    if (advanced.arrived) {
      setStatus("Demo arrived at destination");
      el.hint.textContent = "Reached destination — open menu to replay Demo.";
      stopDemo();
    }
  }, tickMs);
}

function startDemoTowardCamera() {
  const target = state.cameras[0] || LPT_CAMERAS[0];
  const start = destinationPoint(
    { lat: target.lat, lng: target.lng },
    220,
    2400
  );
  state.demoPos = { lat: start.lat, lng: start.lng };
  state.demoPath = null;
  state.demoActive = true;
  syncDemoButton();
  setDemoSpeedVisible(true);
  setStatus("Demo drive");
  setFollow(true, false);
  state.map.setView([start.lat, start.lng], 14);
  applyPosition(
    { ...start, t: Date.now(), speed: demoSpeedMps(), accuracy: 12 },
    demoSpeedMps()
  );

  const tickMs = 250;
  state.demoTimer = setInterval(() => {
    if (!state.demoPos) return;
    const nearest = nearestCamera(state.demoPos, state.cameras);
    if (!nearest) return;
    const brg = bearingDegrees(state.demoPos, nearest.cam);
    const stepM = demoSpeedMps() * (tickMs / 1000);
    state.demoPos = destinationPoint(state.demoPos, brg, stepM);
    applyPosition(
      {
        ...state.demoPos,
        t: Date.now(),
        speed: demoSpeedMps(),
        accuracy: 12,
      },
      demoSpeedMps()
    );
    if (nearest.distance < 40) {
      setStatus("Demo arrived — open menu to replay");
      stopDemo();
    }
  }, tickMs);
}

function stopDemo({ resumeGps = true } = {}) {
  if (state.demoTimer) {
    clearInterval(state.demoTimer);
    state.demoTimer = null;
  }
  const wasDemo = state.demoActive;
  state.demoActive = false;
  state.demoPath = null;
  setDemoSpeedVisible(false);
  syncDemoButton();
  if (wasDemo && resumeGps) startTracking();
}

async function cacheCurrentRoute() {
  const points =
    state.selectedRoute?.points?.length >= 2
      ? samplePoints(state.selectedRoute.points, 60)
      : state.routePoints;
  if (!points || points.length < 2) return;

  el.cacheProgress.classList.remove("hidden");
  el.cacheStatus.textContent = "Downloading tiles…";
  el.btnCacheRoute.disabled = true;
  try {
    const result = await cacheRouteTiles(points, {
      onProgress: (done, total) => {
        const pct = Math.round((done / total) * 100);
        el.cacheBar.style.width = `${pct}%`;
        el.cacheStatus.textContent = `Caching tiles ${done}/${total} (${pct}%)`;
      },
    });
    await setMeta("route", points);
    await setMeta("cachedAt", Date.now());
    el.cacheStatus.textContent = `Done — ${result.cached} tiles requested. Cameras already stored on-device.`;
    setStatus("Route cached offline");
  } catch (err) {
    el.cacheStatus.textContent = `Cache failed: ${err.message}`;
  } finally {
    el.btnCacheRoute.disabled = false;
  }
}

function fitCameras() {
  if (!state.cameras.length) return;
  const bounds = L.latLngBounds(state.cameras.map((c) => [c.lat, c.lng]));
  state.map.fitBounds(bounds, { padding: [40, 40] });
}

async function resetToLptCameras() {
  state.cameras = LPT_CAMERAS.map((c) => ({ ...c }));
  await persistCameras();
  await setMeta("cameraSeedVersion", CAMERA_SEED_VERSION);
  fitCameras();
  updateHud();
}

function setupInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    el.btnInstallMenu.classList.add("install-ready");
    el.installHint.textContent =
      "Ready to install — tap the button above to add AWAS Alert to your home screen.";
  });

  window.addEventListener("appinstalled", () => {
    state.deferredInstall = null;
    el.btnInstallMenu.classList.remove("install-ready");
    el.installHint.textContent = "Installed. Open AWAS Alert from your home screen.";
    setStatus("App installed");
  });

  const triggerInstall = async () => {
    if (window.matchMedia("(display-mode: standalone)").matches) {
      alert("AWAS Alert is already running as an installed app.");
      return;
    }
    if (state.deferredInstall) {
      state.deferredInstall.prompt();
      const choice = await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      el.btnInstallMenu.classList.remove("install-ready");
      if (choice.outcome === "accepted") setStatus("Installing…");
      return;
    }
    alert(
      "Install not available yet.\n\nOn Android Chrome:\n1) Open this site over HTTPS (GitHub Pages)\n2) Use Chrome menu → Install app / Add to Home screen\n\nOr open ☰ after the first visit when install is ready."
    );
  };

  el.btnInstallMenu.addEventListener("click", triggerInstall);

  if (window.matchMedia("(display-mode: standalone)").matches) {
    el.btnInstallMenu.classList.remove("install-ready");
    el.installHint.textContent = "Running as installed app.";
  }
}

async function runDestinationSearch(query) {
  el.searchResults.innerHTML = '<li class="muted">Searching…</li>';
  el.recentBlock.classList.add("hidden");
  try {
    const results = await searchPlaces(query);
    el.searchResults.innerHTML = "";
    if (!results.length) {
      el.searchResults.innerHTML =
        '<li class="muted">No places found. Try another name, a recent place, or tap the map.</li>';
      renderRecentSearches();
      return;
    }
    for (const place of results) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = place.name;
      btn.addEventListener("click", async () => {
        openSearch(false);
        state.destMode = false;
        el.btnDest.classList.remove("active");
        await setDestination({
          lat: place.lat,
          lng: place.lng,
          name: place.name,
        });
      });
      li.appendChild(btn);
      el.searchResults.appendChild(li);
    }
  } catch (err) {
    el.searchResults.innerHTML = `<li class="muted">Search failed: ${escapeHtml(err.message)}</li>`;
    renderRecentSearches();
  }
}

function wireUi() {
  document.getElementById("btnMenu").addEventListener("click", () => openDrawer(true));
  document.getElementById("btnCloseDrawer").addEventListener("click", () => openDrawer(false));
  el.scrim.addEventListener("click", () => openDrawer(false));

  el.btnFollow.addEventListener("click", () => centerOnCar());

  el.btnDest.addEventListener("click", () => setDestMode(!state.destMode));
  el.btnRoutes.addEventListener("click", () => openRoutesPanel());
  document.getElementById("btnRoutesMenu").addEventListener("click", () => {
    openDrawer(false);
    openRoutesPanel();
  });
  document.getElementById("btnSetDest").addEventListener("click", () => {
    openDrawer(false);
    setDestMode(true);
  });
  document.getElementById("btnCloseSearch").addEventListener("click", () => setDestMode(false));
  el.searchForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    runDestinationSearch(el.searchInput.value);
  });
  document.getElementById("btnClearRecent").addEventListener("click", async () => {
    state.recentSearches = [];
    await setMeta("recentSearches", []);
    renderRecentSearches();
  });

  document.getElementById("btnClearNav").addEventListener("click", clearNavigation);
  document.getElementById("btnCloseRoutes").addEventListener("click", () => {
    closeRoutePicker();
    // Restore committed route styling if any
    if (state.navLine) state.navLine.setStyle({ opacity: 0.9, weight: 5 });
    clearAltLayers();
    el.hint.textContent = state.selectedRoute
      ? "Kept current route. Tap Route anytime to change."
      : "No route confirmed yet.";
  });
  el.btnConfirmRoute.addEventListener("click", () => confirmPendingRoute());

  document.getElementById("btnStopAlert").addEventListener("click", userStopAlert);
  document.getElementById("btnStopAlertMenu").addEventListener("click", userStopAlert);

  el.btnDemo.addEventListener("click", () => {
    if (state.demoActive) {
      stopDemo();
      stopAlertSound();
      setStatus("Demo stopped — GPS resumed");
    } else {
      startDemo();
    }
  });

  document.getElementById("btnSpeedDown").addEventListener("click", () => {
    adjustDemoSpeed(-10);
  });
  document.getElementById("btnSpeedUp").addEventListener("click", () => {
    adjustDemoSpeed(10);
  });

  document.getElementById("btnAddHere").addEventListener("click", async () => {
    const place = state.position;
    if (!place) {
      alert("Waiting for GPS fix — allow location permission, or run Demo from the menu.");
      return;
    }
    state.cameras.push({
      id: uid(),
      name: "AWAS (my location)",
      lat: place.lat,
      lng: place.lng,
      note: "Added at GPS",
    });
    await persistCameras();
    updateHud();
  });

  document.getElementById("btnResetCams").addEventListener("click", async () => {
    if (!confirm("Replace all cameras with the built-in LPT1/LPT2 list?")) return;
    await resetToLptCameras();
  });

  document.getElementById("btnClearCams").addEventListener("click", async () => {
    if (!confirm("Remove all cameras?")) return;
    state.cameras = [];
    await persistCameras();
    updateHud();
  });

  el.alertRadiusKm.addEventListener("change", () => {
    const km = Number(el.alertRadiusKm.value) || DEFAULT_ALERT_KM;
    state.alertRadiusM = km * 1000;
    setMeta("alertRadiusKm", km);
    updateHud();
  });

  el.alertVolume.addEventListener("input", () => {
    const pct = Number(el.alertVolume.value);
    state.alertVolume = pct / 100;
    el.volumeLabel.textContent = `${pct}%`;
    applyVolume();
    setMeta("alertVolume", pct);
    if (pct === 0) stopAlertSound();
  });

  el.routeMode.addEventListener("change", () => {
    if (el.routeMode.checked) {
      setDestMode(false);
      el.hint.textContent = "Manual corridor: tap start, then end on the map.";
    } else {
      el.hint.textContent =
        "GPS tracks automatically. Tap Search for a destination.";
    }
  });

  document.getElementById("btnClearRoute").addEventListener("click", () => {
    state.routePoints = [];
    drawCorridor();
    setMeta("route", []);
  });

  el.btnCacheRoute.addEventListener("click", cacheCurrentRoute);
  setupInstallPrompt();

  document.getElementById("btnExport").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.cameras, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "awas-cameras.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById("btnImport").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data)) throw new Error("Expected a JSON array");
      for (const item of data) {
        if (typeof item.lat !== "number" || typeof item.lng !== "number") continue;
        state.cameras.push({
          id: item.id || uid(),
          name: item.name || "AWAS",
          lat: item.lat,
          lng: item.lng,
          note: item.note || "Imported",
        });
      }
      const map = new Map(state.cameras.map((c) => [c.id, c]));
      state.cameras = [...map.values()];
      await persistCameras();
      updateHud();
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
    ev.target.value = "";
  });
}

async function boot() {
  initMap();
  wireUi();
  registerServiceWorker();
  setFollow(true, false);

  const seedVer = await getMeta("cameraSeedVersion", null);
  try {
    state.cameras = await loadCameras();
  } catch {
    state.cameras = [];
  }
  if (seedVer !== CAMERA_SEED_VERSION || !state.cameras.length) {
    state.cameras = LPT_CAMERAS.map((c) => ({ ...c }));
    await saveCameras(state.cameras);
    await setMeta("cameraSeedVersion", CAMERA_SEED_VERSION);
  }
  renderCameras();
  fitCameras();

  let radiusKm = await getMeta("alertRadiusKm", DEFAULT_ALERT_KM);
  const migrated = await getMeta("alertRadiusMigratedV2", false);
  if (!migrated && Number(radiusKm) === 1) {
    radiusKm = DEFAULT_ALERT_KM;
    await setMeta("alertRadiusKm", radiusKm);
  }
  await setMeta("alertRadiusMigratedV2", true);
  el.alertRadiusKm.value = radiusKm;
  state.alertRadiusM = Number(radiusKm) * 1000;

  const vol = await getMeta("alertVolume", 70);
  el.alertVolume.value = vol;
  state.alertVolume = Number(vol) / 100;
  el.volumeLabel.textContent = `${vol}%`;

  const demoKmh = await getMeta("demoSpeedKmh", DEFAULT_DEMO_KMH);
  state.demoSpeedKmh = Number(demoKmh) || DEFAULT_DEMO_KMH;
  updateDemoSpeedLabel();

  const recent = await getMeta("recentSearches", []);
  state.recentSearches = Array.isArray(recent) ? recent : [];

  const route = await getMeta("route", []);
  if (Array.isArray(route) && route.length) {
    state.routePoints = route;
    drawCorridor(false);
  }

  const dest = await getMeta("destination", null);
  const savedRoute = await getMeta("selectedRoute", null);
  if (dest && savedRoute?.points?.length) {
    state.destination = dest;
    state.destMarker = L.marker([dest.lat, dest.lng], { icon: destIcon() }).addTo(
      state.map
    );
    state.selectedRoute = {
      ...savedRoute,
      points: savedRoute.points,
    };
    const latlngs = savedRoute.points.map((p) => [p.lat, p.lng]);
    state.navLine = L.polyline(latlngs, {
      color: "#38bdf8",
      weight: 5,
      opacity: 0.9,
    }).addTo(state.map);
    el.navInfo.textContent = savedRoute.summary || "Saved route";
    el.btnCacheRoute.disabled = false;
  }
  renderRouteCameras();

  updateHud();
  setStatus(navigator.onLine ? "Online" : "Offline");
  window.addEventListener("online", () => setStatus("Online"));
  window.addEventListener("offline", () => setStatus("Offline — using cache"));

  // Always track GPS (no Track button)
  startTracking();
  setupWakeLock();
  setupBackButton();
}

/** Keep the web app open on Android/browser Back — close panels first, never exit. */
function setupBackButton() {
  const pushGuard = () => {
    try {
      history.pushState({ awas: true }, "", location.href);
    } catch {
      /* ignore */
    }
  };
  pushGuard();
  pushGuard();

  window.addEventListener("popstate", () => {
    // Re-arm so the next Back also stays in-app
    pushGuard();

    if (el.drawer.classList.contains("open")) {
      openDrawer(false);
      return;
    }
    if (!el.searchPanel.classList.contains("hidden")) {
      setDestMode(false);
      return;
    }
    if (!el.routePicker.classList.contains("hidden")) {
      closeRoutePicker();
      if (state.navLine) state.navLine.setStyle({ opacity: 0.9, weight: 5 });
      clearAltLayers();
      return;
    }
    // Nothing to close — stay on the map (do not leave the app)
    setStatus("Press Home to leave the app");
  });
}

boot();
