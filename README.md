# Elizabeth line — live 3D (estimated)

A real-time **3D** visualisation of London's Elizabeth line. Trains move
continuously as 3D meshes along the **real track geometry** (the actual rails,
including tunnel curves and the Heathrow loop), over a pitched map with extruded
3D buildings, driven by live [TfL Unified API](https://api.tfl.gov.uk) arrival
predictions.

The view is a tilted 3D map (MapLibre GL) with extruded buildings; trains are 3D
carriage meshes (deck.gl) oriented to their direction of travel. Drag to rotate,
right-drag / ctrl-drag to tilt, scroll to zoom.

## ⚠️ Important: positions are estimated, not GPS

**The TfL API does not expose the GPS position of individual trains.** It exposes
*arrival predictions per stop* (countdown to the next trains at each station).

This app reconstructs each train and places it on the real track by **arc-length
interpolation**:

1. Arrival predictions are grouped into individual trains (by `vehicleId`, with a
   fallback to `destination + direction + platform` when the id is missing).
2. Per-segment travel times are derived empirically from the spread of predictions
   across consecutive stops (no hardcoded timetable).
3. Each train is matched to the directed **corridor** it is travelling, then its
   "seconds to next stop" is converted into a position *along the real curve* by
   walking backward through the corridor's stations.
4. Between polls the renderer **dead-reckons** each train forward along the track
   at its derived speed, so motion is continuous and smooth; each new poll gently
   reconciles drift. Train icons point in the direction of travel.

Positions are **approximate** and can jitter on the sparse outer branches. A train
whose nearest predicted stop is more than ~12 minutes away can't be located with
confidence, so it is **hidden** rather than placed wrongly. The header shows how
many trains are trackable vs. hidden.

## Real track geometry

TfL's `lineStrings` are basically straight station-to-station lines (~2.4 km between
vertices), which look flat when you zoom in. The real rails come from
**OpenStreetMap** (~49 m between vertices). `scripts/build-track.mjs` fetches the
directed Elizabeth line route relations from the Overpass API, chains each
relation's track ways into one dense ordered polyline, snaps every TfL station onto
it (arc-length), and bakes `public/data/track.json` (~130 KB).

Geometry is static, so it's baked at build time — the running app never calls
Overpass. Regenerate it with:

```bash
npm run build:track     # refetches OSM, rewrites public/data/track.json
```

(Cached per-relation under `scripts/.osm-cache/`; Overpass 429s are retried with backoff.)

## Architecture

```
server.js                Express proxy: hides the app_key, caches TfL responses,
                         serves the static frontend. The browser never calls TfL.
scripts/build-track.mjs  Build-time: bake real OSM track into public/data/track.json
public/
  data/track.json        Baked real track geometry + station arc-lengths
  index.html             Single-page app shell (MapLibre GL + deck.gl via CDN)
  css/styles.css
  js/
    api.js               Thin client (proxy for live data, static track.json)
    track.js             Track model: corridors, posAt(arc)->{lat,lon,bearing}
    interpolation.js     Train identity + segment times + arc-length placement (pure)
    render.js            MapLibre 3D map + extruded buildings + deck.gl 3D trains
    main.js              Orchestration: load track once, poll arrivals + status
```

The 3D basemap uses CARTO's keyless vector style; buildings are extruded from its
`building` source-layer. No map API key required.

`interpolation.js` and `track.js` are pure (no DOM) and testable on their own;
`render.js` owns everything visual; `main.js` wires them together.

## Running it

```bash
npm install
npm start            # http://localhost:3000
PORT=4180 npm start  # if 3000 is taken
```

Optional: a free [TfL API key](https://api-portal.tfl.gov.uk/) raises rate limits.
Copy `.env.example` to `.env` and set `TFL_APP_KEY`. The key stays server-side.

## Data sources

| Source                       | Used for                              |
| ---------------------------- | ------------------------------------- |
| TfL `/Line/elizabeth/Arrivals` (proxied) | Live arrival predictions  |
| TfL `/Line/elizabeth/Status` (proxied)   | Line status / disruptions |
| OpenStreetMap (Overpass, baked)          | Real track geometry       |

## Quirks handled

- **No train GPS** — positions are interpolated onto the real track (see above).
- **Placeholder `vehicleId`s** — missing/`"000"` ids fall back to grouping by
  `destination + direction + platform`; the header reports the split.
- **Direction inference** — a train is matched to the directed corridor where its
  upcoming stops appear in increasing arc order.
- **Far-future predictions** — roughly half the feed is stops 20–95 min out; these
  are hidden, not guessed.
- **Bad TfL coordinate** — Custom House is ~1 km off in TfL's data; corrected in the
  track build so it snaps to the real line.

## Limitations

- Positions are estimates; treat the map as indicative, not authoritative.
- Dead-reckoning can briefly overshoot a stop between polls on sharp slowdowns; the
  next poll corrects it.
- Anonymous API rate limits apply without an `app_key`.
