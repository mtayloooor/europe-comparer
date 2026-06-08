/**
 * geocode.js
 * Place search / geocoding. Exposed globally as window.GeoSearch.
 *
 *   GeoSearch.search(query) -> Promise<Array<{ name, label, detail, lat, lng, type }>>
 *
 * Primary provider is Photon (https://photon.komoot.io) — a free,
 * CORS-enabled, autocomplete-friendly geocoder built on OpenStreetMap data
 * (no API key required). If it's unreachable, we fall back to substring
 * matches against the built-in city gazetteer (cities.js) so the field still
 * works offline for well-known cities.
 *
 * Swap note: when Apple Maps is the active provider you could route this
 * through `mapkit.Search` instead; the return shape above is all the UI needs.
 */
(function () {
  const PHOTON = 'https://photon.komoot.io/api/';

  function fromPhoton(feature, query) {
    const [lng, lat] = feature.geometry.coordinates;
    const p = feature.properties || {};
    const name = p.name || p.city || p.street || query;
    // Build a disambiguating subtitle, skipping the part already used as name.
    const detail = [
      p.city && p.city !== name ? p.city : null,
      p.state,
      p.country,
    ]
      .filter(Boolean)
      .join(', ');
    return { name, label: name, detail, lat, lng, type: p.osm_value || p.type || '' };
  }

  function fromGazetteer(query) {
    const ql = query.toLowerCase();
    const CITIES = window.CITIES;
    return Object.keys(CITIES)
      .filter((k) => k !== 'lookup' && k.toLowerCase().includes(ql))
      .slice(0, 6)
      .map((k) => ({ name: k, label: k, detail: 'offline match', lat: CITIES[k].lat, lng: CITIES[k].lng, type: 'city' }));
  }

  async function search(query) {
    const q = (query || '').trim();
    if (q.length < 2) return [];
    try {
      const res = await fetch(`${PHOTON}?q=${encodeURIComponent(q)}&limit=6`);
      if (res.ok) {
        const data = await res.json();
        const out = (data.features || []).map((f) => fromPhoton(f, q));
        if (out.length) return out;
      }
    } catch (e) {
      console.warn('Geocoder unavailable, using offline gazetteer:', e.message);
    }
    return fromGazetteer(q);
  }

  window.GeoSearch = { search };
})();
