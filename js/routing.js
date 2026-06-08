/**
 * routing.js
 * Resolves the polyline geometry for a single leg based on its travel method.
 * Exposed globally as window.RouteService.
 *
 *   flight / ferry → straight line (great-circle-ish; rendered dashed)
 *   car / bus      → real driving route via OSRM (public OpenStreetMap router)
 *   train          → approximate rail path snapped to OSM track geometry
 *                    (see rail.js); straight-line fallback if unavailable
 *
 * ── Real transit (Train / public transport) ────────────────────────────
 * Free routing APIs don't expose true rail/PT geometry, and Apple MapKit JS
 * has no transit directions (Automobile/Walking only). Google Maps CAN return
 * transit polylines (Directions API / Routes API `mode=transit`, or the Maps
 * JS `DirectionsService` with `travelMode: TRANSIT`), but:
 *   • requires an API key with billing enabled,
 *   • the REST Directions API is server-side only (browser CORS) → needs a proxy,
 *   • Google ToS requires Google-derived geometry to be shown on a Google map.
 *
 * To slot one in later, assign an async function to RouteService.transitProvider:
 *     RouteService.transitProvider = async (from, to) => ([[lat,lng], ...]);
 * It will be used for `train`/`bus` legs when present.
 * ───────────────────────────────────────────────────────────────────────
 */
(function () {
  const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';

  const STRAIGHT_METHODS = new Set(['flight', 'ferry', 'train']);
  const DRIVING_METHODS = new Set(['car', 'bus']);

  const cache = new Map();

  function straight(from, to) {
    return [
      [from.lat, from.lng],
      [to.lat, to.lng],
    ];
  }

  async function drivingRoute(from, to) {
    const url =
      `${OSRM_BASE}/${from.lng},${from.lat};${to.lng},${to.lat}` +
      '?overview=full&geometries=geojson';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const data = await res.json();
    const coords = data.routes?.[0]?.geometry?.coordinates;
    if (!coords || !coords.length) throw new Error('No route geometry');
    return coords.map(([lng, lat]) => [lat, lng]); // GeoJSON is [lng,lat]
  }

  /**
   * @returns {Promise<{coords:number[][], approximate:boolean}>}
   * `approximate` is true when we fell back to a straight line (e.g. network
   * failure, or a method without true geometry).
   */
  async function getLeg(from, to, method) {
    if (
      !from || !to ||
      from.lat == null || from.lng == null ||
      to.lat == null || to.lng == null
    ) {
      return { coords: [], approximate: true };
    }

    const key = `${method}:${from.lat},${from.lng}->${to.lat},${to.lng}`;
    if (cache.has(key)) return cache.get(key);

    let result;
    try {
      if (RouteService.transitProvider && (method === 'train' || method === 'bus')) {
        const coords = await RouteService.transitProvider(from, to, method);
        result = { coords, approximate: false };
      } else if (method === 'train' && window.RailRouter) {
        // Resolve the best station for each city, then snap the rail path
        // station-to-station along OpenStreetMap track geometry.
        const [fromStation, toStation] = await Promise.all([
          window.RailRouter.resolveStation(from),
          window.RailRouter.resolveStation(to),
        ]);
        const a = fromStation || from;
        const b = toStation || to;
        const rail = await window.RailRouter.route(a, b);
        const stations = {
          fromStation: fromStation ? fromStation.name : null,
          toStation: toStation ? toStation.name : null,
        };
        result = rail
          ? { coords: [[from.lat, from.lng], ...rail, [to.lat, to.lng]], approximate: false, ...stations }
          : { coords: straight(from, to), approximate: true, ...stations };
      } else if (DRIVING_METHODS.has(method)) {
        result = { coords: await drivingRoute(from, to), approximate: false };
      } else if (STRAIGHT_METHODS.has(method)) {
        result = { coords: straight(from, to), approximate: method !== 'flight' && method !== 'ferry' };
      } else {
        result = { coords: straight(from, to), approximate: true };
      }
    } catch (e) {
      const D = window.DebugLog;
      D && D.error(`Route lookup failed (${method}), using straight line: ${e.message}`);
      result = { coords: straight(from, to), approximate: true };
    }

    cache.set(key, result);
    const D = window.DebugLog;
    D && D.info(
      `Leg ${method}: ${result.coords.length} pts, ` +
      (result.approximate ? 'straight/approx' : 'routed')
    );
    return result;
  }

  const RouteService = {
    transitProvider: null,
    getLeg,
    clearCache: () => cache.clear(),
  };

  window.RouteService = RouteService;
})();
