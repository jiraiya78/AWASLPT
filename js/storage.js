const DB_NAME = "awas-alert";
const DB_VERSION = 1;
const STORE_CAMERAS = "cameras";
const STORE_META = "meta";

/** Bump when built-in camera set changes — forces replace of stored list. */
export const CAMERA_SEED_VERSION = "lpt-2026-10-c";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CAMERAS)) {
        db.createObjectStore(STORE_CAMERAS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("aborted"));
  });
}

export async function loadCameras() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CAMERAS, "readonly");
    const req = tx.objectStore(STORE_CAMERAS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCameras(cameras) {
  const db = await openDb();
  const tx = db.transaction(STORE_CAMERAS, "readwrite");
  const store = tx.objectStore(STORE_CAMERAS);
  store.clear();
  for (const cam of cameras) store.put(cam);
  await txDone(tx);
}

export async function setMeta(key, value) {
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readwrite");
  tx.objectStore(STORE_META).put({ key, value });
  await txDone(tx);
}

export async function getMeta(key, fallback = null) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, "readonly");
    const req = tx.objectStore(STORE_META).get(key);
    req.onsuccess = () =>
      resolve(req.result ? req.result.value : fallback);
    req.onerror = () => reject(req.error);
  });
}

export function uid() {
  return `cam_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Built-in AWAS cameras along LPT1 / LPT2. */
export const LPT_CAMERAS = [
  {
    id: "lpt1_km145",
    name: "KM 145 LPT1",
    lat: 3.5692182,
    lng: 102.5581691,
    note: "LPT1",
  },
  {
    id: "lpt1_km194_1",
    name: "KM 194.1 LPT1",
    lat: 3.7236342,
    lng: 102.9254174,
    note: "LPT1",
  },
  {
    id: "lpt1_km256_1",
    name: "KM 256.1 LPT1",
    lat: 3.9889793,
    lng: 103.3027028,
    note: "LPT1",
  },
  {
    id: "lpt2_km288_6",
    name: "KM 288.6 LPT2",
    lat: 4.2593019,
    lng: 103.3083282,
    note: "LPT2",
  },
  {
    id: "lpt2_km341_1",
    name: "KM 341.1 LPT2",
    lat: 4.6724772,
    lng: 103.3297374,
    note: "LPT2",
  },
  {
    id: "lpt2_km381_0",
    name: "KM 381.0 LPT2",
    lat: 4.9235458,
    lng: 103.1371781,
    note: "LPT2",
  },
  {
    id: "jerteh",
    name: "Jerteh",
    lat: 5.738231,
    lng: 102.493848,
    note: "Landmark",
  },
  {
    id: "keropok_sofia",
    name: "Keropok Sofia",
    lat: 5.841586,
    lng: 102.531499,
    note: "Landmark",
  },
];

/** @deprecated use LPT_CAMERAS */
export const SAMPLE_CAMERAS = LPT_CAMERAS;
