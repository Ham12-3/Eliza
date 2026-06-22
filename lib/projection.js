// Project lat/lon to a local flat 3D plane (metres), centred on the station
// centroid. Used to lay the network out by coordinates (no map tiles).

export function makeProjection(stations) {
  let a = 0, b = 0;
  for (const s of stations) { a += s.lat; b += s.lon; }
  const lat0 = a / stations.length;
  const lon0 = b / stations.length;
  const mLat = 110540;
  const mLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return {
    x: (lon) => (lon - lon0) * mLon,
    z: (lat) => -(lat - lat0) * mLat, // north -> -z
  };
}
