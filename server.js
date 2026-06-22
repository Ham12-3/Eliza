// Backend proxy for the TfL Unified API.
//
// Responsibilities:
//  - Hide the optional app_key (read from env, never sent to the browser).
//  - Cache upstream responses briefly so polling clients don't hammer TfL.
//  - Expose a tiny, stable surface the frontend can poll.
//
// The frontend NEVER calls api.tfl.gov.uk directly — only this proxy.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const APP_KEY = process.env.TFL_APP_KEY || "";
const TFL_BASE = "https://api.tfl.gov.uk";
const LINE = "elizabeth";

// Cache TTLs (ms). Route geometry barely changes; arrivals are volatile.
const TTL = {
  route: 6 * 60 * 60 * 1000, // 6h
  arrivals: 15 * 1000, // 15s — below the 20-30s client poll
  status: 60 * 1000, // 60s
};

const app = express();
const cache = new Map(); // key -> { expires, payload }

function withKey(url) {
  if (!APP_KEY) return url;
  const u = new URL(url);
  u.searchParams.set("app_key", APP_KEY);
  return u.toString();
}

// Fetch with a couple of retries — Node's global fetch occasionally throws
// "fetch failed" on the first cold connection (DNS/TLS warmup).
async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
      if (!res.ok) throw new Error(`TfL ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

// Fetch + cache. Serves stale data on upstream failure if we have any, so a
// transient TfL hiccup doesn't blank the map.
async function getCached(key, url, ttl) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.payload;

  try {
    const payload = await fetchWithRetry(withKey(url));
    cache.set(key, { expires: now + ttl, payload });
    return payload;
  } catch (err) {
    if (hit) {
      console.warn(`[proxy] upstream failed for ${key}, serving stale:`, err.message);
      return hit.payload;
    }
    throw err;
  }
}

function handler(key, urlFn, ttl) {
  return async (_req, res) => {
    try {
      const data = await getCached(key, urlFn(), ttl);
      res.set("Cache-Control", "no-store");
      res.json(data);
    } catch (err) {
      console.error(`[proxy] ${key} failed:`, err.message);
      res.status(502).json({ error: "Upstream TfL request failed", detail: err.message });
    }
  };
}

app.get(
  "/api/route",
  handler("route", () => `${TFL_BASE}/Line/${LINE}/Route/Sequence/all`, TTL.route)
);
app.get(
  "/api/arrivals",
  handler("arrivals", () => `${TFL_BASE}/Line/${LINE}/Arrivals`, TTL.arrivals)
);
app.get(
  "/api/status",
  handler("status", () => `${TFL_BASE}/Line/${LINE}/Status`, TTL.status)
);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, appKey: APP_KEY ? "set" : "absent", cached: [...cache.keys()] });
});

// Serve the frontend with no-store so iterating on JS/CSS never serves a stale
// cached bundle during development.
app.use(
  express.static(join(__dirname, "public"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set("Cache-Control", "no-store"),
  })
);

app.listen(PORT, () => {
  console.log(`Elizabeth line live → http://localhost:${PORT}`);
  console.log(`TfL app_key: ${APP_KEY ? "configured" : "not set (lower rate limits)"}`);
});
