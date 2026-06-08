/**
 * map.js
 * Map abstraction layer. Exposes window.MapController with a provider-agnostic
 * API so the Leaflet/OpenStreetMap fallback and Apple MapKit JS share one
 * interface. Routing geometry is computed upstream (routing.js); the adapters
 * here only *draw* what they're given.
 *
 * Common API:
 *   MapController.create(elementId, config) -> controller
 *   controller.render({ markers, legs, dayTrips })
 *   controller.destroy()
 *   controller._impl  // 'leaflet' | 'mapkit'
 *
 *   markers : [{ lat, lng, label, color, name }]            // in route order
 *   legs    : [{ coords:[[lat,lng],...], color, dashed }]   // one per segment
 *   dayTrips: [{ lat, lng, name, parentLat, parentLng }]
 *
 * Apple MapKit JS requires a signed JWT (config.mapkitToken / window.MAPKIT_TOKEN).
 * ───────────────────────────────────────────────────────────────────────
 */
(function () {
  const EUROPE_CENTER = [48.0, 9.0];

  function allPoints(markers, legs, dayTrips) {
    const pts = [];
    markers.forEach((m) => m.lat != null && pts.push([m.lat, m.lng]));
    legs.forEach((l) => l.coords.forEach((c) => pts.push(c)));
    dayTrips.forEach((d) => d.lat != null && pts.push([d.lat, d.lng]));
    return pts;
  }

  // A signature of the plotted *places* (markers + day trips), order-independent.
  // Used to decide when to (re)frame the map — so changing travel methods or
  // reordering destinations (which don't change the set of places) leaves the
  // user's current zoom/pan untouched.
  function placesKey(markers, dayTrips) {
    const pts = [];
    markers.forEach((m) => m.lat != null && pts.push(m.lat.toFixed(3) + ',' + m.lng.toFixed(3)));
    dayTrips.forEach((d) => d.lat != null && pts.push(d.lat.toFixed(3) + ',' + d.lng.toFixed(3)));
    return pts.sort().join('|');
  }

  // ── Leaflet / OpenStreetMap adapter (default fallback) ────────────────
  function LeafletAdapter(elementId) {
    const map = L.map(elementId, { zoomControl: true }).setView(EUROPE_CENTER, 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18,
    }).addTo(map);

    let layers = [];
    let lastFitKey = null;
    const onResize = () => map.invalidateSize();
    setTimeout(onResize, 200);
    window.addEventListener('resize', onResize);

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

    const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

    // A fading multi-segment trail from `far` (transparent) to `city` (opaque),
    // plus a small arrowhead at t.arrow.at rotated to t.arrow.deg.
    function drawTrail(t) {
      const steps = 9;
      for (let i = 0; i < steps; i += 1) {
        const op = 0.06 + 0.5 * ((i + 1) / steps); // fades in toward the city
        const seg = L.polyline([lerp(t.far, t.city, i / steps), lerp(t.far, t.city, (i + 1) / steps)], {
          color: t.color,
          weight: 3,
          opacity: op,
          interactive: false,
        }).addTo(map);
        layers.push(seg);
      }
      const arrow = L.marker(t.arrow.at, {
        interactive: false,
        icon: L.divIcon({
          className: '',
          html: `<div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;
                 border-bottom:9px solid ${t.color};transform:rotate(${t.arrow.deg}deg);"></div>`,
          iconSize: [10, 10],
          iconAnchor: [5, 5],
        }),
      }).addTo(map);
      layers.push(arrow);
    }

    function render({ markers, legs, dayTrips, trails, onLegHover }) {
      clear();

      // Fading arrival/departure trails (drawn under everything else).
      (trails || []).forEach((t) => drawTrail(t));

      legs.forEach((leg) => {
        if (leg.coords.length < 2) return;
        // Visible line is purely cosmetic; a wide transparent hit-line handles
        // hover. `.leg-hit` forces pointer-events on the stroke even though it's
        // transparent (SVG default `visiblePainted` would otherwise ignore it).
        const line = L.polyline(leg.coords, {
          color: leg.color,
          weight: 4,
          opacity: 0.85,
          dashArray: leg.dashed ? '8,8' : null,
          interactive: false,
        }).addTo(map);
        layers.push(line);

        const hit = L.polyline(leg.coords, { color: '#000', weight: 18, opacity: 0, className: 'leg-hit' }).addTo(map);
        if (leg.tooltip) hit.bindTooltip(leg.tooltip, { sticky: true, direction: 'top', opacity: 0.95 });
        if (onLegHover && leg.key) {
          hit.on('mouseover', () => onLegHover(leg.key));
          hit.on('mouseout', () => onLegHover(null));
        }
        layers.push(hit);
      });

      markers.forEach((m) => {
        if (m.lat == null) return;
        const mk = L.marker([m.lat, m.lng], { icon: pin(m.color, m.label) })
          .addTo(map)
          .bindTooltip(m.name || 'Unnamed', { direction: 'top', offset: [0, -18] });
        layers.push(mk);
      });

      dayTrips.forEach((dt) => {
        if (dt.lat == null) return;
        const mk = L.marker([dt.lat, dt.lng], { icon: pin('#10b981', '◆') })
          .addTo(map)
          .bindTooltip(`${dt.name || 'Day trip'} (day trip)`, { direction: 'top', offset: [0, -18] });
        layers.push(mk);
        if (dt.parentLat != null) {
          const branch = L.polyline([[dt.parentLat, dt.parentLng], [dt.lat, dt.lng]], {
            color: '#10b981',
            weight: 2,
            dashArray: '5,6',
            opacity: 0.8,
          }).addTo(map);
          layers.push(branch);
        }
      });

      // Only (re)frame when the set of places changes — preserve the user's
      // zoom/pan when they're just changing travel methods or reordering.
      const key = placesKey(markers, dayTrips);
      if (key !== lastFitKey) {
        const pts = allPoints(markers, legs, dayTrips);
        if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts).pad(0.25));
        else if (pts.length === 1) map.setView(pts[0], 5);
        lastFitKey = key;
      }
    }

    function destroy() {
      window.removeEventListener('resize', onResize);
      map.remove();
    }

    return { render, destroy, _impl: 'leaflet' };
  }

  // ── Apple MapKit JS adapter ───────────────────────────────────────────
  function MapKitAdapter(elementId, config) {
    if (typeof mapkit === 'undefined') throw new Error('MapKit JS not loaded');
    const token = config.mapkitToken || window.MAPKIT_TOKEN;
    if (!token) throw new Error('No MapKit token provided');

    // Keep the latest token in a shared slot so the (one-time) auth callback
    // always hands MapKit the most recently entered token.
    window.__MAPKIT_TOKEN = token;
    if (!mapkit.__inited) {
      mapkit.init({ authorizationCallback: (done) => done(window.__MAPKIT_TOKEN) });
      mapkit.__inited = true;
    }
    const map = new mapkit.Map(elementId);
    let annotations = [];
    let overlays = [];
    let lastFitKey = null;

    // MapKit overlays don't emit hover events, so we hit-test manually: project
    // each leg's (downsampled) coordinates to screen points on mousemove and
    // find the nearest line, then show a custom tooltip + report the hover.
    const el = document.getElementById(elementId);
    let hoverLegs = []; // [{ key, tooltip, pts:[[lat,lng]...] }]
    let hoverCb = null;
    const tip = document.createElement('div');
    tip.className = 'mapkit-leg-tip';
    tip.style.cssText =
      'position:fixed;z-index:1200;pointer-events:none;display:none;background:#fff;' +
      'border:1px solid #cbd5e1;border-radius:6px;padding:4px 8px;font-size:12px;' +
      'box-shadow:0 1px 6px rgba(0,0,0,.2);max-width:240px;color:#1e293b;';
    document.body.appendChild(tip);

    function distToSeg(px, py, ax, ay, bx, by) {
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx;
      const cy = ay + t * dy;
      return Math.hypot(px - cx, py - cy);
    }
    function hitTest(e) {
      let best = null;
      let bestD = Infinity;
      for (const leg of hoverLegs) {
        let prev = null;
        for (const c of leg.pts) {
          let pt = null;
          try {
            pt = map.convertCoordinateToPointOnPage(new mapkit.Coordinate(c[0], c[1]));
          } catch (err) { pt = null; }
          if (pt && prev) {
            const d = distToSeg(e.pageX, e.pageY, prev.x, prev.y, pt.x, pt.y);
            if (d < bestD) { bestD = d; best = leg; }
          }
          prev = pt;
        }
      }
      if (best && bestD <= 12) {
        tip.innerHTML = best.tooltip || '';
        tip.style.left = e.clientX + 12 + 'px';
        tip.style.top = e.clientY + 12 + 'px';
        tip.style.display = 'block';
        if (hoverCb) hoverCb(best.key);
      } else {
        tip.style.display = 'none';
        if (hoverCb) hoverCb(null);
      }
    }
    let hoverPending = false;
    let lastMove = null;
    const onMove = (e) => {
      lastMove = e;
      if (hoverPending) return;
      hoverPending = true;
      requestAnimationFrame(() => { hoverPending = false; if (lastMove) hitTest(lastMove); });
    };
    const onLeave = () => { tip.style.display = 'none'; if (hoverCb) hoverCb(null); };
    if (el) {
      el.addEventListener('mousemove', onMove);
      el.addEventListener('mouseleave', onLeave);
    }
    // Downsample a coord list to at most `max` points (keeps hit-testing cheap).
    function downsample(coords, max) {
      if (coords.length <= max) return coords;
      const step = Math.ceil(coords.length / max);
      const out = [];
      for (let i = 0; i < coords.length; i += step) out.push(coords[i]);
      if (out[out.length - 1] !== coords[coords.length - 1]) out.push(coords[coords.length - 1]);
      return out;
    }

    function clear() {
      if (annotations.length) map.removeAnnotations(annotations);
      if (overlays.length) map.removeOverlays(overlays);
      annotations = [];
      overlays = [];
    }

    const coord = (lat, lng) => new mapkit.Coordinate(lat, lng);

    const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

    function render({ markers, legs, dayTrips, trails, onLegHover }) {
      clear();
      hoverCb = onLegHover || null;
      hoverLegs = legs
        .filter((l) => l.coords.length >= 2 && l.key)
        .map((l) => ({ key: l.key, tooltip: l.tooltip, pts: downsample(l.coords, 40) }));

      // Fading arrival/departure trails.
      (trails || []).forEach((t) => {
        const steps = 9;
        for (let i = 0; i < steps; i += 1) {
          const op = 0.06 + 0.5 * ((i + 1) / steps);
          overlays.push(
            new mapkit.PolylineOverlay(
              [lerp(t.far, t.city, i / steps), lerp(t.far, t.city, (i + 1) / steps)].map(([la, ln]) => coord(la, ln)),
              { style: new mapkit.Style({ lineWidth: 3, strokeColor: t.color, strokeOpacity: op }) }
            )
          );
        }
      });

      legs.forEach((leg) => {
        if (leg.coords.length < 2) return;
        const style = new mapkit.Style({
          lineWidth: 4,
          strokeColor: leg.color,
          lineDash: leg.dashed ? [8, 8] : [],
        });
        overlays.push(new mapkit.PolylineOverlay(leg.coords.map(([la, ln]) => coord(la, ln)), { style }));
      });

      markers.forEach((m) => {
        if (m.lat == null) return;
        annotations.push(
          new mapkit.MarkerAnnotation(coord(m.lat, m.lng), {
            title: m.name,
            glyphText: m.label,
            color: m.color,
          })
        );
      });

      dayTrips.forEach((dt) => {
        if (dt.lat == null) return;
        annotations.push(
          new mapkit.MarkerAnnotation(coord(dt.lat, dt.lng), { title: dt.name, color: '#10b981' })
        );
        if (dt.parentLat != null) {
          overlays.push(
            new mapkit.PolylineOverlay(
              [coord(dt.lat, dt.lng), coord(dt.parentLat, dt.parentLng)],
              { style: new mapkit.Style({ lineWidth: 2, strokeColor: '#10b981', lineDash: [4, 4] }) }
            )
          );
        }
      });

      if (overlays.length) map.addOverlays(overlays);
      if (annotations.length) {
        map.addAnnotations(annotations);
        // Only reframe when the set of places changes (not on method/order edits).
        const key = placesKey(markers, dayTrips);
        if (key !== lastFitKey) {
          map.showItems(annotations);
          lastFitKey = key;
        }
      }
    }

    function destroy() {
      if (el) {
        el.removeEventListener('mousemove', onMove);
        el.removeEventListener('mouseleave', onLeave);
      }
      if (tip.parentNode) tip.parentNode.removeChild(tip);
      try {
        map.destroy();
      } catch (e) {
        /* noop */
      }
    }

    return { render, destroy, _impl: 'mapkit' };
  }

  function create(elementId, config = {}) {
    if (config.provider === 'mapkit') {
      try {
        return MapKitAdapter(elementId, config);
      } catch (e) {
        console.warn('MapKit unavailable, falling back to Leaflet:', e.message);
        if (typeof config.onMapKitError === 'function') config.onMapKitError(e);
      }
    }
    return LeafletAdapter(elementId);
  }

  window.MapController = { create };
})();
