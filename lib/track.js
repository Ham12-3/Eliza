// Track model, built from the baked public/data/track.json (real OSM geometry).
//
// Provides:
//  - stations:  Map<id, {id,name,lat,lon}>
//  - corridors: directed dense polylines with per-station arc-length offsets
//  - posAt(corridor, arc): {lat,lon,bearing} anywhere along the real curve
//  - chooseCorridor(...): pick the corridor a train is travelling on

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
function metres(a, b) {
  const dy = (a[0] - b[0]) * (Math.PI / 180) * R;
  const dx = (a[1] - b[1]) * (Math.PI / 180) * R * Math.cos(rad((a[0] + b[0]) / 2));
  return Math.hypot(dx, dy);
}

export function buildTrackModel(json) {
  const stations = new Map(json.stations.map((s) => [s.id, s]));
  const corridors = json.corridors.map((c) => {
    const cum = [0];
    for (let i = 1; i < c.coords.length; i++) cum[i] = cum[i - 1] + metres(c.coords[i - 1], c.coords[i]);
    const stationArc = new Map(c.stations.map((s) => [s.id, s.arc]));
    return { ...c, cum, stationArc };
  });
  return new TrackModel(stations, corridors);
}

class TrackModel {
  constructor(stations, corridors) {
    this.stations = stations;
    this.corridors = corridors;
  }

  station(id) {
    return this.stations.get(id);
  }

  // Position + heading at an arc-length along a corridor's real curve.
  posAt(corridor, arc) {
    const { coords, cum } = corridor;
    const target = Math.max(0, Math.min(arc, cum[cum.length - 1]));
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo);
    const a = coords[i - 1];
    const b = coords[i];
    const segLen = cum[i] - cum[i - 1] || 1;
    const t = (target - cum[i - 1]) / segLen;
    const lat = a[0] + (b[0] - a[0]) * t;
    const lon = a[1] + (b[1] - a[1]) * t;
    const east = (b[1] - a[1]) * Math.cos(rad((a[0] + b[0]) / 2));
    const north = b[0] - a[0];
    const bearing = (deg(Math.atan2(east, north)) + 360) % 360;
    return { lat, lon, bearing };
  }

  // Choose the corridor a train is on, given its next stop, the stop after it,
  // and its destination. A corridor matches when the train's stops fall on it
  // in increasing arc order (i.e. the direction of travel).
  chooseCorridor(nextId, afterId, destId) {
    let best = null;
    for (const c of this.corridors) {
      const aNext = c.stationArc.get(nextId);
      if (aNext == null) continue;
      let score = 0;
      let directional = false;
      if (afterId != null && c.stationArc.has(afterId)) {
        if (c.stationArc.get(afterId) > aNext) {
          directional = true;
          score += 2;
        } else continue;
      }
      if (destId != null && c.stationArc.has(destId)) {
        if (c.stationArc.get(destId) >= aNext) {
          directional = directional || afterId == null;
          score += 1;
        }
      }
      if (!directional) continue;
      if (!best || score > best.score) best = { corridor: c, arcNext: aNext, score };
    }
    return best;
  }

  // Station immediately before `arc` on a corridor (largest station arc < arc).
  prevStationArc(corridor, arc) {
    let best = null;
    for (const s of corridor.stations) {
      if (s.arc < arc - 1 && (!best || s.arc > best.arc)) best = s;
    }
    return best;
  }
}
