// Server-side TfL proxy: hides the optional app_key and caches responses so the
// browser polling 25s doesn't hammer TfL. Used by the /api route handlers.

const TFL_BASE = "https://api.tfl.gov.uk";
const APP_KEY = process.env.TFL_APP_KEY || "";
const cache = new Map(); // key -> { expires, payload }

function withKey(url) {
  if (!APP_KEY) return url;
  const u = new URL(url);
  u.searchParams.set("app_key", APP_KEY);
  return u.toString();
}

async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`TfL ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

// path e.g. "/Line/elizabeth/Arrivals"; ttl in ms.
export async function tfl(key, path, ttl) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.payload;
  try {
    const payload = await fetchWithRetry(withKey(`${TFL_BASE}${path}`));
    cache.set(key, { expires: now + ttl, payload });
    return payload;
  } catch (err) {
    if (hit) return hit.payload; // serve stale on upstream failure
    throw err;
  }
}
