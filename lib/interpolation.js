// Core challenge: TfL exposes arrival PREDICTIONS, not train GPS.
// We reconstruct each train and place it on the REAL track curve by arc-length.
//
// Pipeline:
//   1. Group predictions into trains (vehicleId, with a defensive fallback).
//   2. Empirically derive per-segment travel times from prediction spreads.
//   3. For each train: pick the corridor it's travelling, then convert its
//      "seconds to next stop" into an arc-length position by walking backward
//      through the corridor's stations. Also emit a speed (m/s) for dead-reckoning.

const PLACEHOLDER = new Set(["", "0", "00", "000", "0000"]);
const isRealVehicleId = (v) => typeof v === "string" && !PLACEHOLDER.has(v.trim());

const DEFAULT_SEGMENT_S = 120;
const TRACK_HORIZON_S = 720; // hide trains whose nearest stop is >12 min away

const segKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function groupTrains(predictions) {
  const groups = new Map();
  let real = 0;
  let fallback = 0;
  for (const p of predictions) {
    let key;
    if (isRealVehicleId(p.vehicleId)) {
      key = `v:${p.vehicleId}`;
      real++;
    } else {
      key = `f:${p.destinationName}|${p.direction}|${p.platformName}`;
      fallback++;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return {
    trains: groups,
    stats: { totalPredictions: predictions.length, distinctTrains: groups.size, real, fallback },
  };
}

export function deriveSegmentTimes(trains, model) {
  const samples = new Map();
  const adjacent = (a, b) =>
    model.corridors.some((c) => {
      const aa = c.stationArc.get(a);
      const bb = c.stationArc.get(b);
      if (aa == null || bb == null) return false;
      for (const s of c.stations) if (s.arc > Math.min(aa, bb) + 1 && s.arc < Math.max(aa, bb) - 1) return false;
      return true;
    });

  for (const preds of trains.values()) {
    const sorted = [...preds].sort((a, b) => a.timeToStation - b.timeToStation);
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (!adjacent(a.naptanId, b.naptanId)) continue;
      const dt = b.timeToStation - a.timeToStation;
      if (dt <= 5 || dt > 1200) continue;
      const k = segKey(a.naptanId, b.naptanId);
      if (!samples.has(k)) samples.set(k, []);
      samples.get(k).push(dt);
    }
  }
  const table = new Map();
  const all = [];
  for (const [k, arr] of samples) {
    const m = median(arr);
    table.set(k, m);
    all.push(m);
  }
  return { table, globalMedian: all.length ? median(all) : DEFAULT_SEGMENT_S };
}

export function placeTrains(trains, model, segTimes) {
  const placed = [];
  let hidden = 0;

  for (const [key, preds] of trains) {
    let next = null;
    for (const p of preds) {
      if (model.station(p.naptanId) && (!next || p.timeToStation < next.timeToStation)) next = p;
    }
    if (!next) continue;
    if (next.timeToStation > TRACK_HORIZON_S) {
      hidden++;
      continue;
    }

    const afterNext = preds
      .filter((p) => p.naptanId !== next.naptanId && model.station(p.naptanId))
      .sort((a, b) => a.timeToStation - b.timeToStation)[0];

    const choice = model.chooseCorridor(
      next.naptanId,
      afterNext?.naptanId ?? null,
      next.destinationNaptanId ?? null
    );
    if (!choice) {
      hidden++;
      continue;
    }
    const { corridor, arcNext } = choice;
    const { arc, speed } = locateArc(model, corridor, segTimes, arcNext, next.naptanId, next.timeToStation);
    const pos = model.posAt(corridor, arc);

    placed.push({
      id: key,
      corridorId: corridor.id,
      arc,
      lat: pos.lat,
      lon: pos.lon,
      bearing: pos.bearing,
      speed,
      nextId: next.naptanId,
      nextName: model.station(next.naptanId).name,
      eta: next.timeToStation,
      destinationName: next.destinationName,
      direction: next.direction || "—",
    });
  }
  return { placed, hidden };
}

function locateArc(model, corridor, segTimes, arcNext, nextId, eta) {
  let toArc = arcNext;
  let toId = nextId;
  let remaining = eta;

  for (let hop = 0; hop < 40; hop++) {
    const prev = model.prevStationArc(corridor, toArc);
    if (!prev) break;
    const segM = toArc - prev.arc;
    const segS = segTimes.table.get(segKey(prev.id, toId)) ?? segTimes.globalMedian;
    const speed = segM / Math.max(segS, 1);
    if (remaining <= segS) {
      const progress = clamp(1 - remaining / segS, 0, 1);
      return { arc: prev.arc + progress * segM, speed };
    }
    remaining -= segS;
    toArc = prev.arc;
    toId = prev.id;
  }
  return { arc: toArc, speed: 0 };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
