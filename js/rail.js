/**
 * rail.js
 * Lightweight client-side rail-path approximation. Exposed as window.RailRouter.
 *
 *   RailRouter.route(from, to) -> Promise<number[][] | null>
 *
 * How it works (no API key, no transit backend):
 *  1. Build a narrow corridor polygon between the two points.
 *  2. Ask Overpass (OpenStreetMap) for the main running rail lines inside it.
 *  3. Assemble a connectivity graph from the rail ways (ways share node ids).
 *  4. Snap each endpoint to the nearest rail node and run Dijkstra along the
 *     tracks, returning the path geometry (city → rail → … → rail → city).
 *
 * Returns null (caller falls back to a straight line) when: the leg is too long
 * to snap cheaply, Overpass is unreachable/slow, or no connected rail path is
 * found. Everything is wrapped in guards + a timeout so it can only degrade.
 *
 * This is an approximation — it follows real OSM track geometry but does not
 * know schedules, electrification, gauge or whether a passenger service exists.
 */
(function () {
  const ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const MAX_LEG_KM = 500; // beyond this, corridor data gets too big — skip
  const TIMEOUT_MS = 12000;
  const MAX_NODES = 40000; // guard against pathological graph sizes

  const cache = new Map();

  // ── Geometry helpers ─────────────────────────────────────────────────
  const R = 6371; // km
  const rad = (d) => (d * Math.PI) / 180;
  function haversine(aLat, aLng, bLat, bLng) {
    const dLat = rad(bLat - aLat);
    const dLng = rad(bLng - aLng);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // A rectangle hugging the straight line, `widthKm` to each side.
  function corridorPolygon(a, b, widthKm) {
    const latC = rad((a.lat + b.lat) / 2);
    const kmPerLat = 110.574;
    const kmPerLng = 111.32 * Math.cos(latC);
    const vx = (b.lng - a.lng) * kmPerLng;
    const vy = (b.lat - a.lat) * kmPerLat;
    const len = Math.hypot(vx, vy) || 1;
    const px = -vy / len; // perpendicular unit (km space)
    const py = vx / len;
    const toLL = (p, dxKm, dyKm) => ({
      lat: p.lat + dyKm / kmPerLat,
      lng: p.lng + dxKm / kmPerLng,
    });
    const w = widthKm;
    return [
      toLL(a, px * w, py * w),
      toLL(b, px * w, py * w),
      toLL(b, -px * w, -py * w),
      toLL(a, -px * w, -py * w),
    ];
  }

  // ── Overpass fetch ───────────────────────────────────────────────────
  // Shared Overpass POST with timeout + mirror fallback. Returns elements[] or null.
  async function overpass(query) {
    const D = window.DebugLog;
    for (const url of ENDPOINTS) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const started = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!res.ok) {
          D && D.warn(`Overpass HTTP ${res.status} from ${host(url)}`);
          continue;
        }
        const data = await res.json();
        const n = data && Array.isArray(data.elements) ? data.elements.length : 0;
        D && D.info(`Overpass ${host(url)} → ${n} elements (${Date.now() - started}ms)`);
        if (data && Array.isArray(data.elements)) return data.elements;
      } catch (e) {
        clearTimeout(t);
        D && D.warn(`Overpass ${host(url)} failed: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      }
    }
    D && D.error('Overpass: all endpoints failed');
    return null;
  }
  function host(url) {
    try { return new URL(url).host; } catch (e) { return url; }
  }

  async function fetchRail(poly) {
    const polyStr = poly.map((p) => `${p.lat.toFixed(5)} ${p.lng.toFixed(5)}`).join(' ');
    // railway=rail running lines, excluding yard/siding/spur service tracks.
    const query =
      `[out:json][timeout:25];` +
      `way["railway"="rail"]["service"!~"."](poly:"${polyStr}");` +
      `out geom;`;
    return overpass(query);
  }

  // ── Station resolution ───────────────────────────────────────────────
  const STATION_RADIUS = 25000; // metres to search around a city pin
  const MAIN_KEYWORDS = [
    'centrale', 'central', 'centraal', 'zentral', 'hauptbahnhof', 'hbf',
    'termini', 'huvudstation', 'glowny', 'central station', 'hovedbanegard',
  ];
  const stationCache = new Map();

  // Normalise a name for loose matching (lowercase, strip accents/punctuation).
  function norm(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Pick the best railway station for a place:
   *  - if a station name closely matches the city name, use it (preferring the
   *    "main"/central station when several match);
   *  - otherwise use the station nearest the city pin.
   * @returns {Promise<{name,lat,lng}|null>}
   */
  async function resolveStation(place) {
    if (!place || place.lat == null || place.lng == null) return null;
    const key = `${place.lat.toFixed(3)},${place.lng.toFixed(3)}|${norm(place.name)}`;
    if (stationCache.has(key)) return stationCache.get(key);

    const query =
      `[out:json][timeout:25];` +
      `(node["railway"="station"](around:${STATION_RADIUS},${place.lat},${place.lng});` +
      `node["railway"="halt"](around:${STATION_RADIUS},${place.lat},${place.lng}););` +
      `out body;`;

    const D = window.DebugLog;
    let result = null;
    try {
      const elements = await overpass(query);
      const cands = (elements || [])
        .filter((e) => e.tags && e.tags.name && e.lat != null)
        .map((e) => ({ name: e.tags.name, lat: e.lat, lng: e.lon, n: norm(e.tags.name) }));
      D && D.info(`Station search "${place.name}" → ${cands.length} stations`);
      if (cands.length) {
        const city = norm(place.name);
        cands.forEach((c) => {
          c.dist = haversine(place.lat, place.lng, c.lat, c.lng);
        });
        // Close name match: station name contains the city (or vice-versa).
        const close =
          city.length >= 3
            ? cands.filter((c) => c.n.includes(city) || city.includes(c.n.split(' ')[0]))
            : [];
        let pool;
        if (close.length) {
          const mains = close.filter((c) => MAIN_KEYWORDS.some((k) => c.n.includes(k)));
          pool = mains.length ? mains : close;
        } else {
          pool = cands; // no name match → nearest station by distance
        }
        pool.sort((a, b) => a.dist - b.dist);
        const best = pool[0];
        result = { name: best.name, lat: best.lat, lng: best.lng };
        D && D.info(
          `Station for "${place.name}": ${best.name} ` +
          `(${close.length ? 'name match' : 'nearest'}, ${best.dist.toFixed(1)}km)`
        );
      } else {
        D && D.warn(`No station found near "${place.name}"`);
      }
    } catch (e) {
      D && D.error(`Station resolve error for "${place.name}": ${e.message}`);
    }
    stationCache.set(key, result);
    return result;
  }

  // ── Graph + Dijkstra ─────────────────────────────────────────────────
  function buildGraph(elements) {
    const coords = new Map(); // nodeId -> [lat, lng]
    const adj = new Map(); // nodeId -> [{ to, w }]
    const addEdge = (a, b, w) => {
      if (!adj.has(a)) adj.set(a, []);
      adj.get(a).push({ to: b, w });
    };
    for (const el of elements) {
      if (el.type !== 'way' || !el.nodes || !el.geometry) continue;
      for (let i = 0; i < el.nodes.length; i += 1) {
        const id = el.nodes[i];
        const g = el.geometry[i];
        if (g && !coords.has(id)) coords.set(id, [g.lat, g.lon]);
      }
      for (let i = 0; i < el.nodes.length - 1; i += 1) {
        const a = el.nodes[i];
        const b = el.nodes[i + 1];
        const ga = el.geometry[i];
        const gb = el.geometry[i + 1];
        if (!ga || !gb) continue;
        const w = haversine(ga.lat, ga.lon, gb.lat, gb.lon);
        addEdge(a, b, w);
        addEdge(b, a, w);
      }
    }
    return { coords, adj };
  }

  function nearestNode(coords, lat, lng) {
    let best = null;
    let bestD = Infinity;
    for (const [id, c] of coords) {
      const d = haversine(lat, lng, c[0], c[1]);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  // Minimal binary min-heap keyed by distance.
  function MinHeap() {
    const h = [];
    const up = (i) => {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (h[p][0] <= h[i][0]) break;
        [h[p], h[i]] = [h[i], h[p]];
        i = p;
      }
    };
    const down = (i) => {
      const n = h.length;
      for (;;) {
        let s = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < n && h[l][0] < h[s][0]) s = l;
        if (r < n && h[r][0] < h[s][0]) s = r;
        if (s === i) break;
        [h[s], h[i]] = [h[i], h[s]];
        i = s;
      }
    };
    return {
      push(item) {
        h.push(item);
        up(h.length - 1);
      },
      pop() {
        const top = h[0];
        const last = h.pop();
        if (h.length) {
          h[0] = last;
          down(0);
        }
        return top;
      },
      get size() {
        return h.length;
      },
    };
  }

  function dijkstra(adj, coords, startId, goalId) {
    const dist = new Map([[startId, 0]]);
    const prev = new Map();
    const done = new Set();
    const heap = MinHeap();
    heap.push([0, startId]);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (done.has(u)) continue;
      done.add(u);
      if (u === goalId) break;
      const edges = adj.get(u) || [];
      for (const { to, w } of edges) {
        if (done.has(to)) continue;
        const nd = d + w;
        if (nd < (dist.get(to) ?? Infinity)) {
          dist.set(to, nd);
          prev.set(to, u);
          heap.push([nd, to]);
        }
      }
    }
    if (!prev.has(goalId) && startId !== goalId) return null;
    const path = [];
    let cur = goalId;
    while (cur !== undefined) {
      const c = coords.get(cur);
      if (c) path.push(c);
      if (cur === startId) break;
      cur = prev.get(cur);
    }
    return path.reverse();
  }

  // ── Public entry ─────────────────────────────────────────────────────
  async function route(from, to) {
    if (
      !from || !to ||
      from.lat == null || from.lng == null ||
      to.lat == null || to.lng == null
    ) {
      return null;
    }
    const D = window.DebugLog;
    const distKm = haversine(from.lat, from.lng, to.lat, to.lng);
    if (distKm < 1 || distKm > MAX_LEG_KM) {
      D && D.warn(`Rail skip: leg ${distKm.toFixed(0)}km out of range (1–${MAX_LEG_KM}km)`);
      return null;
    }

    const key = `${from.lat.toFixed(3)},${from.lng.toFixed(3)}->${to.lat.toFixed(3)},${to.lng.toFixed(3)}`;
    if (cache.has(key)) return cache.get(key);

    try {
      const widthKm = Math.min(35, Math.max(12, distKm * 0.12));
      D && D.info(`Rail route ${distKm.toFixed(0)}km, corridor ±${widthKm.toFixed(0)}km`);
      const elements = await fetchRail(corridorPolygon(from, to, widthKm));
      if (!elements || !elements.length) {
        D && D.warn('Rail fallback: no rail ways returned for corridor');
        cache.set(key, null);
        return null;
      }
      const { coords, adj } = buildGraph(elements);
      D && D.info(`Rail graph: ${coords.size} nodes from ${elements.length} ways`);
      if (!coords.size || coords.size > MAX_NODES) {
        D && D.warn(`Rail fallback: graph size ${coords.size} (cap ${MAX_NODES})`);
        cache.set(key, null);
        return null;
      }
      const startId = nearestNode(coords, from.lat, from.lng);
      const goalId = nearestNode(coords, to.lat, to.lng);
      const snapA = startId != null ? haversine(from.lat, from.lng, coords.get(startId)[0], coords.get(startId)[1]) : -1;
      const snapB = goalId != null ? haversine(to.lat, to.lng, coords.get(goalId)[0], coords.get(goalId)[1]) : -1;
      D && D.info(`Rail snap: start ${snapA.toFixed(1)}km, goal ${snapB.toFixed(1)}km from endpoints`);
      const railPath = startId != null && goalId != null ? dijkstra(adj, coords, startId, goalId) : null;
      if (!railPath || railPath.length < 2) {
        D && D.warn('Rail fallback: no connected path between snapped nodes (disconnected graph)');
        cache.set(key, null);
        return null;
      }
      const result = [[from.lat, from.lng], ...railPath, [to.lat, to.lng]];
      D && D.info(`Rail OK: ${railPath.length} points along track`);
      cache.set(key, result);
      return result;
    } catch (e) {
      D && D.error('Rail routing error: ' + e.message);
      cache.set(key, null);
      return null;
    }
  }

  window.RailRouter = { route, resolveStation, clearCache: () => cache.clear() };
})();
