// Orchestration: load the baked real-track model once, then poll arrivals +
// status, recompute arc-length positions, and feed the renderer (which animates
// continuous motion along the real curve between polls).

import { api } from "./api.js";
import { buildTrackModel } from "./track.js";
import { groupTrains, deriveSegmentTimes, placeTrains } from "./interpolation.js";
import * as render from "./render.js";

const POLL_MS = 25000;

let model;
let latestArrivals = [];

async function boot() {
  try {
    const track = await api.track();
    model = buildTrackModel(track);
  } catch (err) {
    fatal("Could not load the baked track geometry (public/data/track.json).", err);
    return;
  }
  await render.initMap(model, onStationClick); // resolves when the 3D map is ready

  await tick();
  setInterval(tick, POLL_MS);
}

async function tick() {
  try {
    const [arrivals, status] = await Promise.all([api.arrivals(), api.status()]);
    latestArrivals = arrivals;

    const { trains, stats } = groupTrains(arrivals);
    const segTimes = deriveSegmentTimes(trains, model);
    const { placed, hidden } = placeTrains(trains, model, segTimes);

    render.updateTrains(placed);
    render.setStats({ ...stats, shown: placed.length, hidden });
    render.setStatus(status);

    console.debug(`[tick] ${stats.distinctTrains} trains, shown ${placed.length}, hidden ${hidden}`);
  } catch (err) {
    console.error("[tick] poll failed:", err);
  }
}

function onStationClick(station) {
  const forStation = latestArrivals.filter((a) => a.naptanId === station.id);
  render.showStationPopup(station, forStation);
}

function fatal(msg, err) {
  console.error(msg, err);
  const banner = document.getElementById("status-banner");
  banner.textContent = msg;
  banner.classList.add("bad");
}

boot();
