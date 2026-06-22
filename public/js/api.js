// Thin client. Live data comes via our proxy; track geometry is a baked static
// file (real OSM rails), never fetched from TfL.

async function getJSON(path) {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

export const api = {
  track: () => getJSON("/data/track.json"),
  arrivals: () => getJSON("/api/arrivals"),
  status: () => getJSON("/api/status"),
};
