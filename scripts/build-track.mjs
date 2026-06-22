// Bake real Elizabeth line track geometry into public/data/track.json.
//
// TfL's lineStrings are basically straight station-to-station lines (~2.4km
// between vertices). OpenStreetMap has the real rails (~49m between vertices),
// including tunnel curves and the Heathrow loop. Geometry is static and
// Overpass is slow/rate-limited, so we fetch once at build time and bake a
// static file the app loads instantly.
//
// Run:  node scripts/build-track.mjs
//
// Each directed full-corridor relation lists its track ways in order. We:
//   1. keep only track-role ways (drop platforms),
//   2. chain them by exact endpoint matching into one dense ordered polyline,
//   3. snap every TfL station onto the polyline (arc-length offset).
// Shorter services (Reading->Paddington, Shenfield->Liverpool St, ...) are
// subsets of these corridors and match at runtime by their station set.

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "public", "data", "track.json");
const CACHE = join(__dirname, ".osm-cache");

// Directed corridors covering every track segment in both directions.
const RELATIONS = [
  14773911, // Reading -> Abbey Wood
  14773912, // Abbey Wood -> Reading
  14773907, // Shenfield -> Heathrow Terminal 5
  14773905, // Heathrow Terminal 5 -> Shenfield
  14773908, // Heathrow Terminal 4 -> Abbey Wood
  14773906, // Abbey Wood -> Heathrow Terminal 4
];

// TfL ships a few station coordinates that don't sit on the real track.
// Custom House is ~1km north of the Elizabeth line in TfL's feed; correct it
// so it snaps to the OSM geometry (verified gap 18m vs 988m).
const NAME_COORD_OVERRIDES = {
  "Custom House": { lat: 51.5096, lon: 0.0277 },
};

const SNAP_MAX_M = 350; // covers Canary Wharf (292m); rejects off-line mis-snaps

const OVERPASS = "https://overpass-api.de/api/interpreter";
const UA = "elizabeth-line-live/1.0 (track geometry build)";
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const metres = (a, b) => {
  const dy = (a[0] - b[0]) * (Math.PI / 180) * R;
  const dx = (a[1] - b[1]) * (Math.PI / 180) * R * Math.cos(rad((a[0] + b[0]) / 2));
  return Math.hypot(dx, dy);
};
const eq = (a, b) => metres(a, b) < 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch a relation's geometry, cached to disk. Retries 429 (rate limit) with
// backoff so a polite re-run never re-hammers Overpass.
async function relationGeom(id) {
  const cacheFile = join(CACHE, `rel-${id}.json`);
  try {
    return JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {
    /* not cached yet */
  }
  const query = `[out:json][timeout:120];rel(${id});out geom;`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: "data=" + encodeURIComponent(query),
    });
    if (res.status === 429 || res.status === 504) {
      const wait = 8000 * (attempt + 1);
      process.stdout.write(`(rate-limited, waiting ${wait / 1000}s) `);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    const json = await res.json();
    await mkdir(CACHE, { recursive: true });
    await writeFile(cacheFile, JSON.stringify(json));
    return json;
  }
  throw new Error(`Overpass kept rate-limiting for relation ${id}`);
}

// Chain ordered track ways into one continuous [lat,lon] polyline.
function chain(ways) {
  const segs = ways.map((w) => w.geometry.map((g) => [g.lat, g.lon]));
  if (!segs.length) return [];
  const coords = [...segs[0]];
  if (segs.length > 1) {
    const t = coords[coords.length - 1];
    const h = coords[0];
    const n = segs[1];
    if (!(eq(t, n[0]) || eq(t, n[n.length - 1])) && (eq(h, n[0]) || eq(h, n[n.length - 1]))) coords.reverse();
  }
  for (let i = 1; i < segs.length; i++) {
    const tail = coords[coords.length - 1];
    let s = segs[i];
    if (eq(tail, s[s.length - 1]) && !eq(tail, s[0])) s = [...s].reverse();
    coords.push(...(eq(tail, s[0]) ? s.slice(1) : s));
  }
  return coords;
}

const cumulative = (coords) => {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + metres(coords[i - 1], coords[i]);
  return cum;
};

// Project a point onto the polyline; return arc-length + perpendicular gap.
function projectArc(pt, coords, cum) {
  let best = { gap: Infinity, arc: 0 };
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const sc = Math.cos(rad(a[0]));
    const bx = (b[1] - a[1]) * sc;
    const by = b[0] - a[0];
    const px = (pt[1] - a[1]) * sc;
    const py = pt[0] - a[0];
    const l2 = bx * bx + by * by || 1e-12;
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / l2));
    const dx = px - t * bx;
    const dy = py - t * by;
    const gap = Math.hypot(dx, dy) * (Math.PI / 180) * R;
    if (gap < best.gap) best = { gap, arc: cum[i - 1] + t * metres(a, b) };
  }
  return best;
}

const round = (coords) => coords.map(([la, lo]) => [Math.round(la * 1e5) / 1e5, Math.round(lo * 1e5) / 1e5]);

async function main() {
  console.log("Fetching TfL stations…");
  const tfl = await (await fetch("https://api.tfl.gov.uk/Line/elizabeth/Route/Sequence/all")).json();
  const stations = (tfl.stations || [])
    .filter((s) => typeof s.lat === "number")
    .map((s) => {
      const fix = NAME_COORD_OVERRIDES[s.name];
      return fix ? { ...s, lat: fix.lat, lon: fix.lon } : s;
    });
  console.log(`  ${stations.length} stations`);

  const out = {
    source: "OpenStreetMap via Overpass + TfL Unified API",
    stations: stations.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon })),
    corridors: [],
  };

  for (const id of RELATIONS) {
    process.stdout.write(`Relation ${id}… `);
    const data = await relationGeom(id);
    const rel = data.elements.find((e) => e.type === "relation");
    const ways = rel.members.filter(
      (m) => m.type === "way" && m.geometry && m.geometry.length >= 2 && (m.role === "" || m.role === undefined)
    );
    const coords = chain(ways);
    const cum = cumulative(coords);
    const length = cum[cum.length - 1];

    const snapped = [];
    for (const s of stations) {
      const { arc, gap } = projectArc([s.lat, s.lon], coords, cum);
      if (gap < SNAP_MAX_M) snapped.push({ id: s.id, arc: Math.round(arc) });
    }
    snapped.sort((a, b) => a.arc - b.arc);

    out.corridors.push({
      id,
      name: rel.tags?.name || String(id),
      from: rel.tags?.from || "",
      to: rel.tags?.to || "",
      length: Math.round(length),
      coords: round(coords),
      stations: snapped,
    });
    console.log(
      `${ways.length} ways → ${coords.length} pts, ${(length / 1000).toFixed(1)}km, ${snapped.length} stations`
    );
    await sleep(3000); // be polite between Overpass calls
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`\nWrote ${OUT} (${(JSON.stringify(out).length / 1024).toFixed(0)} KB, ${out.corridors.length} corridors)`);
}

main().catch((e) => {
  console.error("build-track failed:", e.message);
  process.exit(1);
});
