// 3D rendering: MapLibre GL (pitched basemap + extruded buildings) with a
// deck.gl overlay drawing trains as 3D meshes that move continuously along the
// real OSM track (dead-reckoning between polls).
//
// `maplibregl` and `deck` are UMD globals from index.html.

const CARTO_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const COLOURS = { inbound: [150, 99, 214], outbound: [201, 120, 235], "—": [150, 160, 170] };
const TRAIN_Z = 4; // metres; carriage half-height ~3.5 so it sits on the ground

let map;
let overlay;
let model;
let ready = false;
const trainState = new Map(); // id -> { corridor, simArc, targetArc, speed, colour, meta }
let lastFrame = 0;
let lastHitSync = 0;

// ---- public API (same surface main.js used for the 2D version) ----

export function initMap(trackModel, onStationClick) {
  model = trackModel;
  return new Promise((resolve) => {
    map = new maplibregl.Map({
      container: "map",
      style: CARTO_STYLE,
      center: [-0.06, 51.512],
      zoom: 12,
      pitch: 58,
      bearing: -18,
      antialias: true,
      maxPitch: 80,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
    map.dragRotate.enable();

    overlay = new deck.MapboxOverlay({ interleaved: true, layers: [] });
    map.addControl(overlay);

    map.on("load", () => {
      addBuildings();
      addRoute();
      addStations(onStationClick);
      addTrainHit();
      ready = true;
      startLoop();
      resolve();
    });
  });
}

// Fresh poll: reconcile each train with the new prediction; keep it moving.
export function updateTrains(trains) {
  const seen = new Set();
  for (const t of trains) {
    seen.add(t.id);
    const corridor = model.corridors.find((c) => c.id === t.corridorId);
    if (!corridor) continue;
    let st = trainState.get(t.id);
    const colour = COLOURS[t.direction] || COLOURS["—"];
    if (!st) {
      st = { corridor, simArc: t.arc, targetArc: t.arc, speed: t.speed, colour, meta: t };
      trainState.set(t.id, st);
    } else if (st.corridor.id !== corridor.id) {
      st.corridor = corridor;
      st.simArc = t.arc;
    } else {
      st.simArc += (t.arc - st.simArc) * 0.4; // smooth drift correction
    }
    st.targetArc = t.arc;
    st.speed = t.speed;
    st.colour = colour;
    st.meta = t;
  }
  for (const id of [...trainState.keys()]) if (!seen.has(id)) trainState.delete(id);
  document.getElementById("train-count").textContent = trains.length;
}

// ---- map setup ----

function addBuildings() {
  try {
    map.addLayer({
      id: "eliz-3d-buildings",
      source: "carto",
      "source-layer": "building",
      type: "fill-extrusion",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": [
          "interpolate", ["linear"], ["coalesce", ["get", "render_height"], 8],
          0, "#1c2029", 40, "#2c3340", 150, "#414b5c",
        ],
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.88,
      },
    });
  } catch (e) {
    console.warn("3D buildings unavailable on this basemap:", e.message);
  }
}

function addRoute() {
  const features = model.corridors.map((c) => ({
    type: "Feature",
    geometry: { type: "LineString", coordinates: c.coords.map(([la, lo]) => [lo, la]) },
  }));
  map.addSource("eliz-route", { type: "geojson", data: { type: "FeatureCollection", features } });
  map.addLayer({
    id: "eliz-route-glow",
    type: "line",
    source: "eliz-route",
    paint: { "line-color": "#a45bd6", "line-width": 8, "line-blur": 8, "line-opacity": 0.35 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
  map.addLayer({
    id: "eliz-route-line",
    type: "line",
    source: "eliz-route",
    paint: { "line-color": "#c98aff", "line-width": 2.5, "line-opacity": 0.9 },
    layout: { "line-cap": "round", "line-join": "round" },
  });
}

function addStations(onStationClick) {
  const features = [...model.stations.values()].map((s) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    properties: { id: s.id, name: s.name },
  }));
  map.addSource("eliz-stations", { type: "geojson", data: { type: "FeatureCollection", features } });
  map.addLayer({
    id: "eliz-stations",
    type: "circle",
    source: "eliz-stations",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2.5, 14, 5],
      "circle-color": "#0e1116",
      "circle-stroke-color": "#dfe3e7",
      "circle-stroke-width": 1.5,
    },
  });
  map.on("click", "eliz-stations", (e) => {
    const f = e.features[0];
    const s = model.station(f.properties.id);
    if (s) onStationClick(s);
  });
  map.on("mouseenter", "eliz-stations", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "eliz-stations", () => (map.getCanvas().style.cursor = ""));
}

