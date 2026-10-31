# AWAS Alert (prototype)

A simple **static** web app — like a lightweight Maps/Waze HUD — that warns when you approach user-marked AWAS (traffic camera) GPS points.

**Hostable on GitHub Pages** (no backend, no build step).

## Features

- Free map: [Leaflet](https://leafletjs.com/) + [OpenStreetMap](https://www.openstreetmap.org/) tiles
- Tap map to add AWAS camera markers (saved in **IndexedDB** on the device)
- **Track** mode: live GPS, estimated speed from `GeolocationCoordinates.speed` or successive fixes
- Alert within configurable radius (default **1 km**): banner + soft beep
- HUD: distance to nearest cam, ETA, speed, proximity bar (green → yellow → orange/red)
- **Demo** mode: simulated drive toward a sample camera (KL area samples included)
- **Offline route cache**: pick start/end, download map tiles into Cache Storage; cameras stay local
- Export / import cameras as JSON
- Service worker caches the app shell for weak/no signal stretches

> Personal awareness prototype only. Do not use the phone while driving. Camera positions are user-supplied samples — not an official AWAS database.

## Try locally

Any static server works. Examples:

```bash
# Python
python -m http.server 8080

# Node
npx --yes serve .
```

Open `http://localhost:8080`. On a phone, use **HTTPS** (or localhost) so GPS works.

## Deploy to GitHub Pages (`*.github.io`)

1. Create a GitHub repo and push this project (e.g. `AWASAlert`).
2. **Settings → Pages → Build and deployment**
   - Source: **Deploy from a branch**
   - Branch: `main` (or `master`), folder: **/ (root)**
3. Wait a minute, then open:
   - Project site: `https://<user>.github.io/AWASAlert/`
   - Or rename the repo to `<user>.github.io` for a root site.

Paths in the app are relative (`./`), so both root and project Pages URLs work.

Optional: enable the workflow in `.github/workflows/pages.yml` if you prefer Actions-based Pages.

### Phone tip

Add to Home Screen (PWA manifest included). Allow location when using **Track**. Use **Demo** to test alerts without driving.

### Offline tip

1. Open the menu → enable **Route pick mode**
2. Tap map for start, then end
3. Tap **Cache route offline** (needs network once)
4. Cameras are already on-device; cached tiles serve when OSM is unreachable

## Limits (prototype)

- Straight-line corridor cache (not full turn-by-turn routing)
- OSM public tiles: fine for demos; heavy production use needs your own tile provider
- Background tracking may pause when the browser is suspended
- Speed is an estimate; not a certified speedometer

## License

Prototype code is free to use and adapt. Map data © OpenStreetMap contributors.
