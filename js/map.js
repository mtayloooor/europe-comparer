/**
 * map.js
 * Map abstraction layer. Exposes window.MapController with a provider-agnostic
 * API so the Leaflet/OpenStreetMap fallback can be swapped for Apple MapKit JS
 * without touching the rest of the app.
 *
 * Common API:
 *   MapController.create(elementId, config) -> controller
 *   controller.render({ origin, destination, stops, dayTrips })
 *
 * Where points are { name, lat, lng, color? }.
 *
 * ── Swapping to Apple MapKit JS ────────────────────────────────────────
 * 1. Add to index.html:
 *      <script src="https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js"></script>
 * 2. Provide a MapKit JWT token in config.mapkitToken (or window.MAPKIT_TOKEN).
 * 3. The MapKitAdapter below mirrors the Leaflet adapter: markers become
 *    mapkit.MarkerAnnotation, the route polyline becomes a
 *    mapkit.PolylineOverlay, and day-trip branches are dashed PolylineOverlays.
 * The app calls the same .render() shape for both, so no app changes needed.
 * ───────────────────────────────────────────────────────────────────────
 */
(function () {
  const EUROPE_CENTER = [48.0, 9.0];

  // ── Leaflet / OpenStreetMap adapter (default fallback) ────────────────
  function LeafletAdapter(elementId) {
    const map = L.map(elementId, { zoomControl: true }).setView(EUROPE_CENTER, 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);

    let layers = [];

    // Flex/responsive containers can mis-measure on first paint.
    setTimeout(() => map.invalidateSize(), 200);
    window.addEventListener('resize', () => map.invalidateSize());

    function clear() {
      layers.forEach((l) => map.removeLayer(l));
      layers = [];
    }

    function pin(color, label) {
      return L.divIcon({
        className: '',
        html: `<div style="background:${color};width:22px;height:22px;border-radius:50% 50% 50% 0;
               transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);
               display:flex;align-items:center;justify-content:center;">
               <span style="transform:rotate(45deg);color:#fff;font-size:11px;font-weight:700;">${label}</span></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 22],
      });
    }

    function addMarker(p, color, label) {
      if (p.lat == null || p.lng == null) return null;
      const m = L.marker([p.lat, p.lng], { icon: pin(color, label) })
        .addTo(map)
        .bindTooltip(p.name || 'Unnamed', { direction: 'top', offset: [0, -18] });
      layers.push(m);
      return [p.lat, p.lng];
    }

    function render({ origin, destination, stops, dayTrips }) {
      clear();
      const routePts = [];

      const o = addMarker(origin, '#1e293b', 'A');
      if (o) routePts.push(o);

      stops.forEach((s, i) => {
        const pt = addMarker(s, s.color || '#6366f1', String(i + 1));
        if (pt) routePts.push(pt);
      });

      const d = addMarker(destination, '#1e293b', 'B');
      if (d) routePts.push(d);

      // Main route line.
      if (routePts.length >= 2) {
        const line = L.polyline(routePts, { color: '#4f46e5', weight: 4, opacity: 0.85 }).addTo(map);
        layers.push(line);
        map.fitBounds(line.getBounds().pad(0.25));
      } else if (routePts.length === 1) {
        map.setView(routePts[0], 5);
      }

      // Day-trip branches (secondary markers + dashed line to parent).
      (dayTrips || []).forEach((dt) => {
        const parentPt = addMarker(dt, '#10b981', '◆');
        if (parentPt && dt.parentLat != null && dt.parentLng != null) {
          const branch = L.polyline(
            [[dt.parentLat, dt.parentLng], [dt.lat, dt.lng]],
            { color: '#10b981', weight: 2, dashArray: '5,6', opacity: 0.8 }
          ).addTo(map);
          layers.push(branch);
        }
      });
    }

    return { render, _impl: 'leaflet' };
  }

  // ── Apple MapKit JS adapter (stub — wire up when token is available) ───
  function MapKitAdapter(elementId, config) {
    if (typeof mapkit === 'undefined') throw new Error('MapKit JS not loaded');
    mapkit.init({
      authorizationCallback: (done) => done(config.mapkitToken || window.MAPKIT_TOKEN),
    });
    const map = new mapkit.Map(elementId);
    let annotations = [];
    let overlays = [];

    function clear() {
      if (annotations.length) map.removeAnnotations(annotations);
      if (overlays.length) map.removeOverlays(overlays);
      annotations = [];
      overlays = [];
    }

    function coord(p) {
      return new mapkit.Coordinate(p.lat, p.lng);
    }

    function render({ origin, destination, stops, dayTrips }) {
      clear();
      const seq = [origin, ...stops, destination].filter((p) => p && p.lat != null);
      seq.forEach((p, i) => {
        const a = new mapkit.MarkerAnnotation(coord(p), {
          title: p.name,
          glyphText: i === 0 ? 'A' : i === seq.length - 1 ? 'B' : String(i),
        });
        annotations.push(a);
      });
      map.addAnnotations(annotations);

      if (seq.length >= 2) {
        const line = new mapkit.PolylineOverlay(seq.map(coord), {
          style: new mapkit.Style({ lineWidth: 4, strokeColor: '#4f46e5' }),
        });
        overlays.push(line);
      }
      (dayTrips || []).forEach((dt) => {
        if (dt.lat == null || dt.parentLat == null) return;
        const branch = new mapkit.PolylineOverlay(
          [coord(dt), new mapkit.Coordinate(dt.parentLat, dt.parentLng)],
          { style: new mapkit.Style({ lineWidth: 2, strokeColor: '#10b981', lineDash: [4, 4] }) }
        );
        overlays.push(branch);
        annotations.push(new mapkit.MarkerAnnotation(coord(dt), { title: dt.name, color: '#10b981' }));
      });
      if (overlays.length) map.addOverlays(overlays);
      map.addAnnotations(annotations);
      if (seq.length) map.showItems(annotations);
    }

    return { render, _impl: 'mapkit' };
  }

  function create(elementId, config = {}) {
    const wantMapKit =
      config.provider === 'mapkit' && (config.mapkitToken || window.MAPKIT_TOKEN);
    if (wantMapKit) {
      try {
        return MapKitAdapter(elementId, config);
      } catch (e) {
        console.warn('MapKit unavailable, falling back to Leaflet:', e);
      }
    }
    return LeafletAdapter(elementId);
  }

  window.MapController = { create };
})();