// Invisible, generously-sized MapLibre circles that track the trains, used only
// as reliable click targets (deck picking on a per-frame mesh layer is flaky).
// The 3D mesh stays purely visual; this is what you actually click.
function addTrainHit() {
  map.addSource("eliz-train-hit", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({
    id: "eliz-train-hit",
    type: "circle",
    source: "eliz-train-hit",
    paint: { "circle-radius": 16, "circle-color": "#ffffff", "circle-opacity": 0.01 },
  });
  map.on("click", "eliz-train-hit", (e) => {
    const f = e.features[0];
    try {
      showTrainPopup([e.lngLat.lng, e.lngLat.lat], JSON.parse(f.properties.info));
    } catch {
      /* ignore malformed */
    }
  });
  map.on("mouseenter", "eliz-train-hit", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "eliz-train-hit", () => (map.getCanvas().style.cursor = ""));
}

// ---- continuous motion + 3D trains ----

function startLoop() {
  function frame(ts) {
    const dt = lastFrame ? Math.min((ts - lastFrame) / 1000, 1) : 0;
    lastFrame = ts;

    const bodies = [];
    const windows = [];
    const hitFeatures = [];
    for (const st of trainState.values()) {
      st.simArc += st.speed * dt; // forward dead reckoning along the real track

      // Multi-car train: each carriage sits a little further back along the
      // track, so the whole train articulates around real curves.
      for (let i = 0; i < NCARS; i++) {
        const p = model.posAt(st.corridor, st.simArc - i * CAR_SPACING);
        const inst = { position: [p.lon, p.lat, TRAIN_Z], yaw: 90 - p.bearing };
        bodies.push(inst);
        windows.push(inst);
      }

      const lead = model.posAt(st.corridor, st.simArc);
      hitFeatures.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lead.lon, lead.lat] },
        properties: {
          info: JSON.stringify({
            destination: st.meta.destinationName,
            next: st.meta.nextName,
            eta: st.meta.eta,
            direction: st.meta.direction,
            kmh: Math.round(st.speed * 3.6),
            corridor: `${st.corridor.from} → ${st.corridor.to}`,
          }),
        },
      });
    }
    if (overlay) {
      const common = {
        getPosition: (d) => d.position,
        getOrientation: (d) => [0, d.yaw, 90],
        sizeScale: 1,
        pickable: false,
        parameters: { depthTest: true },
      };
      overlay.setProps({
        layers: [
          new deck.SimpleMeshLayer({ id: "eliz-bodies", data: bodies, mesh: CAR_BODY, getColor: [214, 218, 224], ...common }),
          new deck.SimpleMeshLayer({ id: "eliz-windows", data: windows, mesh: CAR_WINDOWS, getColor: [22, 26, 34], ...common }),
        ],
      });
    }
    // Keep the invisible MapLibre click-target layer in sync (throttled).
    if (ts - lastHitSync > 120) {
      lastHitSync = ts;
      const src = map.getSource("eliz-train-hit");
      if (src) src.setData({ type: "FeatureCollection", features: hitFeatures });
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// A simple train-carriage box mesh (metres). Long axis = X, width = Y, height = Z.
function boxMesh(L, W, H) {
  const x = L / 2, y = W / 2, z = H / 2;
  const faces = [
    { n: [1, 0, 0], v: [[x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]] },
    { n: [-1, 0, 0], v: [[-x, y, -z], [-x, -y, -z], [-x, -y, z], [-x, y, z]] },
    { n: [0, 1, 0], v: [[x, y, -z], [-x, y, -z], [-x, y, z], [x, y, z]] },
    { n: [0, -1, 0], v: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
    { n: [0, 0, 1], v: [[x, -y, z], [x, y, z], [-x, y, z], [-x, -y, z]] },
    { n: [0, 0, -1], v: [[x, y, -z], [x, -y, -z], [-x, -y, -z], [-x, y, -z]] },
  ];
  const positions = [];
  const normals = [];
  const texCoords = [];
  const indices = [];
  faces.forEach((f, i) => {
    f.v.forEach((p) => {
      positions.push(...p);
      normals.push(...f.n);
      texCoords.push(0, 0);
    });
    const o = i * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  // deck.gl 9 SimpleMeshLayer expects the attributes-wrapper mesh shape.
  return {
    attributes: {
      positions: { value: new Float32Array(positions), size: 3 },
      normals: { value: new Float32Array(normals), size: 3 },
      texCoords: { value: new Float32Array(texCoords), size: 2 },
    },
    indices: { value: new Uint16Array(indices), size: 1 },
  };
}
// A full-length Elizabeth line train modelled as 9 carriages that articulate
// around curves. Dimensions are exaggerated a little so they read at city zoom.
const NCARS = 9;
const CAR_LEN = 22;
const CAR_SPACING = 24; // car length + coupling gap
// Light body box; a slightly wider, shorter, mid-height dark box reads as the
// continuous window band of a real EMU.
const CAR_BODY = boxMesh(CAR_LEN, 9, 7);
const CAR_WINDOWS = boxMesh(CAR_LEN - 4, 9.4, 2);

// ---- DOM chrome (unchanged from the 2D version) ----

// ---- anchored popup labels (rounded "speech-bubble" beside what you click) ----

let popup = null;
const dirWord = (d) => (d === "inbound" ? "inbound" : d === "outbound" ? "outbound" : "—");

function openPopup(lngLat, html) {
  if (popup) popup.remove();
  popup = new maplibregl.Popup({
    className: "eliz-popup",
    closeButton: true,
    closeOnClick: true,
    offset: 14,
    maxWidth: "260px",
  })
    .setLngLat([lngLat[0], lngLat[1]]) // guard against [lng,lat,z]
    .setHTML(html)
    .addTo(map);
}

// Train clicked: a rounded label bubble anchored at the train.
function showTrainPopup(lngLat, info) {
  openPopup(lngLat, `
    <div class="lbl">
      <div class="lbl-title">🚆 → ${esc(info.destination)}</div>
      <div class="kv"><span>Next stop</span><b>${esc(info.next)} · ${fmtEta(info.eta)}</b></div>
      <div class="kv"><span>Direction</span><b>${esc(dirWord(info.direction))}</b></div>
      <div class="kv"><span>Est. speed</span><b>${info.kmh} km/h</b></div>
      <div class="lbl-note">Estimated position — not GPS</div>
    </div>`);
}

// Station clicked: a rounded label bubble anchored at the station.
export function showStationPopup(station, arrivals) {
  const next = arrivals
    .slice()
    .sort((a, b) => a.timeToStation - b.timeToStation)
    .slice(0, 5)
    .map(
      (a) =>
        `<div class="arr"><span class="arr-dest">${esc(a.destinationName || "—")}</span>` +
        `<span class="arr-eta">${fmtEta(a.timeToStation)}</span></div>`
    )
    .join("");
  openPopup([station.lon, station.lat], `
    <div class="lbl">
      <div class="lbl-title">📍 ${esc(station.name)}</div>
      ${next ? `<div class="lbl-sub">Next trains</div>${next}` : `<div class="lbl-note">No predicted arrivals</div>`}
    </div>`);
}

export function setStatus(statusJson) {
  const el = document.getElementById("status-banner");
  const s = statusJson?.[0]?.lineStatuses?.[0];
  const desc = s?.statusSeverityDescription || "Status unavailable";
  const good = (s?.statusSeverity ?? 10) === 10;
  el.textContent = `Elizabeth line · ${desc}`;
  el.classList.toggle("good", good);
  el.classList.toggle("bad", !good);
}

export function setStats(stats) {
  const idNote = stats.fallback ? `${stats.real} id / ${stats.fallback} fallback` : "all via vehicleId";
  document.getElementById("stats").textContent = `${stats.shown} trackable · ${stats.hidden} too far · ${idNote}`;
}

function fmtEta(s) {
  if (s == null) return "—";
  return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`;
}
function esc(str) {
  return String(str ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
